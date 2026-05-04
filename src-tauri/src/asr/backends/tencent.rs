// 腾讯 BYOK 实时 ASR backend：包 `TencentRealtimeSession` + 错误码归一。
//
// 错误码映射（腾讯码 → 前端稳定字符串）：
//   4002        → unauthenticated_byok    （SecretId/SecretKey 错）
//   4004 / 4005 → insufficient_funds      （资源包耗尽 / 账户欠费）
//   4008        → idle_timeout            （15s 未送音频）
//   其余        → 透传 vendor message（前端走 fallback "短消息" 文案）
//
// 注意：错误码字符串与 `realtime::classify_error_code` 不同——后者覆盖更广（rate_limited /
// region_blocked 等），但本端 BYOK 用户面对的核心三类是凭证 / 余额 / 闲置。其他码原样
// 透传 message，保留腾讯文档原始描述，避免再造翻译层。

use std::time::Duration;

use crate::asr::realtime_backend::{RealtimeAsrBackend, RealtimeBackendEvent};
use crate::asr::tencent::realtime::TencentEvent;
use crate::asr::tencent::realtime_session::{SessionEvent, TencentRealtimeSession};

pub struct TencentRealtimeBackend {
    sess: TencentRealtimeSession,
}

impl TencentRealtimeBackend {
    pub fn new(sess: TencentRealtimeSession) -> Self {
        Self { sess }
    }
}

impl RealtimeAsrBackend for TencentRealtimeBackend {
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String> {
        self.sess.send_audio_pcm16(pcm16).map_err(|e| e.to_string())
    }

    fn finish(&mut self) -> Result<(), String> {
        self.sess.finish().map_err(|e| e.to_string())
    }

    fn next_event_timeout(&mut self, dur: Duration) -> RealtimeBackendEvent {
        match self.sess.next_event_timeout(dur) {
            None => RealtimeBackendEvent::Idle,
            Some(SessionEvent::Frame(frame)) => map_tencent_frame(frame),
            Some(SessionEvent::DecodeError(msg)) => RealtimeBackendEvent::DecodeRecoverable(msg),
            Some(SessionEvent::Network(msg)) => RealtimeBackendEvent::NetworkExit(msg),
        }
    }
}

fn map_tencent_frame(ev: TencentEvent) -> RealtimeBackendEvent {
    match ev {
        TencentEvent::Ready { voice_id } => RealtimeBackendEvent::Ready {
            session_id: if voice_id.is_empty() {
                None
            } else {
                Some(voice_id)
            },
        },
        TencentEvent::Partial { sentence_id, text } => RealtimeBackendEvent::Partial {
            sentence_id,
            text,
        },
        TencentEvent::Final { sentence_id, text } => {
            RealtimeBackendEvent::Final { sentence_id, text }
        }
        TencentEvent::EndOfStream => RealtimeBackendEvent::EndOfStream,
        TencentEvent::Error { code, message } => RealtimeBackendEvent::Error {
            code: classify_byok_code(code).into(),
            message,
        },
    }
}

/// 腾讯实时 ASR 错误码 → 前端稳定字符串。仅覆盖 BYOK 用户最常见的三类，其余降级
/// 为 vendor 原文 + 错误码（让前端把数字串展示出来便于排查）。
fn classify_byok_code(code: i32) -> String {
    match code {
        4002 => "unauthenticated_byok".into(),
        4004 | 4005 => "insufficient_funds".into(),
        4008 => "idle_timeout".into(),
        other => format!("tencent_{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_4002_to_unauthenticated_byok() {
        let ev = TencentEvent::Error {
            code: 4002,
            message: "鉴权失败".into(),
        };
        match map_tencent_frame(ev) {
            RealtimeBackendEvent::Error { code, .. } => {
                assert_eq!(code, "unauthenticated_byok");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_4004_and_4005_to_insufficient_funds() {
        for code in [4004, 4005] {
            let ev = TencentEvent::Error {
                code,
                message: "x".into(),
            };
            match map_tencent_frame(ev) {
                RealtimeBackendEvent::Error { code: c, .. } => {
                    assert_eq!(c, "insufficient_funds");
                }
                other => panic!("unexpected for {code}: {other:?}"),
            }
        }
    }

    #[test]
    fn map_4008_to_idle_timeout() {
        let ev = TencentEvent::Error {
            code: 4008,
            message: "客户端 15s 未发数据".into(),
        };
        match map_tencent_frame(ev) {
            RealtimeBackendEvent::Error { code, .. } => assert_eq!(code, "idle_timeout"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_other_codes_pass_through() {
        let ev = TencentEvent::Error {
            code: 4007,
            message: "audio decode failed".into(),
        };
        match map_tencent_frame(ev) {
            RealtimeBackendEvent::Error { code, message } => {
                assert_eq!(code, "tencent_4007");
                assert_eq!(message, "audio decode failed");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_ready_with_voice_id() {
        let ev = TencentEvent::Ready {
            voice_id: "uuid-abc".into(),
        };
        match map_tencent_frame(ev) {
            RealtimeBackendEvent::Ready { session_id } => {
                assert_eq!(session_id.as_deref(), Some("uuid-abc"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_ready_empty_voice_id_is_none() {
        let ev = TencentEvent::Ready {
            voice_id: String::new(),
        };
        match map_tencent_frame(ev) {
            RealtimeBackendEvent::Ready { session_id } => assert!(session_id.is_none()),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_partial_and_final_pass_through() {
        let p = TencentEvent::Partial {
            sentence_id: 3,
            text: "hello".into(),
        };
        match map_tencent_frame(p) {
            RealtimeBackendEvent::Partial { sentence_id, text } => {
                assert_eq!(sentence_id, 3);
                assert_eq!(text, "hello");
            }
            other => panic!("unexpected: {other:?}"),
        }

        let f = TencentEvent::Final {
            sentence_id: 5,
            text: "world".into(),
        };
        match map_tencent_frame(f) {
            RealtimeBackendEvent::Final { sentence_id, text } => {
                assert_eq!(sentence_id, 5);
                assert_eq!(text, "world");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_end_of_stream() {
        match map_tencent_frame(TencentEvent::EndOfStream) {
            RealtimeBackendEvent::EndOfStream => {}
            other => panic!("unexpected: {other:?}"),
        }
    }
}
