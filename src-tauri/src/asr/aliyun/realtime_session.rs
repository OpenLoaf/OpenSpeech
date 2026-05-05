// 阿里 DashScope（百炼）Qwen3-ASR-Flash-Realtime WebSocket 会话封装。
//
// 协议简述（OpenAI Realtime 风格嵌套 JSON）：
//   - URL:   wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=qwen3-asr-flash-realtime
//   - Header: Authorization: Bearer <ApiKey>
//   - 客户端发：
//       1) `session.update`（一次）：configure input_audio_format / language / turn_detection
//       2) `input_audio_buffer.append`（连续）：audio = base64(PCM16 16k mono)
//       3) `session.finish` 或 `input_audio_buffer.commit`：通知音频已发完
//   - 服务端回（type 字段路由）：
//       - `session.created` / `session.updated`
//       - `conversation.item.input_audio_transcription.delta`（partial，OpenAI 风格）
//         或 `conversation.item.input_audio_transcription.text`（旧名，兼容）
//       - `conversation.item.input_audio_transcription.completed`（final transcript）
//       - `input_audio_buffer.committed` / `.speech_started` / `.speech_stopped`
//       - `session.finished` / `error`
//
// 实现风格与腾讯 PR-4 对齐：同步 tungstenite + 内部 worker 线程 + mpsc 双通道。

use std::io::ErrorKind as IoErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use serde_json::json;
use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use tungstenite::handshake::client::generate_key;
use tungstenite::http::Request;
use tungstenite::stream::MaybeTlsStream;

const READ_POLL_INTERVAL: Duration = Duration::from_millis(5);

const DEFAULT_MODEL: &str = "qwen3-asr-flash-realtime";
const DEFAULT_HOST: &str = "dashscope.aliyuncs.com";

/// dev-only WS frame 日志 target；release 因 LevelFilter::Info 自动消失。
const WS_LOG_TARGET: &str = "openspeech::asr::aliyun_ws";

/// 出站 audio 帧的 JSON 头：worker 据此把 base64 PCM payload 折成 size 显示而不是全文。
const AUDIO_APPEND_PREFIX: &str = "{\"type\":\"input_audio_buffer.append\"";

/// 给 worker 的出站消息：base64 audio / finish / 主动关闭。
enum Outbound {
    /// 已序列化的 input_audio_buffer.append text frame。
    AppendText(String),
    /// `session.finish` text frame。
    Finish,
    /// 主动 Close。
    Close,
}

#[derive(Debug, Clone, PartialEq)]
pub enum AliyunEvent {
    /// session.created（握手成功，可选携带 sessionId）。
    Ready { session_id: Option<String> },
    /// 增量 partial 转写。OpenAI Realtime 用 `.delta`，文档里也提过 `.text`，统一兜住。
    Partial { item_id: String, text: String },
    /// `.completed`：一段稳态文本。
    Final { item_id: String, transcript: String },
    /// `session.finished` / `input_audio_buffer.committed` 后的收尾信号。
    EndOfStream,
    /// `error` 或 `session.error`。
    Error { code: String, message: String },
}

#[derive(Debug)]
pub enum SessionEvent {
    Frame(AliyunEvent),
    DecodeError(String),
    Network(String),
}

#[derive(Debug)]
pub enum ConnectError {
    Url(String),
    Network(String),
}

impl std::fmt::Display for ConnectError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ConnectError::Url(m) => write!(f, "aliyun ws url: {m}"),
            ConnectError::Network(m) => write!(f, "aliyun ws connect: {m}"),
        }
    }
}

impl std::error::Error for ConnectError {}

pub struct AliyunRealtimeSession {
    outbox: Sender<Outbound>,
    inbox: Receiver<SessionEvent>,
    worker: Option<JoinHandle<()>>,
}

