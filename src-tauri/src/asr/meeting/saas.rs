// SaaS 实时 ASR provider（OpenLoaf 端 OL-TL-RT-003，腾讯上游）。
//
// 计费走 SaaS 积分，鉴权用当前登录用户的 access_token；调用方传入一个已登录
// `SaaSClient` 克隆即可。SDK 0.3.17 的 `RealtimeAsrSession` 是一次性 Session，
// 我们把它适配到 `MeetingSession` trait——发送/拉事件全代理过去。
//
// 引擎选择策略：
//   - SDK 当前版（0.3.17）`RealtimeEvent::Partial`/`Final` 还没暴露 speaker_id
//     字段（changelog 只标了 Node SDK），所以用最便宜的 `16k_zh_en`（8 积分/分钟）
//     避免为拿不到的诊断结果多付钱。capabilities.speaker_diarization=false 与之
//     对齐，UI 会显示"未分离说话人"提示，行为诚实。
//   - 等 SDK 把 speaker_id 拉过来后，引擎切到 `16k_zh_en_speaker`（12 积分/分钟）、
//     capabilities.speaker_diarization=true、map_event 把 speaker_id 透出。

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

pub const SUPPORTED_LANGUAGES: &[&str] = &["zh", "en", "yue"];

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
            speaker_diarization: false,
            supported_languages: SUPPORTED_LANGUAGES,
            max_idle_silence_ms: 60_000,
            recommended_chunk_ms: 100,
            sample_rate: 16_000,
        }
    }

    fn open(
        &self,
        config: MeetingSessionConfig,
    ) -> Result<Box<dyn MeetingSession>, MeetingProviderError> {
        if !SUPPORTED_LANGUAGES.contains(&config.language.as_str()) {
            return Err(MeetingProviderError::Unsupported(format!(
                "language `{}` not supported by SaaS OL-TL-RT-003",
                config.language
            )));
        }

        let params = RealtimeAsrOlTlRt003Params {
            engine_model_type: Some(RealtimeAsrOlTlRt003Engine::Engine16kZhEn),
            voice_format: Some(1),
            needvad: Some(1),
            filter_punc: Some(0),
            convert_num_mode: Some(1),
            ..Default::default()
        };

        let sess = self
            .client
            .tools_v4()
            .realtime_asr_ol_tl_rt_003(&params)
            .map_err(map_open_err)?;
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
        RealtimeEvent::Ready { session_id, .. } => MeetingEvent::Ready {
            session_id: Some(session_id),
        },
        RealtimeEvent::Partial { sentence_id, text } => MeetingEvent::SegmentPartial(MeetingSegment {
            sentence_id,
            speaker_id: -1,
            text,
            start_ms: 0,
            end_ms: 0,
        }),
        RealtimeEvent::Final {
            sentence_id,
            text,
            begin_ms,
            end_ms,
        } => MeetingEvent::SegmentFinal(MeetingSegment {
            sentence_id,
            speaker_id: -1,
            text,
            start_ms: begin_ms.unwrap_or(0).max(0) as u64,
            end_ms: end_ms.unwrap_or(0).max(0) as u64,
        }),
        // Closed 是 SaaS 流的正常终止（finish 后服务端回 Closed）——映射为 EndOfStream。
        RealtimeEvent::Closed { .. } => MeetingEvent::EndOfStream,
        RealtimeEvent::Error { code, message } => MeetingEvent::Error {
            code: classify_saas_code(&code),
            message,
        },
        // Credits 帧不影响识别流程，按 Idle 吞掉（前端不展示 SaaS 余额变化）。
        RealtimeEvent::Credits { .. } => MeetingEvent::Idle,
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
