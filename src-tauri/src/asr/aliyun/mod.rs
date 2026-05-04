// 阿里 DashScope（百炼）ASR 直连实现（BYOK 模式）。
//
// 凭证：DashScope ApiKey（Bearer），由 keyring 存。
// 实时通道：Qwen3-ASR-Flash-Realtime，OpenAI Realtime 风格的嵌套 JSON 协议，
//            base64 PCM 帧 over text，单元测试覆盖在 realtime_session.rs。

pub mod file;
pub mod oss_upload;
pub mod realtime_session;
