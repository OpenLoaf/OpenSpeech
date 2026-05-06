// 腾讯实时语音识别 + 说话人分离（`16k_zh_en_speaker` 引擎）。
//
// 协议参考：docs/tencent-asr/websocket-realtime-speaker-diarization.md
// 与普通实时识别的差异：
//   - engine_model_type 仅有 "16k_zh_en_speaker"（中英 + 部分方言）
//   - 服务端结果在 `sentences` 字段（对象，含 speaker_id / start_time / end_time），
//     而不是普通实时的 `result`
//   - speaker_id 起始 -1，声纹聚类稳定后变正整数
//   - 推荐 40ms / 1280B 一帧（vs 普通 200ms）
//
// 复用：
//   - signature::build_realtime_url （HMAC-SHA1 一致）
//   - tencent/realtime_session.rs 的 worker 框架（Outbound/SessionEvent 同 shape，
//     但解析器不一样 —— 这里独立实现 parser，避免污染 dictation 主路径）

use std::collections::BTreeMap;
use std::io::ErrorKind as IoErrorKind;
use std::net::TcpStream;
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::thread::{self, JoinHandle};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tungstenite::Message;
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;

use crate::asr::tencent::signature::build_realtime_url;

use super::provider::{
    MeetingAsrProvider, MeetingEvent, MeetingProviderCapabilities, MeetingProviderError,
    MeetingSegment, MeetingSession, MeetingSessionConfig,
};

const HOST: &str = "asr.cloud.tencent.com";
const ENGINE_MODEL_TYPE: &str = "16k_zh_en_speaker";
const READ_POLL_INTERVAL: Duration = Duration::from_millis(5);
const WS_LOG_TARGET: &str = "openspeech::asr::meeting::tencent";

/// 腾讯说话人分离引擎原生支持的语种 / 方言代码。
/// UI 用这个数组渲染语言选择器。
pub const SUPPORTED_LANGUAGES: &[&str] = &[
    "zh",  // 中文
    "en",  // 英语
    "yue", // 粤语
    "sc",  // 四川话
    "sx",  // 陕西话
    "hn",  // 河南话
    "sh",  // 上海话
    "xn",  // 湖南话
    "hb",  // 湖北话
    "ah",  // 安徽话
];

// ---------- Provider 实例 ----------

/// 腾讯说话人分离 provider 实例。无状态——凭证从环境变量 / settings 现拿。
///
/// 正式接入设置 UI 之前，先靠 `TENCENT_APPID/SECRET_ID/SECRET_KEY` 三个环境变量
/// 跑通技术栈（与 `examples/test_meeting_speaker_realtime.rs` 配合）。
pub struct TencentSpeakerProvider {
    pub app_id: String,
    pub secret_id: String,
    pub secret_key: String,
}

impl TencentSpeakerProvider {
    pub fn new(app_id: impl Into<String>, secret_id: impl Into<String>, secret_key: impl Into<String>) -> Self {
        Self {
            app_id: app_id.into(),
            secret_id: secret_id.into(),
            secret_key: secret_key.into(),
        }
    }

    /// 从环境变量读取凭证；用于 examples / 集成测试。
    pub fn from_env() -> Result<Self, MeetingProviderError> {
        let app_id = std::env::var("TENCENT_APPID")
            .map_err(|_| MeetingProviderError::Unauthenticated("TENCENT_APPID not set".into()))?;
        let secret_id = std::env::var("TENCENT_SECRET_ID").map_err(|_| {
            MeetingProviderError::Unauthenticated("TENCENT_SECRET_ID not set".into())
        })?;
        let secret_key = std::env::var("TENCENT_SECRET_KEY").map_err(|_| {
            MeetingProviderError::Unauthenticated("TENCENT_SECRET_KEY not set".into())
        })?;
        Ok(Self::new(app_id, secret_id, secret_key))
    }
}

