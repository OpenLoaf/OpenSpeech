// 各服务商 ASR 实现入口（与 stt/ transcribe/ 平级）。
//
// 当前只有 tencent/ 子模块（实时 + 文件转写）。后续接 aliyun / azure / google
// 等都按同样的目录结构落进来：
//
//   asr/
//   ├── mod.rs            ← 当前文件
//   ├── tencent/
//   │   ├── mod.rs
//   │   ├── signature.rs  ← HMAC-SHA1 (实时 WS) + TC3-HMAC-SHA256 (REST v3)
//   │   ├── realtime.rs   ← WebSocket 帧解析
//   │   └── file.rs       ← CreateRecTask / DescribeTaskStatus 模型
//   └── ...
//
// 这一层先不抽 trait —— 各家协议差异巨大（鉴权机制、帧格式、错误码），过早抽
// 象会导致 trait 形状被某家的怪癖锁死。等接到第二家（阿里 BYOK）时再回来抽。

pub mod aliyun;
pub mod backends;
pub mod byok;
pub mod realtime_backend;
pub mod tencent;
pub mod test_provider;
