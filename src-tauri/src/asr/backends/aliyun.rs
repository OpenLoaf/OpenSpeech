// 阿里 DashScope BYOK 实时 ASR backend：包 `AliyunRealtimeSession` + 错误码归一。
//
// 错误码映射（DashScope/网络字符串 → 前端稳定字符串）：
//   401 / 403 / Unauthorized / InvalidApiKey   → unauthenticated_byok
//   429 / Throttling / rate                    → rate_limited
//   InvalidAudioFormat / SampleRate            → aliyun_invalid_audio_format
//   QuotaExceeded / InsufficientQuota          → aliyun_quota_exceeded
//   其余                                          → 透传 vendor message

use std::time::Duration;

use crate::asr::aliyun::realtime_session::{
    AliyunEvent, AliyunRealtimeSession, SessionEvent,
};
use crate::asr::realtime_backend::{RealtimeAsrBackend, RealtimeBackendEvent};

pub struct AliyunRealtimeBackend {
    sess: AliyunRealtimeSession,
}

impl AliyunRealtimeBackend {
    pub fn new(sess: AliyunRealtimeSession) -> Self {
        Self { sess }
    }
}

impl RealtimeAsrBackend for AliyunRealtimeBackend {
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String> {
        self.sess.send_audio_pcm16(pcm16).map_err(|e| e.to_string())
    }

    fn finish(&mut self) -> Result<(), String> {
        self.sess.finish().map_err(|e| e.to_string())
    }

    fn next_event_timeout(&mut self, dur: Duration) -> RealtimeBackendEvent {
        match self.sess.next_event_timeout(dur) {
            None => RealtimeBackendEvent::Idle,
            Some(SessionEvent::Frame(frame)) => map_aliyun_frame(frame),
            Some(SessionEvent::DecodeError(msg)) => RealtimeBackendEvent::DecodeRecoverable(msg),
            Some(SessionEvent::Network(msg)) => RealtimeBackendEvent::NetworkExit(msg),
        }
    }
}

fn map_aliyun_frame(ev: AliyunEvent) -> RealtimeBackendEvent {
    match ev {
        AliyunEvent::Ready { session_id } => RealtimeBackendEvent::Ready { session_id },
        AliyunEvent::Partial { item_id, text } => RealtimeBackendEvent::Partial {
            sentence_id: hash_item_id(&item_id),
            text,
        },
        AliyunEvent::Final { item_id, transcript } => RealtimeBackendEvent::Final {
            sentence_id: hash_item_id(&item_id),
            text: transcript,
        },
        AliyunEvent::EndOfStream => RealtimeBackendEvent::EndOfStream,
        AliyunEvent::Error { code, message } => RealtimeBackendEvent::Error {
            code: classify_byok_code(&code, &message).into(),
            message,
        },
    }
}

/// DashScope 用字符串 item_id（如 "item_1"），上层抽象用 i64 sentence_id；
/// 提取尾部数字串当 id；解析失败时退化成稳定哈希——保证同一 item_id 跨 partial→final
/// 映射到同一个 i64，BTreeMap 顺序虽然失真但同一句的稳态仍能拼正确。
fn hash_item_id(item_id: &str) -> i64 {
    if item_id.is_empty() {
        return 0;
    }
    if let Some(tail) = item_id.rsplit(|c: char| !c.is_ascii_digit()).next()
        && let Ok(n) = tail.parse::<i64>()
    {
        return n;
    }
    // FNV-1a 64 → i64：稳定但跨进程 hash 不一致，无所谓。
    let mut h: u64 = 0xcbf29ce484222325;
    for b in item_id.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    (h as i64).abs()
}

