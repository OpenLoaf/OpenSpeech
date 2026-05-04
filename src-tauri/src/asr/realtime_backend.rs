// 实时 ASR 后端统一抽象。
//
// 三家 vendor（SaaS / 腾讯 / 阿里）的实时 ASR 全部走"同步线程独占 session"模型：
// SDK / 自实现的 WS 内部都用 mpsc 通道 + worker thread 解码事件，外部以
// `send_audio + finish + next_event_timeout` 三件套驱动。stt/mod.rs 的 worker 主循环
// 无法在编译期知道当前 backend 是哪一家——dispatch 在运行期决定——所以这里把
// 三件套抽成 dyn trait，main loop 只持有 `Box<dyn RealtimeAsrBackend>`。
//
// 错误码命名约定（前端 humanizeSttError 按串路由）：
//   - 通用层：unauthorized / not_authenticated / network_error / decode_error
//   - BYOK 专属：unauthenticated_byok / insufficient_funds / idle_timeout
//   - 其他：透传 vendor 原始 message
//
// 当前实现：
//   - SaaS:    SaasRealtimeBackend（包 SDK 的 RealtimeAsrSession）
//   - Tencent: TencentRealtimeBackend（包自实现的 TencentRealtimeSession）
//   - Aliyun:  PR-6 接入。

use std::time::Duration;

/// 主循环消费的标准化事件。三家 vendor 的私有事件被映射到这五种之一。
#[derive(Debug, Clone)]
pub enum RealtimeBackendEvent {
    /// 握手已完成、服务端开始 ingest 音频。可选 `session_id` 用于关联 refine。
    Ready {
        session_id: Option<String>,
    },
    /// 非稳态 partial。`sentence_id` 用于 BTreeMap 累积排序。
    Partial {
        sentence_id: i64,
        text: String,
    },
    /// 稳态 final。
    Final {
        sentence_id: i64,
        text: String,
    },
    /// 服务端表示音频流全部识别完成（腾讯 final=1 / SaaS Closed{normal}）。
    EndOfStream,
    /// 服务端关闭会话（错误或正常都可能）：reason 用于日志，total_credits 仅 SaaS 有值。
    Closed {
        reason: String,
        total_credits: Option<f64>,
    },
    /// 计费事件（SaaS 心跳）；BYOK 路径不发。
    Credits {
        remaining_credits: Option<f64>,
    },
    /// 协议层错误（vendor code != 0）。`code` 是稳定字符串，前端按串路由。
    Error {
        code: String,
        message: String,
    },
    /// 单条解码失败：上层只记日志、用预算控制连续坏帧。
    DecodeRecoverable(String),
    /// 网络层退出：worker 已死，主循环必须切 dead 路径。
    NetworkExit(String),
    /// 超时：本轮 next_event_timeout 没拿到任何事件。
    Idle,
}

/// 实时 ASR 后端抽象。三家 vendor 的 session 都实现这一组方法。
///
/// 线程模型：实现者内部都用 mpsc + worker thread；外部假设 send_audio /
/// next_event_timeout 可以在不同线程并发调（与 SDK `RealtimeAsrSession` 的契约一致）。
pub trait RealtimeAsrBackend: Send {
    /// 发一帧 PCM16 LE 音频。失败 = 会话已死，调用方按 NetworkExit 处理。
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String>;

    /// 通知服务端音频已发完。失败 = 会话已死。
    fn finish(&mut self) -> Result<(), String>;

    /// 等下一个事件，最多等 `dur`。
    fn next_event_timeout(&mut self, dur: Duration) -> RealtimeBackendEvent;
}
