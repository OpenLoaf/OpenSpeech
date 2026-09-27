// 各 vendor 的 RealtimeAsrBackend 实现。
//
// SaaS  -> 包 SDK `RealtimeAsrSession`（保留现有 OpenLoaf 链路）
// Tencent -> 包自实现的 `TencentRealtimeSession`
// Aliyun  -> PR-6 接入
// Local   -> 包 local_asr 引擎（离线，不联网）

pub mod aliyun;
pub mod local;
pub mod saas;
pub mod tencent;
