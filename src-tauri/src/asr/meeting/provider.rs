// 会议实时 ASR 供应商通用抽象。

use std::time::Duration;

/// 一家 vendor 提供"实时 ASR + 说话人分离"能力的入口。
///
/// 实现者必须保证 `open()` 是同步的（握手前的鉴权 / URL 构造），
/// 真正的网络 IO 由返回的 `MeetingSession` 内部 worker 线程承担。
pub trait MeetingAsrProvider: Send + Sync {
    /// 稳定 id，用于日志 / 设置存储 / 错误码前缀。例如 `"tencent_speaker"`。
    fn id(&self) -> &'static str;

    /// 能力广播。前端按这个矩阵 gate 语种选择、显示警示文案。
    fn capabilities(&self) -> MeetingProviderCapabilities;

    /// 打开一个会议会话。返回的 session 已经 spawn 好 worker；
    /// 调用方需要紧接着轮询 `next_event` 等一个 `MeetingEvent::Ready`。
    fn open(
        &self,
        config: MeetingSessionConfig,
    ) -> Result<Box<dyn MeetingSession>, MeetingProviderError>;
}

/// Provider 能力矩阵。新接入 vendor 时按实际能力填，**不要给 false 但暗中支持**——
/// UI 会基于这里 gate 语种 / 引擎选项。
#[derive(Debug, Clone)]
pub struct MeetingProviderCapabilities {
    /// 是否原生支持说话人分离（带 speaker_id 的稳态结果）。
    pub speaker_diarization: bool,
    /// 受支持的 ISO 语种 / 方言代码。空数组表示"自动检测，无显式选项"。
    pub supported_languages: &'static [&'static str],
    /// 服务端单次空闲多少 ms 会主动断开（超过这个值上层得灌 silent PCM 续命）。
    pub max_idle_silence_ms: u32,
    /// 推荐的音频帧节奏（ms/frame）。腾讯说话人分离建议 40ms。
    pub recommended_chunk_ms: u32,
    /// 标称采样率。当前所有 provider 都按 16000 PCM16 mono 喂；保留扩展位。
    pub sample_rate: u32,
}

/// 单次会话的入参。语种字符串走 ISO 风格（"zh"/"en"/"yue"…），由 provider 内部
/// 映射到自家的 engine 名 / 语种 hint。
#[derive(Debug, Clone)]
pub struct MeetingSessionConfig {
    pub language: String,
    pub sample_rate: u32,
    /// 显式开关：某些 provider 支持但默认关闭，或者用户 BYOK 时不想付额外费用。
    pub enable_diarization: bool,
}

/// 一次会议会话。线程模型与 dictation 的 `RealtimeAsrBackend` 一致：
/// 实现者内部用 mpsc + worker thread；外部 send/finish/poll 三件套可跨线程并发调。
pub trait MeetingSession: Send {
    /// 喂一帧 PCM16 LE 音频。`Err` 表示 worker 已退出，应停止后续发送。
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String>;

    /// 通知服务端音频已发完。等 `MeetingEvent::EndOfStream` 后即可 drop。
    fn finish(&mut self) -> Result<(), String>;

    /// 拉一个事件，最多等 `dur`。
    fn next_event(&mut self, dur: Duration) -> MeetingEvent;
}

/// 标准化后的会议事件。所有 vendor 的私有协议都映射到这一组之一。
#[derive(Debug, Clone, PartialEq)]
pub enum MeetingEvent {
    /// 握手完成、可以开始灌音频。`session_id` 用于客户端关联日志 / 上报。
    Ready { session_id: Option<String> },

    /// 非稳态片段（仍可能改写）。
    /// `speaker_id == -1` 表示声纹聚类尚未稳定 —— 上层渲染时显示"待识别"。
    SegmentPartial(MeetingSegment),

    /// 稳态片段（不会再变）。可以入库。
    SegmentFinal(MeetingSegment),

    /// 服务端表示音频流全部识别结束（终止信号）。
    EndOfStream,

    /// 协议层错误（vendor code != 0）。`code` 是稳定字符串，前端按串路由。
    Error { code: String, message: String },

    /// 网络层退出 / worker 死了。主循环必须切 dead 路径。
    NetworkExit(String),

    /// 单条解码失败：上层只记日志、用预算控制连续坏帧。
    DecodeRecoverable(String),

    /// 本轮超时未拿到任何事件。
    Idle,
}

/// 单个识别片段。所有时间戳单位 ms，相对会话起点。
#[derive(Debug, Clone, PartialEq)]
pub struct MeetingSegment {
    /// vendor 给的 sentence/index 序号。-1 表示 vendor 没提供（罕见）。
    pub sentence_id: i64,
    /// -1 = 待识别；0/1/... = 实际说话人编号。
    pub speaker_id: i32,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

/// `open()` 阶段的错误。
#[derive(Debug)]
pub enum MeetingProviderError {
    /// 凭证缺失或无效（在握手之前就能判定的）。
    Unauthenticated(String),
    /// URL / 参数构造失败（理论上不发生）。
    BadConfig(String),
    /// 底层网络 / TLS / WS 握手失败。
    Network(String),
    /// 用户开了某个 vendor 不支持的能力（如 enable_diarization=true 但 vendor 不支持）。
    Unsupported(String),
}

impl std::fmt::Display for MeetingProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            MeetingProviderError::Unauthenticated(m) => write!(f, "unauthenticated: {m}"),
            MeetingProviderError::BadConfig(m) => write!(f, "bad config: {m}"),
            MeetingProviderError::Network(m) => write!(f, "network: {m}"),
            MeetingProviderError::Unsupported(m) => write!(f, "unsupported: {m}"),
        }
    }
}

impl std::error::Error for MeetingProviderError {}
