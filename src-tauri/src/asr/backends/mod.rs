// 各 vendor 的 RealtimeAsrBackend 实现。
//
// SaaS  -> 包 SDK `RealtimeAsrSession`（保留现有 OpenLoaf 链路）
// Tencent -> 包自实现的 `TencentRealtimeSession`
// Aliyun  -> PR-6 接入

pub mod aliyun;
pub mod saas;
pub mod tencent;