pub struct ConnectParams<'a> {
    pub api_key: &'a str,
    /// `auto` / `zh` / `en` / `ja` / `ko` / `yue`（DashScope 枚举）。
    pub language: &'a str,
    pub sample_rate: u32,
    /// 服务端 VAD：true = 自动切句（hold-to-talk 仍可用 finish 兜底）；
    /// false = 手动模式，靠 `input_audio_buffer.commit` 切句。
    pub use_server_vad: bool,
}

impl AliyunRealtimeSession {
    pub fn connect(params: ConnectParams<'_>) -> Result<Self, ConnectError> {
        let url = format!(
            "wss://{host}/api-ws/v1/realtime?model={model}",
            host = DEFAULT_HOST,
            model = DEFAULT_MODEL,
        );

        let mut request: Request<()> = url
            .as_str()
            .into_client_request()
            .map_err(|e| ConnectError::Url(e.to_string()))?;
        // tungstenite 默认会塞 Host / Upgrade / Connection / Sec-WebSocket-Key 等；
        // 这里只追加 DashScope 鉴权与 OpenAI Realtime beta 头。
        let headers = request.headers_mut();
        headers.insert(
            "Authorization",
            format!("Bearer {}", params.api_key)
                .parse()
                .map_err(|e: tungstenite::http::header::InvalidHeaderValue| {
                    ConnectError::Url(e.to_string())
                })?,
        );
        // OpenAI Realtime 协议惯例：DashScope 实测忽略这个 header 也能连，
        // 加上一来兜住未来变更，二来与 OpenAI Realtime 风格保持一致。
        headers.insert(
            "OpenAI-Beta",
            "realtime=v1".parse().map_err(
                |e: tungstenite::http::header::InvalidHeaderValue| {
                    ConnectError::Url(e.to_string())
                },
            )?,
        );
        // 部分 tungstenite 版本要求显式 Sec-WebSocket-Key —— into_client_request 已生成，
        // 但保险起见若缺失再补一遍。
        if !headers.contains_key("Sec-WebSocket-Key") {
            headers.insert(
                "Sec-WebSocket-Key",
                generate_key().parse().map_err(
                    |e: tungstenite::http::header::InvalidHeaderValue| {
                        ConnectError::Url(e.to_string())
                    },
                )?,
            );
        }

        log::info!(
            target: WS_LOG_TARGET,
            "[ws-connect] aliyun wss://{host}/api-ws/v1/realtime?model={model} lang={lang} sample_rate={sr} server_vad={vad}",
            host = DEFAULT_HOST,
            model = DEFAULT_MODEL,
            lang = params.language,
            sr = params.sample_rate,
            vad = params.use_server_vad,
        );

        let (mut ws, _resp) = tungstenite::connect(request).map_err(|e| {
            // 401 / 403 / 429 / 5xx 都被 tungstenite 包成 Http(response) 或 ConnectionClosed。
            // 这里直接把字符串透传给上层，由 backends/aliyun.rs 做错误码归一。
            ConnectError::Network(e.to_string())
        })?;

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

        // 第一帧 session.update：协议要求先发 session.update 再发 audio。
        let session_update = build_session_update(
            params.language,
            params.sample_rate,
            params.use_server_vad,
        );
        outbox_tx
            .send(Outbound::AppendText(session_update))
            .map_err(|_| ConnectError::Network("internal channel closed".into()))?;

        let worker = thread::Builder::new()
            .name("openspeech-aliyun-rt".into())
            .spawn(move || run_worker(ws, outbox_rx, inbox_tx))
            .map_err(|e| ConnectError::Network(format!("spawn worker: {e}")))?;

        Ok(Self {
            outbox: outbox_tx,
            inbox: inbox_rx,
            worker: Some(worker),
        })
    }

