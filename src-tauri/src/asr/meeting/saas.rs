// SaaS 实时 ASR provider（OpenLoaf 端 OL-TL-RT-003，腾讯上游 16k_zh_en_speaker）。
//
// 走 SDK typed API：`client.tools_v4().realtime_asr_ol_tl_rt_003(&params)` 拿到
// `RealtimeAsrSession`，事件流由 SDK worker 解析成 `RealtimeEvent`。0.3.19 起
// `Partial` / `Final` 都暴露了 `speaker_id: Option<i64>`，会议路径直接消费即可。
//
// 引擎固定 `16k_zh_en_speaker`：腾讯独立 SKU，自带说话人分离 + 中英 + 多方言；
// capabilities.speaker_diarization=true 与之对齐。

use std::time::Duration;

use openloaf_saas::SaaSClient;
use openloaf_saas::SaaSError;
use openloaf_saas::v4_tools::{
    RealtimeAsrOlTlRt003Engine, RealtimeAsrOlTlRt003Params, RealtimeAsrSession, RealtimeEvent,
};

use super::provider::{
    MeetingAsrProvider, MeetingEvent, MeetingProviderCapabilities, MeetingProviderError,
    MeetingSegment, MeetingSession, MeetingSessionConfig,
};

pub const PROVIDER_ID: &str = "saas";
const LOG_TARGET: &str = "openspeech::asr::meeting::saas";

/// 16k_zh_en_speaker 大模型自带中英 + 多方言识别 + 说话人分离。
/// language 字段不传给上游——只用于前端 UI 校验。
pub const SUPPORTED_LANGUAGES: &[&str] = &[
    "zh", "en", "yue", "sc", "sx", "hn", "sh", "xn", "hb", "ah",
];

pub struct SaasMeetingProvider {
    client: SaaSClient,
}

impl SaasMeetingProvider {
    pub fn new(client: SaaSClient) -> Self {
        Self { client }
    }
}

impl MeetingAsrProvider for SaasMeetingProvider {
    fn id(&self) -> &'static str {
        PROVIDER_ID
    }

    fn capabilities(&self) -> MeetingProviderCapabilities {
        MeetingProviderCapabilities {
            speaker_diarization: true,
            supported_languages: SUPPORTED_LANGUAGES,
            // OL-TL-RT-003 服务端 60s 无音频帧主动断开（idle_timeout）。
            max_idle_silence_ms: 60_000,
            recommended_chunk_ms: 100,
            sample_rate: 16_000,
        }
    }

    fn open(
        &self,
        config: MeetingSessionConfig,
    ) -> Result<Box<dyn MeetingSession>, MeetingProviderError> {
        if !config.enable_diarization {
            return Err(MeetingProviderError::Unsupported(
                "saas RT-003 16k_zh_en_speaker always returns speakerId; \
                 set enable_diarization=true"
                    .into(),
            ));
        }
        if !SUPPORTED_LANGUAGES.contains(&config.language.as_str()) {
            return Err(MeetingProviderError::Unsupported(format!(
                "language `{}` not supported by SaaS RT-003 16k_zh_en_speaker",
                config.language
            )));
        }

        let params = RealtimeAsrOlTlRt003Params {
            engine_model_type: Some(RealtimeAsrOlTlRt003Engine::Engine16kZhEnSpeaker),
            voice_format: Some(1),
            needvad: Some(1),
            convert_num_mode: Some(1),
            ..Default::default()
        };

        log::info!(
            target: LOG_TARGET,
            "[open] variant=OL-TL-RT-003 engine=16k_zh_en_speaker lang={} diarization={} token_present={}",
            config.language,
            config.enable_diarization,
            self.client.access_token().is_some(),
        );
        let sess = self
            .client
            .tools_v4()
            .realtime_asr_ol_tl_rt_003(&params)
            .map_err(|e| {
                log::warn!(target: LOG_TARGET, "[open] connect failed: {e}");
                map_open_err(e)
            })?;
        log::info!(target: LOG_TARGET, "[open] WebSocket connected, awaiting Ready");
        Ok(Box::new(SaasMeetingSession::new(sess)))
    }
}

fn map_open_err(e: SaaSError) -> MeetingProviderError {
    let raw = e.to_string();
    if is_unauthorized(&raw) {
        MeetingProviderError::Unauthenticated(raw)
    } else {
        MeetingProviderError::Network(raw)
    }
}

