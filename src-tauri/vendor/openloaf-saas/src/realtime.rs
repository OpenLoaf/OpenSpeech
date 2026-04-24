//! Realtime tool WebSocket client.
//!
//! 对标服务端 `/api/ai/v3/tools/stream`。协议简述：
//! 1. 客户端用 `?feature=&token=` 打开 WebSocket
//! 2. 首帧发送 `{"type":"start", params, inputs}`
//! 3. 服务端回 `{"type":"ready", sessionId, startedAt}`
//! 4. 客户端发送二进制 PCM16 音频帧
//! 5. 服务端推 `partial` / `final` / `credits` 事件
//! 6. 客户端发 `{"type":"finish"}` 或直接关闭
//! 7. 服务端回 `{"type":"closed", ...}` 后关闭
//!
//! WebSocket 逻辑完全在 wrapper 层（tungstenite），不走 FFI：协议本身
//! 在服务端源码中公开，没有需要隐藏的业务实现。

use std::io::ErrorKind as IoErrorKind;
use std::sync::Arc;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use url::Url;

use crate::{ClientInner, SaaSError, SaaSResult};

/// 非阻塞读时的轮询间隔。5ms 在延迟与 CPU 占用之间折中。
const READ_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// Events pushed by the server during a realtime session.
///
/// 对标服务端 `ServerToClientMessage` 联合类型。未知 `type` 会触发 `SaaSError::Decode`，
/// 如需兼容性前向传递，可包一层 `serde_json::Value`（目前坚持强类型）。
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum RealtimeEvent {
    #[serde(rename_all = "camelCase")]
    Ready {
        session_id: String,
        started_at: i64,
    },
    #[serde(rename_all = "camelCase")]
    Partial {
        sentence_id: i64,
        text: String,
    },
    #[serde(rename_all = "camelCase")]
    Final {
        sentence_id: i64,
        text: String,
        #[serde(default)]
        begin_ms: Option<i64>,
        #[serde(default)]
        end_ms: Option<i64>,
    },
    #[serde(rename_all = "camelCase")]
    Credits {
        consumed_seconds: f64,
        consumed_credits: f64,
        remaining_credits: f64,
        #[serde(default)]
        warning: Option<String>,
    },
    Error {
        code: String,
        message: String,
    },
    #[serde(rename_all = "camelCase")]
    Closed {
        reason: String,
        total_seconds: f64,
        total_credits: f64,
    },
}

impl RealtimeEvent {
    /// `Closed` / `Error` 标志会话终止，消费方收到后应停止发送。
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            RealtimeEvent::Closed { .. } | RealtimeEvent::Error { .. }
        )
    }
}

/// 工作线程的出队消息。
enum Outbound {
    Text(String),
    Binary(Vec<u8>),
    Close,
}

/// 通过 `SaaSClient::realtime()` 获取的实时工具入口。
pub struct RealtimeClient {
    pub(crate) inner: Arc<ClientInner>,
}

impl RealtimeClient {
    /// 打开一条 realtime 会话。调用前需要通过 `set_access_token` 注入有效 token。
    pub fn connect(&self, feature: &str) -> SaaSResult<RealtimeSession> {
        let token = self
            .inner
            .access_token
            .read()
            .ok()
            .and_then(|g| g.clone())
            .ok_or_else(|| SaaSError::Input("missing access token".into()))?;

        let url = build_ws_url(&self.inner.base_url, feature, &token)?;

        // 关键逻辑：tungstenite 0.24 要求 Request 上标记 Host/Origin 等头，
        // IntoClientRequest for &str 会自动补齐。
        let request = url
            .as_str()
            .into_client_request()
            .map_err(|e| SaaSError::Input(format!("invalid url: {e}")))?;

        let (mut ws, _response) =
            tungstenite::connect(request).map_err(|e| SaaSError::Network(e.to_string()))?;

        // 关键逻辑：把底层 TcpStream 切到 nonblocking，这样 worker 线程的 read() 能及时让出 CPU
        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => s
                .set_nonblocking(true)
                .map_err(|e| SaaSError::Network(e.to_string()))?,
            MaybeTlsStream::Rustls(s) => s
                .get_mut()
                .set_nonblocking(true)
                .map_err(|e| SaaSError::Network(e.to_string()))?,
            _ => {}
        }

