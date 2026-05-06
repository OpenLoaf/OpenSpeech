// 会议会话编排器（vendor-neutral）。
//
// 职责：
//   1) 持有当前会议会话状态（None / Active / Paused）
//   2) 调 vendor 实现的 `MeetingAsrProvider::open()` 拿 session
//   3) 把外部喂进来的 PCM16 帧转发给 session
//   4) 在 worker 线程里轮询 session.next_event，把每条事件转成前端 emit
//   5) 暴露 invoke：start / pause / resume / stop / feed_pcm
//
// 与 dictation (`stt::*`) 故意完全分离：
//   - dictation 是短录音 + 一次只能一条；meetings 是长录音、可暂停 / 续接
//   - 事件结构不同（带 speaker_id + 时间戳）
//   - 录音文件、history 行的 type、segments 表都不一样
//
// 后续接 cpal：在 audio/mod.rs 的 push_to_stt_pcm16 旁边再加一行 fanout 到这里
// （`crate::meetings::try_send_audio_pcm16`），保持 dictation 主路径不被打扰。

use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Runtime};

use crate::asr::byok::{
    DictationBackend, DictationModality, ProviderRef, dispatch as dispatch_dictation_backend,
};
use crate::asr::meeting::tencent_speaker::TencentSpeakerProvider;
use crate::asr::meeting::{
    MeetingAsrProvider, MeetingEvent, MeetingProviderError, MeetingSession, MeetingSessionConfig,
};