fn classify_byok_code(code: &str, message: &str) -> String {
    let blob = format!("{code} {message}").to_ascii_lowercase();
    if blob.contains("401")
        || blob.contains("403")
        || blob.contains("unauthorized")
        || blob.contains("invalidapikey")
        || blob.contains("invalid_api_key")
    {
        return "unauthenticated_byok".into();
    }
    // 优先级：先排音频格式 / 配额，避免 "sample_rate" 被 "rate" 误判成 rate_limited。
    if blob.contains("audio_format")
        || blob.contains("audioformat")
        || blob.contains("sample_rate")
        || blob.contains("samplerate")
        || blob.contains("invalid_audio")
    {
        return "aliyun_invalid_audio_format".into();
    }
    if blob.contains("quota") || blob.contains("insufficient") {
        return "aliyun_quota_exceeded".into();
    }
    if blob.contains("429") || blob.contains("throttl") || blob.contains("ratelimit") {
        return "rate_limited".into();
    }
    if code.is_empty() {
        return "aliyun_unknown".into();
    }
    format!("aliyun_{}", code.to_ascii_lowercase())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn map_invalid_api_key_to_unauthenticated_byok() {
        let ev = AliyunEvent::Error {
            code: "InvalidApiKey".into(),
            message: "鉴权失败".into(),
        };
        match map_aliyun_frame(ev) {
            RealtimeBackendEvent::Error { code, .. } => {
                assert_eq!(code, "unauthenticated_byok");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_throttling_to_rate_limited() {
        let ev = AliyunEvent::Error {
            code: "Throttling".into(),
            message: "QPS exceeded".into(),
        };
        match map_aliyun_frame(ev) {
            RealtimeBackendEvent::Error { code, .. } => assert_eq!(code, "rate_limited"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_invalid_audio_format() {
        let ev = AliyunEvent::Error {
            code: "InvalidAudioFormat".into(),
            message: "sample_rate must be 16000".into(),
        };
        match map_aliyun_frame(ev) {
            RealtimeBackendEvent::Error { code, .. } => {
                assert_eq!(code, "aliyun_invalid_audio_format");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_quota_exceeded() {
        let ev = AliyunEvent::Error {
            code: "QuotaExceeded".into(),
            message: "billing quota used up".into(),
        };
        match map_aliyun_frame(ev) {
            RealtimeBackendEvent::Error { code, .. } => assert_eq!(code, "aliyun_quota_exceeded"),
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_unknown_code_passes_through_with_prefix() {
        let ev = AliyunEvent::Error {
            code: "WeirdSomething".into(),
            message: "oops".into(),
        };
        match map_aliyun_frame(ev) {
            RealtimeBackendEvent::Error { code, message } => {
                assert_eq!(code, "aliyun_weirdsomething");
                assert_eq!(message, "oops");
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_ready_passes_session_id() {
        let ev = AliyunEvent::Ready {
            session_id: Some("sess_abc".into()),
        };
        match map_aliyun_frame(ev) {
            RealtimeBackendEvent::Ready { session_id } => {
                assert_eq!(session_id.as_deref(), Some("sess_abc"));
            }
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn map_partial_and_final_use_consistent_sentence_id() {
        let p = AliyunEvent::Partial {
            item_id: "item_42".into(),
            text: "hi".into(),
        };
        let f = AliyunEvent::Final {
            item_id: "item_42".into(),
            transcript: "hi there".into(),
        };
        let p_id = match map_aliyun_frame(p) {
            RealtimeBackendEvent::Partial { sentence_id, .. } => sentence_id,
            other => panic!("unexpected: {other:?}"),
        };
        let f_id = match map_aliyun_frame(f) {
            RealtimeBackendEvent::Final { sentence_id, .. } => sentence_id,
            other => panic!("unexpected: {other:?}"),
        };
        assert_eq!(p_id, f_id, "same item_id must map to same sentence_id");
        assert_eq!(p_id, 42);
    }

    #[test]
    fn map_end_of_stream() {
        match map_aliyun_frame(AliyunEvent::EndOfStream) {
            RealtimeBackendEvent::EndOfStream => {}
            other => panic!("unexpected: {other:?}"),
        }
    }

    #[test]
    fn hash_item_id_is_stable() {
        assert_eq!(hash_item_id("item_42"), 42);
        // 非 ascii 数字尾巴时退化成 hash 但同输入应等输出
        let a = hash_item_id("weird-id-xx");
        let b = hash_item_id("weird-id-xx");
        assert_eq!(a, b);
        assert_ne!(a, 0);
    }
}
