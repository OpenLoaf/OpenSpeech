// 腾讯「实时说话人分离」WebSocket 接口（独立产品，不是普通实时识别套件）。
//
// 协议来源：https://cloud.tencent.com/document/product/1093/131127
//   - endpoint: wss://asr.cloud.tencent.com/asr/v2/<appid>
//   - engine_model_type: **必填且仅支持** `16k_zh_en_speaker`
//     （中英粤+7 方言大模型，整接口本身就是为说话人分离设计的）
//   - 不需要 `speaker_diarization` 参数——那是普通实时识别的额外开关，本接口
//     已经内置说话人分离能力，传 speaker_diarization 反而会被拒
//   - 返回 `sentences` 对象（含 speaker_id / start_time / end_time），
//     speaker_id 起始 -1 → 声纹聚类稳定后转正整数
//   - 推荐 40ms / 1280B 一帧
//
// 该 engine 在腾讯云属于**独立 SKU**「实时说话人分离」资源包，账号必须单独
// 开通（购买"实时语音识别大模型"等其它 SKU 都不覆盖）。未开通时服务端返
// 4001 "Not support [engine_model_type: 16k_zh_en_speaker]" —— 用 classify_code
// 转成 engine_not_authorized，前端引导跳腾讯云控制台资源包页。
//
// 签名沿用普通实时识别同一套 (HMAC-SHA1)。

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

use crate::asr::tencent::signature::{
    build_canonical_query, build_realtime_signing_string, sign_realtime, urlencode_signature,
};

use super::provider::{
    MeetingAsrProvider, MeetingEvent, MeetingProviderCapabilities, MeetingProviderError,
    MeetingSegment, MeetingSession, MeetingSessionConfig,
};

const HOST: &str = "asr.cloud.tencent.com";
// 文档强制：必填且仅支持这个值（独立 SKU 的专用 engine，不是普通 ASR engine）。
const ENGINE_MODEL_TYPE: &str = "16k_zh_en_speaker";
const READ_POLL_INTERVAL: Duration = Duration::from_millis(5);
const WS_LOG_TARGET: &str = "openspeech::asr::meeting::tencent";