fn is_unauthorized(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("401") || l.contains("unauthorized") || l.contains("unauthenticated")
}

struct SaasMeetingSession {
    sess: RealtimeAsrSession,
}

impl SaasMeetingSession {
    fn new(sess: RealtimeAsrSession) -> Self {
        Self { sess }
    }
}

impl MeetingSession for SaasMeetingSession {
    fn send_audio(&mut self, pcm16: Vec<u8>) -> Result<(), String> {
        self.sess.send_audio(pcm16).map_err(|e| e.to_string())
    }

    fn finish(&mut self) -> Result<(), String> {
        self.sess.finish().map_err(|e| e.to_string())
    }

    fn next_event(&mut self, dur: Duration) -> MeetingEvent {
        match self.sess.next_event_timeout(dur) {
            Ok(Some(ev)) => map_event(ev),
            Ok(None) => MeetingEvent::Idle,
            Err(SaaSError::Network(msg)) => MeetingEvent::NetworkExit(msg),
            Err(e @ SaaSError::Decode(_)) => MeetingEvent::DecodeRecoverable(e.to_string()),
            Err(e) => MeetingEvent::Error {
                code: classify_saas_err(&e),
                message: e.to_string(),
            },
        }
    }
}

fn map_event(ev: RealtimeEvent) -> MeetingEvent {
    match ev {
        RealtimeEvent::Ready { session_id, .. } => {
            log::info!(target: LOG_TARGET, "[ready] session_id={session_id}");
            MeetingEvent::Ready {
                session_id: Some(session_id),
            }
        }
        RealtimeEvent::Partial {
            sentence_id,
            text,
            speaker_id,
            ..
        } => {
            // partial 流量大，用 debug；speaker_id 出现在 partial 上是 16k_zh_en_speaker 工作中的标志。
            log::debug!(
                target: LOG_TARGET,
                "[partial] sid={sentence_id} speaker={:?} text={}B",
                speaker_id,
                text.len()
            );
            MeetingEvent::SegmentPartial(MeetingSegment {
                sentence_id,
                speaker_id: speaker_id_to_i32(speaker_id),
                text,
                start_ms: 0,
                end_ms: 0,
            })
        }
        RealtimeEvent::Final {
            sentence_id,
            text,
            begin_ms,
            end_ms,
            speaker_id,
            ..
        } => {
            log::info!(
                target: LOG_TARGET,
                "[final] sid={sentence_id} speaker={:?} begin_ms={:?} end_ms={:?} text={:?}",
                speaker_id,
                begin_ms,
                end_ms,
                text,
            );
            MeetingEvent::SegmentFinal(MeetingSegment {
                sentence_id,
                speaker_id: speaker_id_to_i32(speaker_id),
                text,
                start_ms: begin_ms.unwrap_or(0).max(0) as u64,
                end_ms: end_ms.unwrap_or(0).max(0) as u64,
            })
        }
        // Closed 是 SaaS 流的正常终止（finish 后服务端回 Closed）——映射为 EndOfStream。
        RealtimeEvent::Closed { reason, total_seconds, total_credits, .. } => {
            log::info!(
                target: LOG_TARGET,
                "[closed] reason={reason} total_seconds={total_seconds:?} total_credits={total_credits:?}"
            );
            MeetingEvent::EndOfStream
        }
        RealtimeEvent::Error { code, message } => {
            log::warn!(target: LOG_TARGET, "[error] code={code} message={message}");
            MeetingEvent::Error {
                code: classify_saas_code(&code),
                message,
            }
        }
        // Credits 帧不影响识别流程，按 Idle 吞掉（前端不展示 SaaS 余额变化）。
        RealtimeEvent::Credits { consumed_seconds, remaining_credits, .. } => {
            log::debug!(
                target: LOG_TARGET,
                "[credits] consumed_seconds={consumed_seconds:?} remaining={remaining_credits:?}"
            );
            MeetingEvent::Idle
        }
    }
}