/// 前端订阅的事件名。
pub const EVENT_READY: &str = "meetings://ready";
pub const EVENT_PARTIAL: &str = "meetings://segment-partial";
pub const EVENT_FINAL: &str = "meetings://segment-final";
pub const EVENT_ERROR: &str = "meetings://error";
pub const EVENT_END: &str = "meetings://ended";
pub const EVENT_STATUS: &str = "meetings://status";

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum MeetingStatus {
    Idle,
    Active,
    Paused,
    Stopped,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReadyPayload {
    pub meeting_id: String,
    pub session_id: Option<String>,
    pub provider: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SegmentPayload {
    pub meeting_id: String,
    pub sentence_id: i64,
    pub speaker_id: i32,
    pub text: String,
    pub start_ms: u64,
    pub end_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ErrorPayload {
    pub meeting_id: String,
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct StatusPayload {
    pub meeting_id: String,
    pub status: MeetingStatus,
    /// 会话已运行时长（自 start 起，不含 pause 区间）。
    pub elapsed_ms: u64,
}

/// 全局活动会议状态。一次只允许一场会议——MVP 不做多会议并行。
struct ActiveMeeting {
    meeting_id: String,
    #[allow(dead_code)]
    provider_id: String,
    session: Box<dyn MeetingSession>,
    worker: Option<JoinHandle<()>>,
    started_at: Instant,
    /// 累计运行毫秒（包含历史 pause 区间之间的活动时间）。
    elapsed_baseline_ms: u64,
    /// 是否处于暂停态：暂停时 send_audio 走 noop，事件轮询继续运行。
    paused: bool,
}

fn active_slot() -> &'static Mutex<Option<ActiveMeeting>> {
    static SLOT: OnceLock<Mutex<Option<ActiveMeeting>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

// ---------- Provider 选择 ----------
//
// 凭证完全复用"听写通道"配置——前端把 ProviderRef 透传过来，dispatch() 解出
// `DictationBackend::TencentRealtime { app_id, secret_id, secret_key, ... }` 即可
// 直接喂 TencentSpeakerProvider。这样用户在设置里改一处，听写 / 会议同时生效。
//
// 不支持的组合（SaaS / Aliyun / 未配置）一律明确报错——会议必须用支持
// speaker_diarization 的 vendor，不做隐式 fallback。

const ERR_MEETING_PROVIDER_UNSUPPORTED: &str = "meeting_provider_unsupported";
const ERR_MEETING_PROVIDER_NOT_CONFIGURED: &str = "meeting_provider_not_configured";

fn build_provider(
    provider: &ProviderRef,
) -> Result<Box<dyn MeetingAsrProvider>, MeetingProviderError> {
    let backend = dispatch_dictation_backend(provider, DictationModality::Realtime).map_err(
        |e| MeetingProviderError::Unauthenticated(format!("{ERR_MEETING_PROVIDER_NOT_CONFIGURED}: {e}")),
    )?;
    match backend {
        DictationBackend::TencentRealtime {
            app_id,
            secret_id,
            secret_key,
            ..
        } => Ok(Box::new(TencentSpeakerProvider::new(
            app_id, secret_id, secret_key,
        ))),
        // SaaS / Aliyun / TencentFile 都不支持实时说话人分离，前端按错误码引导用户切到 Tencent BYOK。
        other => Err(MeetingProviderError::Unsupported(format!(
            "{ERR_MEETING_PROVIDER_UNSUPPORTED}: {}",
            crate::asr::byok::provider_kind_str(&other)
        ))),
    }
}

/// 当前是否有活动会议——audio fanout 用来短路克隆。
pub fn has_active() -> bool {
    active_slot().try_lock().map(|g| g.is_some()).unwrap_or(false)
}

// ---------- Invoke 命令 ----------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartArgs {
    pub meeting_id: String,
    /// 语种代码（"zh" / "en" / "yue" / ...）。
    pub language: String,
    /// 直接复用听写通道的 ProviderRef（mode + 自定义 provider id + tencentAppId 等）。
    pub provider: ProviderRef,
}

#[tauri::command]
pub async fn meeting_start<R: Runtime>(
    app: AppHandle<R>,
    args: StartArgs,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || meeting_start_impl(app, args))
        .await
        .map_err(|e| format!("meeting_start join: {e}"))?
}

fn meeting_start_impl<R: Runtime>(app: AppHandle<R>, args: StartArgs) -> Result<(), String> {
    {
        let slot = active_slot().lock().map_err(|e| e.to_string())?;
        if slot.is_some() {
            return Err("another meeting is already active".into());
        }
    }

    let provider = build_provider(&args.provider).map_err(|e| e.to_string())?;
    let provider_id = provider.id().to_string();
    let mut session = provider
        .open(MeetingSessionConfig {
            language: args.language.clone(),
            sample_rate: 16_000,
            enable_diarization: true,
        })
        .map_err(|e| e.to_string())?;

    // 等握手 Ready 事件（最多 8 秒），握手失败直接返回错误，不开 worker。
    let mut session_id: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match session.next_event(Duration::from_millis(200)) {
            MeetingEvent::Ready { session_id: sid } => {
                session_id = sid;
                break;
            }
            MeetingEvent::Error { code, message } => {
                return Err(format!("{code}: {message}"));
            }
            MeetingEvent::NetworkExit(m) => return Err(format!("network: {m}")),
            MeetingEvent::Idle => continue,
            other => log::debug!("[meetings] pre-ready event: {other:?}"),
        }
    }

    let _ = app.emit(
        EVENT_READY,
        ReadyPayload {
            meeting_id: args.meeting_id.clone(),
            session_id,
            provider: provider_id.clone(),
        },
    );

    // worker：把 session 的事件 emit 到前端。session 此时已经在 active slot 里，
    // worker 拿不到所有权——所以我们用一个独立的 channel：worker 借助一个
    // 共享的 Mutex 拉 next_event。
    let active = ActiveMeeting {
        meeting_id: args.meeting_id.clone(),
        provider_id,
        session,
        worker: None,
        started_at: Instant::now(),
        elapsed_baseline_ms: 0,
        paused: false,
    };
    {
        let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
        *slot = Some(active);
    }

    let app_for_worker = app.clone();
    let meeting_id_for_worker = args.meeting_id.clone();
    let handle = thread::Builder::new()
        .name("openspeech-meetings".into())
        .spawn(move || event_pump(app_for_worker, meeting_id_for_worker))
        .map_err(|e| format!("spawn meetings worker: {e}"))?;

    {
        let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
        if let Some(a) = slot.as_mut() {
            a.worker = Some(handle);
        }
    }

    let _ = app.emit(
        EVENT_STATUS,
        StatusPayload {
            meeting_id: args.meeting_id,
            status: MeetingStatus::Active,
            elapsed_ms: 0,
        },
    );

    Ok(())
}

/// audio callback / 测试代码喂 PCM16 LE 帧的入口。无激活会议时无 op。
/// 暂停态时丢帧（不是错误，前端 pause 后 cpal 仍在跑），避免污染识别。
pub fn try_send_audio_pcm16(pcm16: Vec<u8>) {
    let Ok(mut slot) = active_slot().try_lock() else {
        return;
    };
    let Some(a) = slot.as_mut() else { return };
    if a.paused {
        return;
    }
    if let Err(e) = a.session.send_audio(pcm16) {
        log::warn!("[meetings] send_audio failed: {e}");
    }
}

#[tauri::command]
pub fn meeting_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
    let a = slot.as_mut().ok_or("no active meeting")?;
    if !a.paused {
        a.paused = true;
        // 累计已运行的时间作为 baseline，下一次 resume 重新计时。
        a.elapsed_baseline_ms += a.started_at.elapsed().as_millis() as u64;
    }
    let payload = StatusPayload {
        meeting_id: a.meeting_id.clone(),
        status: MeetingStatus::Paused,
        elapsed_ms: a.elapsed_baseline_ms,
    };
    drop(slot);
    let _ = app.emit(EVENT_STATUS, payload);
    Ok(())
}