impl MeetingAsrProvider for TencentSpeakerProvider {
    fn id(&self) -> &'static str {
        "tencent_speaker"
    }

    fn capabilities(&self) -> MeetingProviderCapabilities {
        MeetingProviderCapabilities {
            speaker_diarization: true,
            supported_languages: SUPPORTED_LANGUAGES,
            max_idle_silence_ms: 15_000,
            recommended_chunk_ms: 40,
            sample_rate: 16_000,
        }
    }

    fn open(
        &self,
        config: MeetingSessionConfig,
    ) -> Result<Box<dyn MeetingSession>, MeetingProviderError> {
        if !config.enable_diarization {
            return Err(MeetingProviderError::Unsupported(
                "tencent_speaker engine always returns speaker_id; set enable_diarization=true"
                    .into(),
            ));
        }
        if !SUPPORTED_LANGUAGES.contains(&config.language.as_str()) {
            return Err(MeetingProviderError::Unsupported(format!(
                "language `{}` not supported by tencent 16k_zh_en_speaker",
                config.language
            )));
        }
        let session = TencentSpeakerSession::connect(self, &config)?;
        Ok(Box::new(session))
    }
}

// ---------- 会话实现 ----------

/// 单次会议会话：内部一个 worker 线程托管 WebSocket。
pub struct TencentSpeakerSession {
    outbox: Sender<Outbound>,
    inbox: Receiver<SessionRaw>,
    worker: Option<JoinHandle<()>>,
    voice_id: Option<String>,
}

enum Outbound {
    Binary(Vec<u8>),
    End,
    Close,
}

/// worker 解码出来的事件——直接是已映射好的 MeetingEvent，
/// 但不能跨线程时机也"裸"传 NetworkExit，所以单独包一层。
enum SessionRaw {
    Event(MeetingEvent),
    Network(String),
}

impl TencentSpeakerSession {
    fn connect(
        provider: &TencentSpeakerProvider,
        _config: &MeetingSessionConfig,
    ) -> Result<Self, MeetingProviderError> {
        if provider.app_id.is_empty() || provider.secret_id.is_empty() || provider.secret_key.is_empty() {
            return Err(MeetingProviderError::Unauthenticated(
                "tencent app_id / secret_id / secret_key empty".into(),
            ));
        }
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let voice_id = uuid::Uuid::new_v4().to_string();
        let nonce = (now & 0x7FFF_FFFF) as i64;

        let mut q: BTreeMap<&str, String> = BTreeMap::new();
        q.insert("secretid", provider.secret_id.clone());
        q.insert("timestamp", now.to_string());
        q.insert("expired", (now + 24 * 3600).to_string());
        q.insert("nonce", nonce.to_string());
        q.insert("engine_model_type", ENGINE_MODEL_TYPE.into());
        q.insert("voice_id", voice_id.clone());
        // 1=PCM
        q.insert("voice_format", "1".into());
        // 会议长录音可能有较长静默：开 vad 让服务端自行切句，避免一句话太长被截
        q.insert("needvad", "1".into());

        let url = build_realtime_url(
            HOST,
            &format!("/asr/v2/{}", provider.app_id),
            &q,
            &provider.secret_key,
        );

        log::info!(
            target: WS_LOG_TARGET,
            "[ws-connect] tencent_speaker wss://{}/asr/v2/{} engine={}",
            HOST,
            provider.app_id,
            ENGINE_MODEL_TYPE,
        );

        let request = url
            .as_str()
            .into_client_request()
            .map_err(|e| MeetingProviderError::BadConfig(e.to_string()))?;

        let (mut ws, _resp) = tungstenite::connect(request)
            .map_err(|e| MeetingProviderError::Network(e.to_string()))?;

        match ws.get_mut() {
            MaybeTlsStream::Plain(s) => s
                .set_nonblocking(true)
                .map_err(|e| MeetingProviderError::Network(e.to_string()))?,
            MaybeTlsStream::Rustls(s) => s
                .get_mut()
                .set_nonblocking(true)
                .map_err(|e| MeetingProviderError::Network(e.to_string()))?,
            _ => {}
        }

        let (outbox_tx, outbox_rx) = mpsc::channel::<Outbound>();
        let (inbox_tx, inbox_rx) = mpsc::channel::<SessionRaw>();
        let worker = thread::Builder::new()
            .name("openspeech-tencent-speaker".into())
            .spawn(move || run_worker(ws, outbox_rx, inbox_tx))
            .map_err(|e| MeetingProviderError::Network(format!("spawn worker: {e}")))?;

        Ok(Self {
            outbox: outbox_tx,
            inbox: inbox_rx,
            worker: Some(worker),
            voice_id: Some(voice_id),
        })
    }
}