    pub fn send_audio_pcm16(&self, frame: Vec<u8>) -> Result<(), &'static str> {
        let payload = json!({
            "type": "input_audio_buffer.append",
            "audio": BASE64.encode(&frame),
        })
        .to_string();
        self.outbox
            .send(Outbound::AppendText(payload))
            .map_err(|_| "session closed")
    }

    pub fn finish(&self) -> Result<(), &'static str> {
        self.outbox.send(Outbound::Finish).map_err(|_| "session closed")
    }

    pub fn next_event_timeout(&self, dur: Duration) -> Option<SessionEvent> {
        match self.inbox.recv_timeout(dur) {
            Ok(ev) => Some(ev),
            Err(RecvTimeoutError::Timeout) => None,
            Err(RecvTimeoutError::Disconnected) => None,
        }
    }
}

impl Drop for AliyunRealtimeSession {
    fn drop(&mut self) {
        let _ = self.outbox.send(Outbound::Close);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

fn build_session_update(language: &str, sample_rate: u32, use_server_vad: bool) -> String {
    let lang = match language {
        "zh" | "en" | "ja" | "ko" | "yue" => language,
        _ => "auto",
    };
    let turn_detection = if use_server_vad {
        json!({
            "type": "server_vad",
            "threshold": 0.5,
            "silence_duration_ms": 500,
        })
    } else {
        // 手动模式：null 显式关闭 VAD，靠 finish/commit 切句。
        serde_json::Value::Null
    };
    json!({
        "type": "session.update",
        "session": {
            "modalities": ["text"],
            "input_audio_format": "pcm",
            "sample_rate": sample_rate,
            "input_audio_transcription": { "language": lang },
            "turn_detection": turn_detection,
        }
    })
    .to_string()
}

fn run_worker(
    mut ws: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    outbox_rx: Receiver<Outbound>,
    inbox_tx: Sender<SessionEvent>,
) {
    loop {
        let mut should_break = false;
        loop {
            match outbox_rx.try_recv() {
                Ok(Outbound::AppendText(s)) => {
                    if s.starts_with(AUDIO_APPEND_PREFIX) {
                        log::debug!(
                            target: WS_LOG_TARGET,
                            "[ws-out] aliyun audio frame {}B (json)",
                            s.len(),
                        );
                    } else {
                        log::debug!(target: WS_LOG_TARGET, "[ws-out] aliyun text: {s}");
                    }
                    if let Err(e) = ws.send(Message::Text(s))
                        && !is_would_block(&e)
                    {
                        let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                        return;
                    }
                }
                Ok(Outbound::Finish) => {
                    let payload = json!({ "type": "session.finish" }).to_string();
                    log::debug!(target: WS_LOG_TARGET, "[ws-out] aliyun text: {payload}");
                    if let Err(e) = ws.send(Message::Text(payload))
                        && !is_would_block(&e)
                    {
                        let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                        return;
                    }
                }
                Ok(Outbound::Close) => {
                    log::debug!(target: WS_LOG_TARGET, "[ws-out] aliyun close");
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    should_break = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    log::debug!(
                        target: WS_LOG_TARGET,
                        "[ws-out] aliyun close (outbox dropped)",
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

        if let Err(e) = ws.flush() {
            if !is_would_block(&e) {
                let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                return;
            }
        }

        match ws.read() {
            Ok(Message::Text(s)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] aliyun text: {s}");
                match parse_frame(&s) {
                    Ok(Some(ev)) => {
                        let terminal = matches!(
                            ev,
                            AliyunEvent::EndOfStream | AliyunEvent::Error { .. }
                        );
                        if inbox_tx.send(SessionEvent::Frame(ev)).is_err() {
                            return;
                        }
                        if terminal {
                            let _ = ws.close(None);
                            let _ = ws.flush();
                            return;
                        }
                    }
                    Ok(None) => {
                        // 已知会被忽略的事件（session.updated / speech_started 等）—— 不上抛。
                    }
                    Err(e) => {
                        let _ = inbox_tx.send(SessionEvent::DecodeError(e.to_string()));
                    }
                }
            }
            Ok(Message::Binary(b)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] aliyun binary {}B", b.len());
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {
                log::trace!(target: WS_LOG_TARGET, "[ws-in] aliyun ping/pong");
            }
            Ok(Message::Close(_)) | Ok(Message::Frame(_)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] aliyun close");
                return;
            }
            Err(e) if is_would_block(&e) => {
                thread::sleep(READ_POLL_INTERVAL);
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] aliyun connection closed");
                return;
            }
            Err(e) => {
                log::warn!(target: WS_LOG_TARGET, "[ws-err] aliyun {e}");
                let _ = inbox_tx.send(SessionEvent::Network(e.to_string()));
                return;
            }
        }
    }
}

fn is_would_block(err: &tungstenite::Error) -> bool {
    matches!(err, tungstenite::Error::Io(e) if e.kind() == IoErrorKind::WouldBlock)
}

#[derive(Debug)]
pub enum ParseError {
    Decode(serde_json::Error),
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::Decode(e) => write!(f, "aliyun frame decode: {e}"),
        }
    }
}

impl std::error::Error for ParseError {}

#[derive(Debug, Deserialize)]
struct RawFrame {
    #[serde(rename = "type", default)]
    ty: String,
    #[serde(default)]
    session: Option<RawSession>,
    #[serde(default)]
    item_id: Option<String>,
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    transcript: Option<String>,
    #[serde(default)]
    error: Option<RawError>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawSession {
    #[serde(default)]
    id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct RawError {
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    message: Option<String>,
    #[serde(default, rename = "type")]
    ty: Option<String>,
}

/// 解析单条服务端文本帧；`Ok(None)` 表示已知可忽略事件。
pub fn parse_frame(raw: &str) -> Result<Option<AliyunEvent>, ParseError> {
    let f: RawFrame = serde_json::from_str(raw).map_err(ParseError::Decode)?;
    match f.ty.as_str() {
        "session.created" => Ok(Some(AliyunEvent::Ready {
            session_id: f.session.and_then(|s| s.id),
        })),
        // OpenAI 风格 .delta（增量），DashScope 旧版的 .text（一次性中间态）
        "conversation.item.input_audio_transcription.delta"
        | "conversation.item.input_audio_transcription.text" => Ok(Some(AliyunEvent::Partial {
            item_id: f.item_id.unwrap_or_default(),
            text: f.delta.or(f.text).unwrap_or_default(),
        })),
        "conversation.item.input_audio_transcription.completed" => Ok(Some(AliyunEvent::Final {
            item_id: f.item_id.unwrap_or_default(),
            transcript: f.transcript.unwrap_or_default(),
        })),
        // 服务端表示 commit 完成或 session 收尾：当作流尾。注意 input_audio_buffer.committed
        // 在 server VAD 模式可能多段（每个 utterance 一次），这里只在 session.finished 才上抛
        // EndOfStream，commit 仅是一个 ack。
        "session.finished" => Ok(Some(AliyunEvent::EndOfStream)),
        "error" | "session.error" => {
            let (code, message) = match f.error {
                Some(e) => (
                    e.code.or(e.ty).unwrap_or_default(),
                    e.message.unwrap_or_default(),
                ),
                None => (
                    f.code.unwrap_or_default(),
                    f.message.unwrap_or_default(),
                ),
            };
            Ok(Some(AliyunEvent::Error { code, message }))
        }
        // 已知忽略：session.updated / input_audio_buffer.{committed,speech_started,speech_stopped}
        // / response.* 等。不当作错误，也不上抛。
        _ => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_session_created() {
        let raw = r#"{"type":"session.created","event_id":"e_1","session":{"id":"sess_abc"}}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            Some(AliyunEvent::Ready {
                session_id: Some("sess_abc".into()),
            })
        );
    }