#[tauri::command]
pub fn meeting_resume<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
    let a = slot.as_mut().ok_or("no active meeting")?;
    if a.paused {
        a.paused = false;
        a.started_at = Instant::now();
    }
    let payload = StatusPayload {
        meeting_id: a.meeting_id.clone(),
        status: MeetingStatus::Active,
        elapsed_ms: a.elapsed_baseline_ms,
    };
    drop(slot);
    let _ = app.emit(EVENT_STATUS, payload);
    Ok(())
}

#[tauri::command]
pub async fn meeting_stop<R: Runtime>(app: AppHandle<R>) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || meeting_stop_impl(app))
        .await
        .map_err(|e| format!("meeting_stop join: {e}"))?
}

fn meeting_stop_impl<R: Runtime>(app: AppHandle<R>) -> Result<u64, String> {
    let (worker_handle, meeting_id, total_ms) = {
        let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
        let mut a = slot.take().ok_or("no active meeting")?;
        let _ = a.session.finish();
        let total_ms = a.elapsed_baseline_ms
            + if a.paused { 0 } else { a.started_at.elapsed().as_millis() as u64 };
        (a.worker.take(), a.meeting_id, total_ms)
    };

    if let Some(h) = worker_handle {
        // worker 会在拿到 EndOfStream / NetworkExit 后自然退出；这里 join 兜底
        let _ = h.join();
    }

    let _ = app.emit(
        EVENT_STATUS,
        StatusPayload {
            meeting_id: meeting_id.clone(),
            status: MeetingStatus::Stopped,
            elapsed_ms: total_ms,
        },
    );
    let _ = app.emit(EVENT_END, meeting_id);
    Ok(total_ms)
}

// ---------- Worker：把 vendor 事件转成前端 emit ----------

fn event_pump<R: Runtime>(app: AppHandle<R>, meeting_id: String) {
    loop {
        let ev = {
            let Ok(mut slot) = active_slot().lock() else {
                return;
            };
            let Some(a) = slot.as_mut() else { return };
            a.session.next_event(Duration::from_millis(200))
        };
        match ev {
            MeetingEvent::SegmentPartial(s) => {
                let _ = app.emit(
                    EVENT_PARTIAL,
                    SegmentPayload {
                        meeting_id: meeting_id.clone(),
                        sentence_id: s.sentence_id,
                        speaker_id: s.speaker_id,
                        text: s.text,
                        start_ms: s.start_ms,
                        end_ms: s.end_ms,
                    },
                );
            }
            MeetingEvent::SegmentFinal(s) => {
                let _ = app.emit(
                    EVENT_FINAL,
                    SegmentPayload {
                        meeting_id: meeting_id.clone(),
                        sentence_id: s.sentence_id,
                        speaker_id: s.speaker_id,
                        text: s.text,
                        start_ms: s.start_ms,
                        end_ms: s.end_ms,
                    },
                );
            }
            MeetingEvent::Error { code, message } => {
                let _ = app.emit(
                    EVENT_ERROR,
                    ErrorPayload {
                        meeting_id: meeting_id.clone(),
                        code,
                        message,
                    },
                );
                return;
            }
            MeetingEvent::NetworkExit(m) => {
                let _ = app.emit(
                    EVENT_ERROR,
                    ErrorPayload {
                        meeting_id: meeting_id.clone(),
                        code: "network_exit".into(),
                        message: m,
                    },
                );
                return;
            }
            MeetingEvent::EndOfStream => {
                let _ = app.emit(EVENT_END, meeting_id.clone());
                return;
            }
            MeetingEvent::Ready { .. } => {} // 二次 Ready 极少见，忽略
            MeetingEvent::DecodeRecoverable(m) => {
                log::warn!("[meetings] decode recoverable: {m}");
            }
            MeetingEvent::Idle => {
                // 没事件 —— 检查 slot 是否还在。
                let Ok(slot) = active_slot().lock() else {
                    return;
                };
                if slot.as_ref().map(|a| a.meeting_id != meeting_id).unwrap_or(true) {
                    return;
                }
            }
        }
    }
}
