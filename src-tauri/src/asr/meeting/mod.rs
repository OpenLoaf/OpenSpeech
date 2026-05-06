// 会议实时 ASR + 说话人分离的供应商抽象层。
//
// 与 dictation 主路径的 `RealtimeAsrBackend` 故意分开：dictation 的事件流没有
// `speaker_id` / 时间戳，强行扩字段会污染那条主链。会议这条线另起 trait，
// 字段语义按"说话人分离"的最大公约数来设计——任何上游（腾讯 / 阿里 / 谷歌 /
// 自部署 whisper-diarization）想接入都按这同一组方法/事件实现。
//
// 抽象的取舍：
// - `MeetingAsrProvider` = 工厂 + capability 广播；UI 用 capabilities 决定语种
//   下拉项、是否显示"未分离说话人"提示等。
// - `MeetingSession`     = 单次会话生命周期；与 RealtimeAsrBackend 三件套对齐，
//   但事件结构不同：独立的 `MeetingEvent` enum，必带 speaker_id + 时间戳。
// - `speaker_id` 用 i32：上游通常给 -1/0/1/...，-1 表示尚未聚类成功。
//
// 当前实现：tencent_speaker（`16k_zh_en_speaker` 引擎）。后续接阿里 paraformer-
// realtime + speaker、Google Speech-to-Text v2 diarizationConfig 等，按 vendor
// 子模块落进 `meeting/<vendor>.rs` 然后在 `mod.rs` 注册。

pub mod provider;
pub mod tencent_speaker;

#[cfg(test)]
mod tests;

pub use provider::{
    MeetingAsrProvider, MeetingEvent, MeetingProviderCapabilities, MeetingProviderError,
    MeetingSession, MeetingSessionConfig,
};