    #[test]
    fn parse_partial_delta() {
        let raw = r#"{"type":"conversation.item.input_audio_transcription.delta","event_id":"e","item_id":"item_1","content_index":0,"delta":"你好"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            Some(AliyunEvent::Partial {
                item_id: "item_1".into(),
                text: "你好".into(),
            })
        );
    }

    #[test]
    fn parse_partial_text_alias() {
        // DashScope 早期版本用 .text 名字、字段在 `text` 上 —— 也得兜住。
        let raw = r#"{"type":"conversation.item.input_audio_transcription.text","item_id":"item_2","text":"hello"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            Some(AliyunEvent::Partial {
                item_id: "item_2".into(),
                text: "hello".into(),
            })
        );
    }

    #[test]
    fn parse_completed() {
        let raw = r#"{"type":"conversation.item.input_audio_transcription.completed","item_id":"item_3","transcript":"你好世界"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            Some(AliyunEvent::Final {
                item_id: "item_3".into(),
                transcript: "你好世界".into(),
            })
        );
    }

    #[test]
    fn parse_error_with_nested_object() {
        let raw = r#"{"type":"error","error":{"type":"invalid_request_error","code":"InvalidApiKey","message":"鉴权失败"}}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            Some(AliyunEvent::Error {
                code: "InvalidApiKey".into(),
                message: "鉴权失败".into(),
            })
        );
    }

    #[test]
    fn parse_error_top_level_fields() {
        // 兜底：DashScope 文档里 error 也可能直接平铺 code/message。
        let raw = r#"{"type":"error","code":"Throttling","message":"too many requests"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(
            ev,
            Some(AliyunEvent::Error {
                code: "Throttling".into(),
                message: "too many requests".into(),
            })
        );
    }

    #[test]
    fn parse_session_finished_emits_eos() {
        let raw = r#"{"type":"session.finished","transcript":"final text"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(ev, Some(AliyunEvent::EndOfStream));
    }

    #[test]
    fn parse_unknown_event_is_ignored() {
        let raw = r#"{"type":"input_audio_buffer.speech_started"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(ev, None);

        let raw = r#"{"type":"session.updated"}"#;
        let ev = parse_frame(raw).unwrap();
        assert_eq!(ev, None);
    }

    #[test]
    fn parse_decode_error_on_garbage() {
        let r = parse_frame("not json");
        assert!(matches!(r, Err(ParseError::Decode(_))));
    }

    #[test]
    fn build_session_update_pcm_16k_with_server_vad() {
        let s = build_session_update("zh", 16000, true);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["type"], "session.update");
        assert_eq!(v["session"]["input_audio_format"], "pcm");
        assert_eq!(v["session"]["sample_rate"], 16000);
        assert_eq!(v["session"]["input_audio_transcription"]["language"], "zh");
        assert_eq!(v["session"]["turn_detection"]["type"], "server_vad");
    }

    #[test]
    fn build_session_update_manual_mode_emits_null_turn_detection() {
        let s = build_session_update("auto", 16000, false);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert!(v["session"]["turn_detection"].is_null());
        assert_eq!(v["session"]["input_audio_transcription"]["language"], "auto");
    }

    #[test]
    fn audio_append_round_trip_base64() {
        // PCM16 帧编码后必须仍然能 base64 解出原始字节。
        let frame: Vec<u8> = vec![0x10, 0x00, 0x20, 0x00, 0x30, 0x00];
        let payload = json!({
            "type": "input_audio_buffer.append",
            "audio": BASE64.encode(&frame),
        })
        .to_string();
        let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
        assert_eq!(v["type"], "input_audio_buffer.append");
        let b64 = v["audio"].as_str().unwrap();
        let decoded = BASE64.decode(b64).unwrap();
        assert_eq!(decoded, frame);
    }

    #[test]
    fn unknown_language_falls_back_to_auto() {
        let s = build_session_update("xx", 16000, true);
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v["session"]["input_audio_transcription"]["language"], "auto");
    }
}