/// 16k_zh_en 大模型引擎自带多语种判别（中英粤+9 方言）。
/// language 字段不会传给腾讯——只用作前端 UI 的合法性预检。
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

        // 严格按文档 #131127 的请求参数表填，**不**加普通实时识别的额外开关
        // （speaker_diarization / result_mod 等），否则服务端会以"参数不合法"拒。
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

        let path = format!("/asr/v2/{}", provider.app_id);

        // 全量诊断：参数、签名原文、签名值、URL-encoded 签名、最终 URL，逐项打印。
        // 让现场可以肉眼对照腾讯文档逐字段排查（如本次 4001 是否真的因 engine 名拼错）。
        log::info!(target: WS_LOG_TARGET, "[ws-debug] >>> connect begin");
        log::info!(target: WS_LOG_TARGET, "[ws-debug] host={HOST}");
        log::info!(target: WS_LOG_TARGET, "[ws-debug] path={path}");
        for (k, v) in &q {
            log::info!(target: WS_LOG_TARGET, "[ws-debug] query[{k}] = {v}");
        }

        let canonical_query = build_canonical_query(&q);
        log::info!(target: WS_LOG_TARGET, "[ws-debug] canonical_query = {canonical_query}");

        let signing_string = build_realtime_signing_string(HOST, &path, &canonical_query);
        log::info!(target: WS_LOG_TARGET, "[ws-debug] signing_string = {signing_string}");

        let sig = sign_realtime(&provider.secret_key, &signing_string);
        log::info!(target: WS_LOG_TARGET, "[ws-debug] signature_b64 = {sig}");

        let sig_enc = urlencode_signature(&sig);
        log::info!(target: WS_LOG_TARGET, "[ws-debug] signature_url_encoded = {sig_enc}");

        let url = format!("wss://{HOST}{path}?{canonical_query}&signature={sig_enc}");
        log::info!(target: WS_LOG_TARGET, "[ws-debug] final_url = {url}");

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
        log::info!(
            target: WS_LOG_TARGET,
            "[ws-debug] http_upgrade_request method={} uri={} headers={:?}",
            request.method(),
            request.uri(),
            request.headers(),
        );

        let (mut ws, resp) = tungstenite::connect(request).map_err(|e| {
            log::warn!(target: WS_LOG_TARGET, "[ws-debug] tungstenite::connect failed: {e}");
            MeetingProviderError::Network(e.to_string())
        })?;
        log::info!(
            target: WS_LOG_TARGET,
            "[ws-debug] http_upgrade_response status={} headers={:?}",
            resp.status(),
            resp.headers(),
        );

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
                    log::trace!(
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
                // 入站文本一律 INFO 打印，不预先解析——故障期可以在日志里直接读
                // 服务端原文（这次 4001 就是靠它发现 engine 字段被腾讯拒）。
                log::info!(target: WS_LOG_TARGET, "[ws-in] tencent_speaker text raw: {s}");
                match parse_frame(&s) {
                    Ok(events) => {
                        for ev in events {
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
                    }
                    Err(e) => {
                        let _ = inbox_tx
                            .send(SessionRaw::Event(MeetingEvent::DecodeRecoverable(e)));
                    }
                }
            }
            Ok(Message::Binary(b)) => {
                log::info!(
                    target: WS_LOG_TARGET,
                    "[ws-in] tencent_speaker binary {}B (first 32B hex: {:02x?})",
                    b.len(),
                    &b[..b.len().min(32)],
                );
            }
            Ok(Message::Ping(p)) => {
                log::info!(target: WS_LOG_TARGET, "[ws-in] tencent_speaker ping {}B", p.len());
            }
            Ok(Message::Pong(p)) => {
                log::info!(target: WS_LOG_TARGET, "[ws-in] tencent_speaker pong {}B", p.len());
            }
            Ok(Message::Close(frame)) => {
                log::info!(target: WS_LOG_TARGET, "[ws-in] tencent_speaker close frame: {frame:?}");
                return;
            }
            Ok(Message::Frame(_)) => return,
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
struct SpeakerSentences {
    #[serde(default)]
    pub sentence_list: Vec<SpeakerSentence>,
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
    pub sentences: Option<SpeakerSentences>,
    #[serde(default, rename = "final")]
    pub final_flag: Option<i32>,
}

/// 把一帧服务端 JSON 解析成一组 MeetingEvent。
///
/// 腾讯 16k_zh_en_speaker 协议 `sentences` 字段是 `{"sentence_list": [{...}, ...]}`
/// 包了一层数组——典型情况下数组只有 1 条，但偶尔会一帧推多句，必须按数组迭代。
/// 上一版误把 `sentences` 当成单个 sentence 对象，serde 用 default 静默吞掉真实
/// 内容，前端永远只看到空文本。
pub fn parse_frame(raw: &str) -> Result<Vec<MeetingEvent>, String> {
    let frame: SpeakerFrame = serde_json::from_str(raw).map_err(|e| e.to_string())?;
    if frame.code != 0 {
        return Ok(vec![MeetingEvent::Error {
            code: classify_code(frame.code, &frame.message),
            message: frame.message,
        }]);
    }
    if frame.final_flag == Some(1) {
        return Ok(vec![MeetingEvent::EndOfStream]);
    }
    match frame.sentences {
        Some(s) if !s.sentence_list.is_empty() => Ok(s
            .sentence_list
            .into_iter()
            .map(|x| {
                let segment = MeetingSegment {
                    sentence_id: x.sentence_id,
                    speaker_id: x.speaker_id,
                    text: x.sentence,
                    start_ms: x.start_time,
                    end_ms: x.end_time,
                };
                if x.sentence_type == 1 {
                    MeetingEvent::SegmentFinal(segment)
                } else {
                    MeetingEvent::SegmentPartial(segment)
                }
            })
            .collect()),
        _ => Ok(vec![MeetingEvent::Ready {
            session_id: if frame.voice_id.is_empty() {
                None
            } else {
                Some(frame.voice_id)
            },
        }]),
    }
}

/// 把腾讯错误码归一到稳定字符串，前端按串路由文案。
/// 4001 message 含 `engine_model_type` → engine_not_authorized：
///   现在 engine 已固定 `16k_zh_en` 走通，理论上只在用户的 AppID 完全没买"实时
///   语音识别大模型" SKU 时才命中（否则普通 16k_zh_en 也会被拒）。前端文案据此
///   引导用户去资源包页购买 SKU。
fn classify_code(code: i32, message: &str) -> String {
    match code {
        4001 if message.contains("engine_model_type") => "engine_not_authorized".into(),
        4002 | 4003 => "unauthenticated_byok".into(),
        4004 | 4005 => "insufficient_funds".into(),
        4008 => "idle_timeout".into(),
        4006 => "rate_limited".into(),
        _ => format!("tencent_{code}"),
    }
}
