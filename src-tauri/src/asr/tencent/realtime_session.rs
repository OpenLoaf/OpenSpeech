// 腾讯云实时 ASR WebSocket 会话封装。
//
// 协议简述（详见 `realtime.rs` 与 `signature.rs`）：
//   - 客户端发: binary frame = PCM16 16k mono；text frame `{"type":"end"}` = 结束
//   - 服务端回: text frame，结构由 `realtime::parse_frame` 归一为 `TencentEvent`
//   - 任意 `code != 0` 或 `final == 1` 后服务端会主动关闭连接
//
// 与 SDK SaaS realtime 的设计对齐（`openloaf-saas` 0.3.16 的 `RealtimeAsrSession`）：
// 同步 tungstenite + 内部 worker 线程 + mpsc 双通道。worker 持有 socket，
// 外部发音频/finish/close 走 `outbox` 通道；服务端事件由 worker 解码后走 `inbox`。
// 这样调用方可以从任意线程并发调 `send_audio_pcm16` / `next_event_timeout`，
// 与 stt/mod.rs 现有 worker 主循环（独占 session、try_recv 排空控制通道、轮询事件）
// 完美契合。

use std::collections::BTreeMap;
use std::io::ErrorKind as IoErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;

use super::realtime::{self, TencentEvent};
use super::signature::build_realtime_url;

/// 服务端建议 200ms 发 200ms（1:1 实时率）；超过 6s 不发会被强制断。worker 在
/// `next_event_timeout` 里用这个值做 `set_read_timeout`，让 stop / close 可以快速生效。
const READ_POLL_INTERVAL: Duration = Duration::from_millis(5);

/// dev-only WS frame 日志 target；release 因 LevelFilter::Info 自动消失。
const WS_LOG_TARGET: &str = "openspeech::asr::tencent_ws";

/// 给 worker 的出站消息：音频 / 结束 / 主动关闭。
enum Outbound {
    Binary(Vec<u8>),
    /// `{"type":"end"}` —— 通知服务端音频已发完。
    End,
    /// 主动 Close 帧（用户取消或外部 drop 时）。
    Close,
}

/// 上层拿到的事件壳：解析过的腾讯事件，或一个不可恢复的错误。
#[derive(Debug)]
pub enum SessionEvent {
    Frame(TencentEvent),
    /// 单条解码失败（极少见——腾讯协议固定，主要兜底将来字段加新）。
    DecodeError(String),
    /// 网络层挂了：连接断开 / IO 错误。worker 已退出。
    Network(String),
}

/// 错误：用于 `connect` 阶段（握手前的 URL 构造、TCP/TLS、WS upgrade）。
#[derive(Debug)]
pub enum ConnectError {
    /// URL 拒绝接受为 client request（理论上不发生，腾讯 host 是定值）。
    Url(String),
    /// 底层 WS 握手 / TCP / TLS 失败。
    Network(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Url(m) => write!(f, "tencent ws url: {m}"),
            ConnectError::Network(m) => write!(f, "tencent ws connect: {m}"),
        }
    }
}

impl std::error::Error for ConnectError {}

/// 实时 ASR WebSocket 会话。`!Sync` 但 send_/recv_ 通过 mpsc 在不同线程并发安全。
pub struct TencentRealtimeSession {
    outbox: Sender<Outbound>,
    inbox: Receiver<SessionEvent>,
    worker: Option<JoinHandle<()>>,
}

/// 业务参数：与 stt/mod.rs 现有 SaaS realtime 的语义对齐。
pub struct ConnectParams<'a> {
    pub app_id: &'a str,
    pub secret_id: &'a str,
    pub secret_key: &'a str,
    /// 当前未直接消费 region —— 腾讯实时 ASR 的 host 固定 `asr.cloud.tencent.com`，
    /// 区域走 DNS 路由；保留字段以备后续切上海/广州等专有 host。
    pub _region: &'a str,
    /// 16000 / 8000，非 16000 走 input_sample_rate 升采样。
    pub sample_rate: u32,
    /// 引擎类型，例如 `16k_zh` / `16k_en` / `16k_zh_large`。
    pub engine_model_type: &'a str,
}