impl MeetingSession for TencentSpeakerSession {
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String> {
        self.outbox
            .send(Outbound::Binary(pcm16))
            .map_err(|_| "session closed".into())
    }

    fn finish(&mut self) -> Result<(), String> {
        self.outbox
            .send(Outbound::End)
            .map_err(|_| "session closed".into())
    }

    fn next_event(&mut self, dur: Duration) -> MeetingEvent {
        match self.inbox.recv_timeout(dur) {
            Ok(SessionRaw::Event(MeetingEvent::Ready { session_id })) => MeetingEvent::Ready {
                session_id: session_id.or_else(|| self.voice_id.clone()),
            },
            Ok(SessionRaw::Event(ev)) => ev,
            Ok(SessionRaw::Network(m)) => MeetingEvent::NetworkExit(m),
            Err(RecvTimeoutError::Timeout) => MeetingEvent::Idle,
            Err(RecvTimeoutError::Disconnected) => MeetingEvent::NetworkExit("worker gone".into()),
        }
    }
}

impl Drop for TencentSpeakerSession {
    fn drop(&mut self) {
        let _ = self.outbox.send(Outbound::Close);
        if let Some(h) = self.worker.take() {
            let _ = h.join();
        }
    }
}

// ---------- WebSocket worker（结构同 dictation；仅事件解析换成 speaker 版） ----------