        let (outbox_tx, outbox_rx) = mpsc::channel::<Outbound>();
        let (inbox_tx, inbox_rx) = mpsc::channel::<SaaSResult<RealtimeEvent>>();

        let worker = spawn_worker(ws, outbox_rx, inbox_tx);

        Ok(RealtimeSession {
            outbox: outbox_tx,
            inbox: inbox_rx,
            worker: Some(worker),
        })
    }
}

/// 单次 realtime 会话句柄。`send_*` 与 `recv_*` 可在不同线程并发调用。
pub struct RealtimeSession {
    outbox: Sender<Outbound>,
    inbox: Receiver<SaaSResult<RealtimeEvent>>,
    worker: Option<JoinHandle<()>>,
}

impl RealtimeSession {
    /// 发送 `start` 控制帧，会话协议要求它是第一帧。
    pub fn send_start<P, I>(&self, params: Option<P>, inputs: Option<I>) -> SaaSResult<()>
    where
        P: Serialize,
        I: Serialize,
    {
        let params_val = match params {
            Some(p) => serde_json::to_value(&p)?,
            None => serde_json::json!({}),
        };
        let inputs_val = match inputs {
            Some(i) => serde_json::to_value(&i)?,
            None => serde_json::json!({}),
        };
        let msg = serde_json::json!({
            "type": "start",
            "params": params_val,
            "inputs": inputs_val,
        });
        self.send_text(serde_json::to_string(&msg)?)
    }

    /// 发送一帧 PCM16 音频。注意：调用方需自行按 feature 要求切片（一般 20~40ms）。
    pub fn send_audio<B: Into<Vec<u8>>>(&self, frame: B) -> SaaSResult<()> {
        self.outbox
            .send(Outbound::Binary(frame.into()))
            .map_err(|_| SaaSError::Network("session closed".into()))
    }

    /// 发送 `finish` 控制帧，通知服务端 drain upstream 并下发最终结果。
    pub fn send_finish(&self) -> SaaSResult<()> {
        self.send_text(
            serde_json::to_string(&serde_json::json!({ "type": "finish" }))?,
        )
    }

    fn send_text(&self, text: String) -> SaaSResult<()> {
        self.outbox
            .send(Outbound::Text(text))
            .map_err(|_| SaaSError::Network("session closed".into()))
    }

    /// 阻塞等待下一条事件。worker 异常退出或会话结束时返回 `SaaSError::Network`。
    pub fn recv_event(&self) -> SaaSResult<RealtimeEvent> {
        self.inbox
            .recv()
            .map_err(|_| SaaSError::Network("session disconnected".into()))
            .and_then(|r| r)
    }

    /// 等待下一条事件，最多 `duration`。超时返回 `Ok(None)`。
    pub fn recv_event_timeout(&self, duration: Duration) -> SaaSResult<Option<RealtimeEvent>> {
        match self.inbox.recv_timeout(duration) {
            Ok(r) => r.map(Some),
            Err(RecvTimeoutError::Timeout) => Ok(None),
            Err(RecvTimeoutError::Disconnected) => {
                Err(SaaSError::Network("session disconnected".into()))
            }
        }
    }

    /// 无等待地尝试取一条事件。没有时返回 `Ok(None)`。
    pub fn try_recv_event(&self) -> SaaSResult<Option<RealtimeEvent>> {
        match self.inbox.try_recv() {
            Ok(r) => r.map(Some),
            Err(mpsc::TryRecvError::Empty) => Ok(None),
            Err(mpsc::TryRecvError::Disconnected) => {
                Err(SaaSError::Network("session disconnected".into()))
            }
        }
    }

