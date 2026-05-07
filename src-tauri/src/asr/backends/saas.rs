// SaaS 实时 ASR backend：把 SDK 的 RealtimeAsrSession 适配到 RealtimeAsrBackend trait。
//
// 协议路径：OL-TL-RT-002（Qwen3-ASR-Flash-Realtime），与之前 stt/mod.rs 直接持有
// `RealtimeAsrSession` 的行为完全一致——仅事件壳从 SDK 的 `RealtimeEvent` 映射成
// 抽象的 `RealtimeBackendEvent`。

use std::time::Duration;

use openloaf_saas::SaaSError;
use openloaf_saas::v4_tools::{RealtimeAsrSession, RealtimeEvent};

use crate::asr::realtime_backend::{RealtimeAsrBackend, RealtimeBackendEvent};

pub struct SaasRealtimeBackend {
    sess: RealtimeAsrSession,
}

impl SaasRealtimeBackend {
    pub fn new(sess: RealtimeAsrSession) -> Self {
        Self { sess }
    }
}

impl RealtimeAsrBackend for SaasRealtimeBackend {
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String> {
        self.sess.send_audio(pcm16).map_err(|e| e.to_string())
    }

    fn finish(&mut self) -> Result<(), String> {
        self.sess.finish().map_err(|e| e.to_string())
    }

    fn next_event_timeout(&mut self, dur: Duration) -> RealtimeBackendEvent {
        match self.sess.next_event_timeout(dur) {
            Ok(Some(ev)) => map_saas_event(ev),
            Ok(None) => RealtimeBackendEvent::Idle,
            Err(SaaSError::Network(msg)) => RealtimeBackendEvent::NetworkExit(msg),
            Err(e @ SaaSError::Decode(_)) => RealtimeBackendEvent::DecodeRecoverable(e.to_string()),
            // HTTP / Input 类等 transient 错误：与 stt/mod.rs 旧行为一致，按可恢复处理。
            Err(e) => RealtimeBackendEvent::DecodeRecoverable(e.to_string()),
        }
    }
}

fn map_saas_event(ev: RealtimeEvent) -> RealtimeBackendEvent {
    match ev {
        RealtimeEvent::Ready { session_id, .. } => RealtimeBackendEvent::Ready {
            session_id: Some(session_id),
        },
        RealtimeEvent::Partial { sentence_id, text, .. } => RealtimeBackendEvent::Partial {
            sentence_id,
            text,
        },
        RealtimeEvent::Final {
            sentence_id, text, ..
        } => RealtimeBackendEvent::Final { sentence_id, text },
        RealtimeEvent::Credits {
            remaining_credits, ..
        } => RealtimeBackendEvent::Credits { remaining_credits },
        RealtimeEvent::Closed {
            reason,
            total_credits,
            ..
        } => RealtimeBackendEvent::Closed {
            reason,
            total_credits,
        },
        RealtimeEvent::Error { code, message } => RealtimeBackendEvent::Error { code, message },
    }
}