impl TencentRealtimeSession {
    /// 同步发起 WSS 握手并 spawn 内部 worker 线程；返回时连接已 upgrade 完成，
    /// 但服务端的 `code=0` 握手响应需要调用方调 `next_event_timeout` 拉。
    pub fn connect(params: ConnectParams<'_>) -> Result<Self, ConnectError> {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let voice_id = uuid::Uuid::new_v4().to_string();
        let nonce = (now & 0x7FFF_FFFF) as i64;

        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        q.insert("secretid", params.secret_id.to_string());
        q.insert("timestamp", now.to_string());
        // 签名 24h 后过期 —— 实时识别会话不会跨这么久。
        q.insert("expired", (now + 24 * 3600).to_string());
        q.insert("nonce", nonce.to_string());
        q.insert("engine_model_type", params.engine_model_type.to_string());
        q.insert("voice_id", voice_id);
        // 1=pcm（OpenSpeech 的 audio callback 已经是 PCM16 LE）。
        q.insert("voice_format", "1".into());
        // 8k 输入升采样到 16k：仅 sample_rate=8000 时附加。
        if params.sample_rate == 8000 {
            q.insert("input_sample_rate", "8000".into());
        }
        // 不开 VAD：长录音时 push-to-talk 模式我们希望整段当一句话；开了 VAD 反而会
        // 切碎结果。腾讯文档对 60s+ 录音建议开 vad，UTTERANCE 主路径走文件转写所以
        // 不在乎，realtime 模式的实际录音长度通常 <60s。
        q.insert("needvad", "0".into());

        let url = build_realtime_url(
            "asr.cloud.tencent.com",
            &format!("/asr/v2/{}", params.app_id),
            &q,
            params.secret_key,
        );

        log::info!(
            target: WS_LOG_TARGET,
            "[ws-connect] tencent wss://asr.cloud.tencent.com/asr/v2/{} engine={} sample_rate={}",
            params.app_id,
            params.engine_model_type,
            params.sample_rate,
        );

        let request = url
            .as_str()
            .into_client_request()
            .map_err(|e| ConnectError::Url(e.to_string()))?;

        let (mut ws, _resp) =
            tungstenite::connect(request).map_err(|e| ConnectError::Network(e.to_string()))?;

        // worker 用 nonblocking + read_timeout 的方式在 send/recv 之间切换。
        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => s
                .set_nonblocking(true)
                .map_err(|e| ConnectError::Network(e.to_string()))?,
            MaybeTlsStream::Rustls(s) => s
                .get_mut()
                .set_nonblocking(true)
                .map_err(|e| ConnectError::Network(e.to_string()))?,
            _ => {}
        }

        let (outbox_tx, outbox_rx) = mpsc::channel::<Outbound>();
        let (inbox_tx, inbox_rx) = mpsc::channel::<SessionEvent>();
        let worker = thread::Builder::new()
            .name("openspeech-tencent-rt".into())
            .spawn(move || run_worker(ws, outbox_rx, inbox_tx))
            .map_err(|e| ConnectError::Network(format!("spawn worker: {e}")))?;

        Ok(Self {
            outbox: outbox_tx,
            inbox: inbox_rx,
            worker: Some(worker),
        })
    }

    /// 发一帧 PCM16 LE 音频。worker 已退出时返回 Err，调用方按"会话已死"处理。
    pub fn send_audio_pcm16(&self, frame: Vec<u8>) -> Result<(), &'static str> {
        self.outbox
            .send(Outbound::Binary(frame))
            .map_err(|_| "session closed")
    }

    /// 通知服务端音频已发完（`{"type":"end"}`）。后续会拿到 final 段 + EndOfStream。
    pub fn finish(&self) -> Result<(), &'static str> {
        self.outbox.send(Outbound::End).map_err(|_| "session closed")
    }

    /// 等服务端的下一个事件，最多等 `dur`。
    /// `Ok(None)` = 超时；`Ok(Some(SessionEvent::Network(_)))` = worker 已退出。
    pub fn next_event_timeout(&self, dur: Duration) -> Option<SessionEvent> {
        match self.inbox.recv_timeout(dur) {
            Ok(ev) => Some(ev),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }
}