    /// 主动关闭会话。会给服务端发送 Close 帧并等待 worker 退出。
    pub fn close(mut self) -> SaaSResult<()> {
        let _ = self.outbox.send(Outbound::Close);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
        Ok(())
    }
}

impl Drop for RealtimeSession {
    fn drop(&mut self) {
        // 保险丝：session 丢失时自动通知 worker 退出
        let _ = self.outbox.send(Outbound::Close);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

/// 由 base_url (http/https) 构造 `wss://host/api/ai/v3/tools/stream?feature=&token=`。
fn build_ws_url(base_url: &str, feature: &str, token: &str) -> SaaSResult<Url> {
    let mut base =
        Url::parse(base_url).map_err(|e| SaaSError::Input(format!("invalid base_url: {e}")))?;
    let new_scheme = match base.scheme() {
        "http" | "ws" => "ws",
        "https" | "wss" => "wss",
        other => {
            return Err(SaaSError::Input(format!("unsupported scheme: {other}")));
        }
    };
    base.set_scheme(new_scheme)
        .map_err(|_| SaaSError::Input("scheme change failed".into()))?;
    base.set_path("/api/ai/v3/tools/stream");
    base.query_pairs_mut()
        .clear()
        .append_pair("feature", feature)
        .append_pair("token", token);
    Ok(base)
}

fn spawn_worker(
    mut ws: tungstenite::WebSocket<MaybeTlsStream<std::net::TcpStream>>,
    outbox: Receiver<Outbound>,
    inbox: Sender<SaaSResult<RealtimeEvent>>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        'outer: loop {
            // 1) 先吸掉本轮所有排队中的出站帧
            loop {
                match outbox.try_recv() {
                    Ok(Outbound::Text(s)) => {
                        if let Err(e) = ws.send(Message::Text(s))
                            && !is_would_block(&e)
                        {
                            let _ = inbox.send(Err(SaaSError::Network(e.to_string())));
                            break 'outer;
                        }
                    }
                    Ok(Outbound::Binary(b)) => {
                        if let Err(e) = ws.send(Message::Binary(b))
                            && !is_would_block(&e)
                        {
                            let _ = inbox.send(Err(SaaSError::Network(e.to_string())));
                            break 'outer;
                        }
                    }
                    Ok(Outbound::Close) => {
                        let _ = ws.close(None);
                        let _ = ws.flush();
                        break 'outer;
                    }
                    Err(mpsc::TryRecvError::Empty) => break,
                    Err(mpsc::TryRecvError::Disconnected) => {
                        // session 侧已经析构，主动关闭
                        let _ = ws.close(None);
                        break 'outer;
                    }
                }
            }

            // 2) 再非阻塞地尝试读一条服务端消息
            match ws.read() {
                Ok(Message::Text(data)) => match serde_json::from_str::<RealtimeEvent>(&data) {
                    Ok(evt) => {
                        let terminal = evt.is_terminal();
                        if inbox.send(Ok(evt)).is_err() {
                            break 'outer;
                        }
                        if terminal {
                            // 服务端下发 closed/error 后立即退出 worker
                            break 'outer;
                        }
                    }
                    Err(e) => {
                        let _ = inbox.send(Err(SaaSError::Decode(e.to_string())));
                    }
                },
                Ok(Message::Close(_)) => {
                    break 'outer;
                }
                Ok(_) => {
                    // Binary / Ping / Pong —— tungstenite 会自动回 Pong，这里忽略
                }
                Err(e) if is_would_block(&e) => {
                    thread::sleep(READ_POLL_INTERVAL);
                }
                Err(e) => {
                    let _ = inbox.send(Err(SaaSError::Network(e.to_string())));
                    break 'outer;
                }
            }
        }
    })
}

fn is_would_block(err: &tungstenite::Error) -> bool {
    matches!(err, tungstenite::Error::Io(e) if e.kind() == IoErrorKind::WouldBlock)
}