fn run_worker(
    mut ws: tungstenite::WebSocket<MaybeTlsStream<TcpStream>>,
    outbox_rx: Receiver<Outbound>,
    inbox_tx: Sender<SessionRaw>,
) {
    loop {
        let mut should_break = false;
        loop {
            match outbox_rx.try_recv() {
                Ok(Outbound::Binary(bytes)) => {
                    log::debug!(
                        target: WS_LOG_TARGET,
                        "[ws-out] tencent_speaker audio binary {}B",
                        bytes.len(),
                    );
                    if let Err(e) = ws.send(Message::Binary(bytes)) {
                        if !is_would_block(&e) {
                            let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                            return;
                        }
                    }
                }
                Ok(Outbound::End) => {
                    log::debug!(
                        target: WS_LOG_TARGET,
                        "[ws-out] tencent_speaker text {{\"type\":\"end\"}}",
                    );
                    if let Err(e) = ws.send(Message::Text("{\"type\":\"end\"}".into())) {
                        if !is_would_block(&e) {
                            let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                            return;
                        }
                    }
                }
                Ok(Outbound::Close) => {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                    should_break = true;
                    break;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
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
                let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                return;
            }
        }

        match ws.read() {
            Ok(Message::Text(s)) => {
                log::debug!(target: WS_LOG_TARGET, "[ws-in] tencent_speaker text: {s}");
                match parse_frame(&s) {
                    Ok(ev) => {
                        let terminal = matches!(
                            ev,
                            MeetingEvent::Error { .. } | MeetingEvent::EndOfStream
                        );
                        if inbox_tx.send(SessionRaw::Event(ev)).is_err() {
                            return;
                        }
                        if terminal {
                            let _ = ws.close(None);
                            let _ = ws.flush();
                            return;
                        }
                    }
                    Err(e) => {
                        let _ = inbox_tx
                            .send(SessionRaw::Event(MeetingEvent::DecodeRecoverable(e)));
                    }
                }
            }
            Ok(Message::Binary(b)) => {
                log::debug!(
                    target: WS_LOG_TARGET,
                    "[ws-in] tencent_speaker binary {}B",
                    b.len(),
                );
            }
            Ok(Message::Ping(_)) | Ok(Message::Pong(_)) => {}
            Ok(Message::Close(_)) | Ok(Message::Frame(_)) => return,
            Err(e) if is_would_block(&e) => {
                thread::sleep(READ_POLL_INTERVAL);
            }
            Err(tungstenite::Error::ConnectionClosed | tungstenite::Error::AlreadyClosed) => {
                return;
            }
            Err(e) => {
                log::warn!(target: WS_LOG_TARGET, "[ws-err] tencent_speaker {e}");
                let _ = inbox_tx.send(SessionRaw::Network(e.to_string()));
                return;
            }
        }
    }
}

fn is_would_block(err: &tungstenite::Error) -> bool {
    matches!(err, tungstenite::Error::Io(e) if e.kind() == IoErrorKind::WouldBlock)
}

// ---------- Frame parser ----------

#[derive(Debug, Clone, Deserialize, PartialEq)]
struct SpeakerSentence {
    /// 当前句子的文本内容
    #[serde(default)]
    pub sentence: String,
    /// 0 = 非稳态 partial；1 = 稳态 final
    #[serde(default)]
    pub sentence_type: u8,
    /// 当前句子的 ID，从 0 开始
    #[serde(default)]
    pub sentence_id: i64,
    /// 起始 -1，准确说话人后变正数
    #[serde(default = "default_speaker_id")]
    pub speaker_id: i32,
    /// 句子在整段流里的起始时间，单位 ms
    #[serde(default)]
    pub start_time: u64,
    #[serde(default)]
    pub end_time: u64,
}

fn default_speaker_id() -> i32 {
    -1
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
struct SpeakerFrame {
    pub code: i32,
    #[serde(default)]
    pub message: String,
    #[serde(default)]
    pub voice_id: String,
    #[serde(default)]
    pub message_id: String,
    #[serde(default)]
    pub sentences: Option<SpeakerSentence>,
    #[serde(default, rename = "final")]
    pub final_flag: Option<i32>,
}

/// 把一帧服务端 JSON 解析成 MeetingEvent。
pub fn parse_frame(raw: &str) -> Result<MeetingEvent, String> {
    let frame: SpeakerFrame = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if frame.code != 0 {
        return Ok(MeetingEvent::Error {
            code: classify_code(frame.code),
            message: frame.message,
        });
    }
    if frame.final_flag == Some(1) {
        return Ok(MeetingEvent::EndOfStream);
    }
    match frame.sentences {
        Some(s) => {
            let segment = MeetingSegment {
                sentence_id: s.sentence_id,
                speaker_id: s.speaker_id,
                text: s.sentence,
                start_ms: s.start_time,
                end_ms: s.end_time,
            };
            if s.sentence_type == 1 {
                Ok(MeetingEvent::SegmentFinal(segment))
            } else {
                Ok(MeetingEvent::SegmentPartial(segment))
            }
        }
        None => Ok(MeetingEvent::Ready {
            session_id: if frame.voice_id.is_empty() {
                None
            } else {
                Some(frame.voice_id)
            },
        }),
    }
}

/// 把腾讯错误码归一到稳定字符串，前端按串路由文案。
fn classify_code(code: i32) -> String {
    match code {
        4002 | 4003 => "unauthenticated_byok".into(),
        4004 | 4005 => "insufficient_funds".into(),
        4008 => "idle_timeout".into(),
        4006 => "rate_limited".into(),
        _ => format!("tencent_{code}"),
    }
}