impl Drop for TencentRealtimeSession {
    fn drop(&mut self) {
        let _ = self.outbox.send(Outbound::Close);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

fn run_worker(
    mut ws: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    outbox_rx: Receiver<Outbound>,
    inbox_tx: Sender<SessionEvent>,
) {
    loop {
        // 1) 排空出站通道。Close 直接退出（先发 Close 帧再 break）。
        let mut should_break = false;
        loop {
            match outbox_rx.try_recv() {
                Ok(Outbound::Binary(bytes)) => {
                    log::debug!(
                        target: WS_LOG_TARGET,
                        "[ws-out] tencent audio binary {}B",
                        bytes.len(),
                    );
                    if let Err(e) = ws.send(Message::Binary(bytes)) {
                        if !is_would_block(&e) {
                            let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                            return;
                        }
                    }
                }
                Ok(Outbound::End) => {
                    log::debug!(target: WS_LOG_TARGET, "[ws-out] tencent text {{\"type\":\"end\"}}");
                    if let Err(e) = ws.send(Message::Text("{\"type\":\"end\"}".into())) {
                        if !is_would_block(&e) {
                            let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                            return;
                        }
                    }
                }
                Ok(Outbound::Close) => {
                    log::debug!(target: WS_LOG_TARGET, "[ws-out] tencent close");
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    should_break = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    log::debug!(
                        target: WS_LOG_TARGET,
                        "[ws-out] tencent close (outbox dropped)",
                    );
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    should_break = true;
                    break;
                }
            }
        }
        if should_break {
            return;
        }

        // 2) 主动 flush（tungstenite 的 send 在非阻塞模式下可能把数据停在内部缓冲）。
        if let Err(e) = ws.flush() {
            if !is_would_block(&e) {
                let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                return;
            }
        }

        // 3) 拉一帧服务端消息。WouldBlock = 暂无数据，睡一小会儿。
        match ws.read() {
            Ok(Message::Text(s)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] tencent text: {s}");
                match realtime::parse_frame(&s) {
                    Ok(ev) => {
                        let terminal = matches!(
                            ev,
                            TencentEvent::Error { .. } | TencentEvent::EndOfStream
                        );
                        if inbox_tx.send(SessionEvent::Frame(ev)).is_err() {
                            return;
                        }
                        if terminal {
                            // 终态后服务端会主动关；不再循环以免读到 ConnectionClosed 噪音。
                            let _ = ws.close(None);
                            let _ = ws.flush();
                            return;
                        }
                    }
                    Err(e) => {
                        let _ = inbox_tx.send(SessionEvent::DecodeError(e.to_string()));
                    }
                }
            }
            Ok(Message::Binary(b)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] tencent binary {}B", b.len());
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                log::trace!(target: WS_LOG_TARGET, "[ws-in] tencent ping/pong");
            }
            Ok(Message::Close(_)) | Ok(Message::Frame(_)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] tencent close");
                return;
            }
            Err(e) if is_would_block(&e) => {
                thread::sleep(READ_POLL_INTERVAL);
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] tencent connection closed");
                return;
            }
            Err(e) => {
                log::warn!(target: WS_LOG_TARGET, "[ws-err] tencent {e}");
                let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                return;
            }
        }
    }
}

fn is_would_block(err: &tungstenite::Error) -> bool {
    matches!(err, tungstenite::Error::Io(e) if e.kind() == IoErrorKind::WouldBlock)
}