/// SDK 用 `Option<i64>`：None = vendor 未发（其他 engine）；i64 = 实际 cluster id。
/// 我们的 `MeetingSegment::speaker_id` 是 i32，约定 -1 = 待识别 / 无诊断。
fn speaker_id_to_i32(v: Option<i64>) -> i32 {
    match v {
        Some(n) if n >= 0 && n <= i32::MAX as i64 => n as i32,
        _ => -1,
    }
}

fn classify_saas_err(e: &SaaSError) -> String {
    let raw = e.to_string();
    if is_unauthorized(&raw) {
        "unauthenticated_saas".into()
    } else {
        "saas_error".into()
    }
}

fn classify_saas_code(code: &str) -> String {
    match code {
        "auth_failure" => "unauthenticated_saas".into(),
        "insufficient_credits" => "insufficient_funds_saas".into(),
        "idle_timeout" => "idle_timeout".into(),
        "max_duration" => "max_duration".into(),
        "upstream_error" => "upstream_error".into(),
        other => format!("saas_{other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn speaker_id_negative_or_none_becomes_minus_one() {
        assert_eq!(speaker_id_to_i32(None), -1);
        assert_eq!(speaker_id_to_i32(Some(-5)), -1);
    }

    #[test]
    fn speaker_id_positive_passes_through() {
        assert_eq!(speaker_id_to_i32(Some(0)), 0);
        assert_eq!(speaker_id_to_i32(Some(7)), 7);
    }

    #[test]
    fn speaker_id_overflow_falls_back() {
        assert_eq!(speaker_id_to_i32(Some(i64::MAX)), -1);
    }

    // 端到端：模拟服务端 wire JSON → SDK deserialize → 我们的 map_event。
    // 任何一环对字段名 / 类型理解不一致都会被这组测试逮到。

    #[test]
    fn sdk_deserializes_partial_with_speaker_id() {
        let raw = r#"{"type":"partial","sentenceId":3,"text":"你好","speakerId":1}"#;
        let ev: RealtimeEvent = serde_json::from_str(raw).expect("partial deserialize");
        match map_event(ev) {
            MeetingEvent::SegmentPartial(s) => {
                assert_eq!(s.sentence_id, 3);
                assert_eq!(s.speaker_id, 1, "speaker_id must propagate end-to-end");
                assert_eq!(s.text, "你好");
            }
            other => panic!("expected SegmentPartial, got {other:?}"),
        }
    }

    #[test]
    fn sdk_deserializes_final_with_speaker_and_timing() {
        let raw = r#"{"type":"final","sentenceId":4,"text":"再见","beginMs":1000,"endMs":2200,"speakerId":0}"#;
        let ev: RealtimeEvent = serde_json::from_str(raw).expect("final deserialize");
        match map_event(ev) {
            MeetingEvent::SegmentFinal(s) => {
                assert_eq!(s.sentence_id, 4);
                assert_eq!(s.speaker_id, 0);
                assert_eq!(s.start_ms, 1000);
                assert_eq!(s.end_ms, 2200);
            }
            other => panic!("expected SegmentFinal, got {other:?}"),
        }
    }

    #[test]
    fn sdk_serializes_params_as_snake_case_with_speaker_engine() {
        let p = RealtimeAsrOlTlRt003Params {
            engine_model_type: Some(RealtimeAsrOlTlRt003Engine::Engine16kZhEnSpeaker),
            voice_format: Some(1),
            needvad: Some(1),
            convert_num_mode: Some(1),
            ..Default::default()
        };
        let s = serde_json::to_string(&p).unwrap();
        // 防止以后 SDK 加 rename_all 改驼峰、或者把枚举别名改了，把腾讯那边
        // engine 名拼错——服务端默认会 fallback 到 16k_zh，没有诊断结果。
        assert!(s.contains("\"engine_model_type\":\"16k_zh_en_speaker\""), "params={s}");
        assert!(s.contains("\"voice_format\":1"));
        assert!(s.contains("\"needvad\":1"));
    }

    #[test]
    fn sdk_deserializes_partial_without_speaker_defaults_to_unknown() {
        let raw = r#"{"type":"partial","sentenceId":1,"text":"hi"}"#;
        let ev: RealtimeEvent = serde_json::from_str(raw).unwrap();
        match map_event(ev) {
            MeetingEvent::SegmentPartial(s) => assert_eq!(s.speaker_id, -1),
            other => panic!("expected SegmentPartial, got {other:?}"),
        }
    }
}