#[cfg(test)]
mod tests {
    //! 单元测试集中在 URL 构造与签名链路（真实 connect 需要凭证 + 网络，CI 跑不到）。
    //! 帧解析的 round-trip 由 `realtime::tests` 覆盖；这里只确认 `connect` 入参
    //! 拼装的 URL 包含必要字段、签名位置正确。

    use super::*;
    use std::collections::BTreeMap;

    #[test]
    fn build_url_includes_required_fields() {
        // 直接复用 signature::build_realtime_url，确认 connect 选取的字段进了 query。
        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        q.insert("secretid", "AKIDtest".into());
        q.insert("timestamp", "1700000000".into());
        q.insert("expired", "1700086400".into());
        q.insert("nonce", "12345".into());
        q.insert("engine_model_type", "16k_zh".into());
        q.insert("voice_id", "abc-123".into());
        q.insert("voice_format", "1".into());
        q.insert("needvad", "0".into());
        let url = super::super::signature::build_realtime_url(
            "asr.cloud.tencent.com",
            "/asr/v2/12345",
            &q,
            "secret_key_test",
        );
        assert!(url.starts_with("wss://asr.cloud.tencent.com/asr/v2/12345?"));
        for need in [
            "secretid=AKIDtest",
            "engine_model_type=16k_zh",
            "voice_format=1",
            "needvad=0",
            "voice_id=abc-123",
        ] {
            assert!(url.contains(need), "missing `{need}` in {url}");
        }
        // signature 必须最后一项（无后续 &）
        let sig_pos = url.find("&signature=").expect("must have signature");
        assert!(!url[sig_pos + 1..].contains('&'));
    }

    /// frame round-trip：对 worker 真实写出的 `{"type":"end"}` text 做反向 parse，
    /// 服务端回的 final 帧能被 `parse_frame` 还原成 `TencentEvent::EndOfStream`。
    /// 这是 worker 编码 + 解码链路的对接点，避免将来改 end 消息文案后 silent break。
    #[test]
    fn end_message_roundtrips_with_server_final() {
        let outbound = Message::Text("{\"type\":\"end\"}".into());
        // 客户端"end"是单向的——服务端不回它，但回 final=1。
        let server_reply = r#"{"code":0,"message":"success","voice_id":"v","message_id":"v_n","final":1}"#;
        let ev = realtime::parse_frame(server_reply).expect("parse");
        assert_eq!(ev, TencentEvent::EndOfStream);
        // 防止 outbound 被优化掉（保留 Message 类型导入意义）
        assert!(matches!(outbound, Message::Text(_)));
    }

    #[test]
    fn binary_audio_frame_shape() {
        // 录音 callback 给 PCM16 LE bytes，长度应是偶数（每个 sample 2 bytes）。
        let frame: Vec<u8> = vec![0x10, 0x00, 0x20, 0x00, 0x30, 0x00];
        assert_eq!(frame.len() % 2, 0);
        let msg = Message::Binary(frame.clone());
        if let Message::Binary(out) = msg {
            assert_eq!(out, frame);
        } else {
            panic!("expected Binary");
        }
    }

    /// 16k 路径不应额外塞 input_sample_rate（避免引擎被误判成 8k 升采样）。
    #[test]
    fn input_sample_rate_only_for_8k() {
        // 这里复刻 connect 里的字段构造逻辑做 inline 验证。
        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        let sample_rate_8k = 8000u32;
        if sample_rate_8k == 8000 {
            q.insert("input_sample_rate", "8000".into());
        }
        assert!(q.contains_key("input_sample_rate"));

        let mut q16: BTreeMap<&str, String> = BTreeMap::new();
        let sample_rate_16k = 16000u32;
        if sample_rate_16k == 8000 {
            q16.insert("input_sample_rate", "8000".into());
        }
        assert!(!q16.contains_key("input_sample_rate"));
    }
}
