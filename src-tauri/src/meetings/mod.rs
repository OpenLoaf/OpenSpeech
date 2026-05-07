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

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender, TryRecvError};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::asr::byok::{
    DictationBackend, DictationModality, ProviderRef, dispatch as dispatch_dictation_backend,
};
use crate::asr::meeting::saas::SaasMeetingProvider;
use crate::asr::meeting::tencent_speaker::TencentSpeakerProvider;
use crate::asr::meeting::{
    MeetingAsrProvider, MeetingEvent, MeetingSession, MeetingSessionConfig,
};
use crate::audio::is_valid_date_segment;
use crate::db;
use crate::openloaf::{DEFAULT_BASE_URL, SharedOpenLoaf, handle_session_expired};

/// 前端订阅的事件名。
pub const EVENT_READY: &str = "meetings://ready";
pub const EVENT_PARTIAL: &str = "meetings://segment-partial";
pub const EVENT_FINAL: &str = "meetings://segment-final";
pub const EVENT_ERROR: &str = "meetings://error";
pub const EVENT_END: &str = "meetings://ended";
pub const EVENT_STATUS: &str = "meetings://status";
pub const EVENT_RECONNECTING: &str = "meetings://reconnecting";

/// 网络抖动时 vendor session 退出，worker 自动重连最多这么多次后放弃。
const RECONNECT_MAX_ATTEMPTS: u32 = 5;
/// 重连间隔的指数退避基准；实际延时 = base * 2^attempt，最大 RECONNECT_BACKOFF_CAP。
const RECONNECT_BACKOFF_BASE: Duration = Duration::from_millis(500);
const RECONNECT_BACKOFF_CAP: Duration = Duration::from_secs(8);

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReconnectPhase {
    /// vendor session 刚退出，worker 在等 backoff。
    Backoff,
    /// 正在尝试新一次握手。
    Connecting,
    /// 重连成功、新 session 已 Ready；UI 据此撤掉提示。
    Recovered,
    /// 达到上限放弃，worker 已退出（前端会同时收到 ended/error）。
    GaveUp,
}

#[derive(Debug, Clone, Serialize)]
pub struct ReconnectPayload {
    pub meeting_id: String,
    pub phase: ReconnectPhase,
    /// 已尝试次数（首次 NetworkExit 后第一次重连为 1）。
    pub attempt: u32,
    pub max_attempts: u32,
    /// 上次错误的可读消息——给 UI 选择性展示。
    pub reason: String,
}

/// 全局活动会议状态。一次只允许一场会议——MVP 不做多会议并行。
///
/// session 的所有权交给 worker 线程独占（详见 `event_pump`）：上一版让 worker
/// 持全局锁等 next_event，audio fanout 的 try_lock 在 200ms 窗口内全部失败，
/// 真实场景下连一帧 PCM 都送不到，握手成功 15s 后必触发腾讯 4008。
struct ActiveMeeting {
    meeting_id: String,
    #[allow(dead_code)]
    provider_id: String,
    audio_tx: Sender<Vec<u8>>,
    paused: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
    started_at: Instant,
    /// 累计运行毫秒（包含历史 pause 区间之间的活动时间）。
    elapsed_baseline_ms: u64,
}

fn active_slot() -> &'static Mutex<Option<ActiveMeeting>> {
    static SLOT: OnceLock<Mutex<Option<ActiveMeeting>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

// ---------- Provider 选择 ----------
//
// 凭证完全复用"听写通道"配置——前端把 ProviderRef 透传过来，dispatch() 解出
// `DictationBackend::*` 后按下表挑出对应的 `MeetingAsrProvider` 实现：
//
//   SaasRealtime          → SaasMeetingProvider  （SaaS 端 OL-TL-RT-003）
//   TencentRealtime{...}  → TencentSpeakerProvider（用户自带腾讯 16k_zh_en_speaker）
//
// 后续接入阿里 / Google 等 vendor 时，照这个表加一行——provider 子模块、
// dispatch、build_provider 三处 plug 进去即可，不动外层编排逻辑。
//
// SaaS 分支需要拿登录态的 `SaaSClient`，所以这里要 AppHandle 取 SharedOpenLoaf。
// 未登录 / 不支持的组合（Aliyun 自带）一律明确报错，不做隐式 fallback。

const ERR_MEETING_PROVIDER_UNSUPPORTED: &str = "meeting_provider_unsupported";
const ERR_MEETING_PROVIDER_NOT_CONFIGURED: &str = "meeting_provider_not_configured";
const ERR_NOT_AUTHENTICATED: &str = "not_authenticated";

// 直接返回 `<i18n_code>: <msg>` 字符串而不过 MeetingProviderError——
// 后者 Display 会再加一层 "unsupported:" / "unauthenticated:" 前缀，导致前端
// 按 `^[a-z_]+:` 解析时把分类名当成了 code，i18n 无法命中。
fn build_provider<R: Runtime>(
    app: &AppHandle<R>,
    provider: &ProviderRef,
) -> Result<Arc<dyn MeetingAsrProvider>, String> {
    let backend = dispatch_dictation_backend(provider, DictationModality::Realtime)
        .map_err(|e| format!("{ERR_MEETING_PROVIDER_NOT_CONFIGURED}: {e}"))?;
    match backend {
        DictationBackend::SaasRealtime => {
            let ol = app.state::<SharedOpenLoaf>();
            let client = ol.authenticated_client().ok_or_else(|| {
                // 与 stt / transcribe / ai_refine 对齐：SaaS 直连失败统一走全局清场，
                // 前端 auth store 监听 auth-lost 后切未登录 + 弹登录框。
                handle_session_expired(app, &ol);
                // 带 `<code>: <msg>` 让前端 stores/meetings.ts 的正则命中 code，
                // i18n errors:meetings.not_authenticated{,_hint} 才能渲染。
                format!("{ERR_NOT_AUTHENTICATED}: SaaS not authenticated")
            })?;
            Ok(Arc::new(SaasMeetingProvider::new(client, DEFAULT_BASE_URL)))
        }
        DictationBackend::TencentRealtime {
            app_id,
            secret_id,
            secret_key,
            ..
        } => Ok(Arc::new(TencentSpeakerProvider::new(
            app_id, secret_id, secret_key,
        ))),
        other => Err(format!(
            "{ERR_MEETING_PROVIDER_UNSUPPORTED}: {}",
            crate::asr::byok::provider_kind_str(&other)
        )),
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
    // 自愈：dev HMR / 错误路径 / 弹窗关闭都可能让前端 store 回到 idle，但后端
    // active_slot 还留着上一场——上一版直接报 "another meeting is already active"
    // 死路一条，用户必须重启 app。这里把 stale slot 直接 take 掉：drop 后旧的
    // audio_tx 关闭，旧 worker 在 try_recv 看到 Disconnected → finish session 自退。
    // 不 join 旧 worker（它最长要 15s 兜底超时），让它在后台 detached 收尾。
    {
        let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
        if let Some(stale) = slot.take() {
            log::warn!(
                "[meetings] dropping stale active meeting {} before starting a new one",
                stale.meeting_id
            );
        }
    }

    let provider = build_provider(&app, &args.provider)?;
    let provider_id = provider.id().to_string();
    let session_config = MeetingSessionConfig {
        language: args.language.clone(),
        sample_rate: 16_000,
        enable_diarization: true,
    };
    let mut session = provider
        .open(session_config.clone())
        .map_err(|e| e.to_string())?;

    // 等握手 Ready 事件（最多 8 秒），握手失败直接返回错误，不开 worker。
    let mut got_ready = false;
    let mut session_id: Option<String> = None;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match session.next_event(Duration::from_millis(200)) {
            MeetingEvent::Ready { session_id: sid } => {
                session_id = sid;
                got_ready = true;
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
    if !got_ready {
        return Err("handshake timeout: no Ready within 8s".into());
    }

    let _ = app.emit(
        EVENT_READY,
        ReadyPayload {
            meeting_id: args.meeting_id.clone(),
            session_id,
            provider: provider_id.clone(),
        },
    );

    let paused = Arc::new(AtomicBool::new(false));
    let (audio_tx, audio_rx) = mpsc::channel::<Vec<u8>>();

    let app_for_worker = app.clone();
    let meeting_id_for_worker = args.meeting_id.clone();
    let paused_for_worker = paused.clone();
    let provider_for_worker = provider.clone();
    let handle = thread::Builder::new()
        .name("openspeech-meetings".into())
        .spawn(move || {
            event_pump(
                app_for_worker,
                meeting_id_for_worker,
                session,
                audio_rx,
                paused_for_worker,
                provider_for_worker,
                session_config,
            )
        })
        .map_err(|e| format!("spawn meetings worker: {e}"))?;

    {
        let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
        *slot = Some(ActiveMeeting {
            meeting_id: args.meeting_id.clone(),
            provider_id,
            audio_tx,
            paused,
            worker: Some(handle),
            started_at: Instant::now(),
            elapsed_baseline_ms: 0,
        });
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
/// 锁内只 clone Sender 句柄 + 读 atomic，零阻塞：worker 不再共享这把锁。
pub fn try_send_audio_pcm16(pcm16: Vec<u8>) {
    let Ok(slot) = active_slot().try_lock() else {
        return;
    };
    let Some(a) = slot.as_ref() else { return };
    if a.paused.load(Ordering::Relaxed) {
        return;
    }
    let _ = a.audio_tx.send(pcm16);
}

#[tauri::command]
pub fn meeting_pause<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
    let a = slot.as_mut().ok_or("no active meeting")?;
    if !a.paused.load(Ordering::Relaxed) {
        a.paused.store(true, Ordering::Relaxed);
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
    if a.paused.load(Ordering::Relaxed) {
        a.paused.store(false, Ordering::Relaxed);
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
        let total_ms = a.elapsed_baseline_ms
            + if a.paused.load(Ordering::Relaxed) {
                0
            } else {
                a.started_at.elapsed().as_millis() as u64
            };
        // drop a → drop audio_tx → worker 在 try_recv 拿到 Disconnected 后调 session.finish()
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
//
// 单线程独占 session：从 audio_rx 排空所有待发音频帧，再短超时拉一个事件 emit。
// 不持全局锁——audio fanout 的 try_lock 现在永远拿得到。
//
// NetworkExit 时进入 reconnect 流程（最多 RECONNECT_MAX_ATTEMPTS 次）：
//   1) 把当前 session drop 掉
//   2) 累计 sentence_id_offset / time_offset_ms，避免新 session 时间戳与前段重叠
//   3) backoff 指数退避 → provider.open() 重新握手
//   4) 等到 Ready 后回到主循环，audio_rx 期间堆积的帧丢弃（追不上的时间，gap 也没识别价值）
//
// vendor 协议层 Error（鉴权 / 引擎未授权）一律不重连，它们大概率是配置错误。
fn event_pump<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    mut session: Box<dyn MeetingSession>,
    audio_rx: Receiver<Vec<u8>>,
    paused: Arc<AtomicBool>,
    provider: Arc<dyn MeetingAsrProvider>,
    config: MeetingSessionConfig,
) {
    let mut sentence_id_offset: i64 = 0;
    let mut time_offset_ms: u64 = 0;
    // 当前 session 见过的最大 sentence_id / end_ms，用来在 reconnect 时累加 offset。
    let mut max_sid_in_session: i64 = -1;
    let mut max_end_ms_in_session: u64 = 0;
    let mut reconnect_attempts: u32 = 0;

    loop {
        let exit = run_session(
            &app,
            &meeting_id,
            &mut session,
            &audio_rx,
            &paused,
            sentence_id_offset,
            time_offset_ms,
            &mut max_sid_in_session,
            &mut max_end_ms_in_session,
        );

        match exit {
            SessionExit::EndOfStream => {
                let _ = app.emit(EVENT_END, meeting_id.clone());
                return;
            }
            SessionExit::Error { code, message } => {
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
            SessionExit::NetworkExit(reason) => {
                if reconnect_attempts >= RECONNECT_MAX_ATTEMPTS {
                    let _ = app.emit(
                        EVENT_RECONNECTING,
                        ReconnectPayload {
                            meeting_id: meeting_id.clone(),
                            phase: ReconnectPhase::GaveUp,
                            attempt: reconnect_attempts,
                            max_attempts: RECONNECT_MAX_ATTEMPTS,
                            reason: reason.clone(),
                        },
                    );
                    let _ = app.emit(
                        EVENT_ERROR,
                        ErrorPayload {
                            meeting_id: meeting_id.clone(),
                            code: "network_exit".into(),
                            message: reason,
                        },
                    );
                    return;
                }
                // 把上轮 session 的偏移量结转到 offset，新 session 时间戳从这里继续。
                if max_sid_in_session >= 0 {
                    sentence_id_offset += max_sid_in_session + 1;
                }
                time_offset_ms = time_offset_ms.saturating_add(max_end_ms_in_session);
                max_sid_in_session = -1;
                max_end_ms_in_session = 0;
                reconnect_attempts += 1;

                match attempt_reconnect(
                    &app,
                    &meeting_id,
                    provider.as_ref(),
                    &config,
                    &paused,
                    reconnect_attempts,
                    &reason,
                ) {
                    Some(new_session) => {
                        session = new_session;
                        let _ = app.emit(
                            EVENT_RECONNECTING,
                            ReconnectPayload {
                                meeting_id: meeting_id.clone(),
                                phase: ReconnectPhase::Recovered,
                                attempt: reconnect_attempts,
                                max_attempts: RECONNECT_MAX_ATTEMPTS,
                                reason: String::new(),
                            },
                        );
                        // 排空 backoff 期间堆积的旧 PCM——前段时间已经 gap 过去了，
                        // 灌进新 session 反而会让识别窗口跟时间戳错位。
                        while audio_rx.try_recv().is_ok() {}
                    }
                    None => {
                        let _ = app.emit(
                            EVENT_RECONNECTING,
                            ReconnectPayload {
                                meeting_id: meeting_id.clone(),
                                phase: ReconnectPhase::GaveUp,
                                attempt: reconnect_attempts,
                                max_attempts: RECONNECT_MAX_ATTEMPTS,
                                reason: reason.clone(),
                            },
                        );
                        let _ = app.emit(
                            EVENT_ERROR,
                            ErrorPayload {
                                meeting_id: meeting_id.clone(),
                                code: "network_exit".into(),
                                message: reason,
                            },
                        );
                        return;
                    }
                }
            }
        }
    }
}

enum SessionExit {
    EndOfStream,
    Error { code: String, message: String },
    NetworkExit(String),
}

#[allow(clippy::too_many_arguments)]
fn run_session<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    session: &mut Box<dyn MeetingSession>,
    audio_rx: &Receiver<Vec<u8>>,
    paused: &Arc<AtomicBool>,
    sentence_id_offset: i64,
    time_offset_ms: u64,
    max_sid_in_session: &mut i64,
    max_end_ms_in_session: &mut u64,
) -> SessionExit {
    let mut finished = false;
    let mut finish_deadline: Option<Instant> = None;
    loop {
        // 1) 排空 audio queue：尽量把堆积的帧一次性灌进 session，避免节奏被打散。
        loop {
            match audio_rx.try_recv() {
                Ok(pcm) => {
                    if !paused.load(Ordering::Relaxed) {
                        if let Err(e) = session.send_audio(pcm) {
                            log::warn!("[meetings] send_audio failed: {e}");
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    if !finished {
                        let _ = session.finish();
                        finished = true;
                        finish_deadline = Some(Instant::now() + Duration::from_secs(15));
                    }
                    break;
                }
            }
        }

        // 2) 短超时拉一个事件——保证频繁回到第 1 步排音频。
        let ev = session.next_event(Duration::from_millis(50));
        match ev {
            MeetingEvent::SegmentPartial(s) => {
                if s.sentence_id > *max_sid_in_session {
                    *max_sid_in_session = s.sentence_id;
                }
                if s.end_ms > *max_end_ms_in_session {
                    *max_end_ms_in_session = s.end_ms;
                }
                let _ = app.emit(
                    EVENT_PARTIAL,
                    SegmentPayload {
                        meeting_id: meeting_id.to_string(),
                        sentence_id: s.sentence_id + sentence_id_offset,
                        speaker_id: s.speaker_id,
                        text: s.text,
                        start_ms: s.start_ms.saturating_add(time_offset_ms),
                        end_ms: s.end_ms.saturating_add(time_offset_ms),
                    },
                );
            }
            MeetingEvent::SegmentFinal(s) => {
                if s.sentence_id > *max_sid_in_session {
                    *max_sid_in_session = s.sentence_id;
                }
                if s.end_ms > *max_end_ms_in_session {
                    *max_end_ms_in_session = s.end_ms;
                }
                let _ = app.emit(
                    EVENT_FINAL,
                    SegmentPayload {
                        meeting_id: meeting_id.to_string(),
                        sentence_id: s.sentence_id + sentence_id_offset,
                        speaker_id: s.speaker_id,
                        text: s.text,
                        start_ms: s.start_ms.saturating_add(time_offset_ms),
                        end_ms: s.end_ms.saturating_add(time_offset_ms),
                    },
                );
            }
            MeetingEvent::Error { code, message } => {
                return SessionExit::Error { code, message };
            }
            MeetingEvent::NetworkExit(m) => return SessionExit::NetworkExit(m),
            MeetingEvent::EndOfStream => return SessionExit::EndOfStream,
            MeetingEvent::Ready { .. } => {} // 二次 Ready 极少见，忽略
            MeetingEvent::DecodeRecoverable(m) => {
                log::warn!("[meetings] decode recoverable: {m}");
            }
            MeetingEvent::Idle => {}
        }

        // 3) 已 finish 但服务端不发 EndOfStream（极少见）—— 兜底超时退出。
        if let Some(d) = finish_deadline {
            if Instant::now() > d {
                log::warn!("[meetings] finish timeout, exiting worker");
                return SessionExit::EndOfStream;
            }
        }
    }
}

/// 走完 backoff + 握手；返回 None 表示放弃（已耗尽尝试次数 / pause 中收到 stop / 握手内部 Error）。
fn attempt_reconnect<R: Runtime>(
    app: &AppHandle<R>,
    meeting_id: &str,
    provider: &dyn MeetingAsrProvider,
    config: &MeetingSessionConfig,
    paused: &Arc<AtomicBool>,
    attempt: u32,
    last_reason: &str,
) -> Option<Box<dyn MeetingSession>> {
    // 指数退避：base * 2^(attempt-1)，封顶 cap。attempt 从 1 开始。
    let backoff_ms = (RECONNECT_BACKOFF_BASE.as_millis() as u64)
        .saturating_mul(1u64 << (attempt - 1).min(20));
    let backoff = Duration::from_millis(backoff_ms.min(RECONNECT_BACKOFF_CAP.as_millis() as u64));

    let _ = app.emit(
        EVENT_RECONNECTING,
        ReconnectPayload {
            meeting_id: meeting_id.to_string(),
            phase: ReconnectPhase::Backoff,
            attempt,
            max_attempts: RECONNECT_MAX_ATTEMPTS,
            reason: last_reason.to_string(),
        },
    );
    log::warn!(
        "[meetings] network exit (attempt {attempt}/{RECONNECT_MAX_ATTEMPTS}): {last_reason}; backoff {backoff:?}"
    );
    thread::sleep(backoff);

    // pause 中也照常重连——pause 不应该让会话失活；但如果用户在此期间 stop，
    // audio_tx 已 drop，下面新 session 起来后 run_session 立刻会看到 Disconnected，
    // 走 finish() 收尾流程，不需要在这里特判。
    let _ = paused;

    let _ = app.emit(
        EVENT_RECONNECTING,
        ReconnectPayload {
            meeting_id: meeting_id.to_string(),
            phase: ReconnectPhase::Connecting,
            attempt,
            max_attempts: RECONNECT_MAX_ATTEMPTS,
            reason: String::new(),
        },
    );

    let mut session = match provider.open(config.clone()) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[meetings] reconnect open failed: {e}");
            return None;
        }
    };
    // 等新一次 Ready，最多 8s——超时也算失败，外层会再试 backoff。
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match session.next_event(Duration::from_millis(200)) {
            MeetingEvent::Ready { .. } => return Some(session),
            MeetingEvent::Error { code, message } => {
                log::warn!("[meetings] reconnect handshake error: {code}: {message}");
                return None;
            }
            MeetingEvent::NetworkExit(m) => {
                log::warn!("[meetings] reconnect handshake network exit: {m}");
                return None;
            }
            _ => continue,
        }
    }
    log::warn!("[meetings] reconnect handshake timeout");
    None
}

// ---------- 时间轴文件（jsonl）IO ----------
//
// 会议时间轴跟音频文件并列放：`recordings/<yyyy-MM-dd>/<id>.jsonl`，每行一个
// JSON segment。append-only + 整段读 + 不修改的访问模式不该走 SQLite 关系表。
// 复用 audio 那套相对路径白名单（防任意文件读写）。

fn validated_transcript_subpath(p: &str) -> Result<PathBuf, String> {
    let Some(rest) = p.strip_prefix("recordings/") else {
        return Err("transcript_path must start with recordings/".into());
    };
    if rest.is_empty() || rest.contains('\\') || rest.contains("..") {
        return Err("invalid transcript_path".into());
    }
    let segs: Vec<&str> = rest.split('/').collect();
    let (date, filename) = match segs.as_slice() {
        [filename] => (None, *filename),
        [date, filename] => (Some(*date), *filename),
        _ => return Err("invalid transcript_path".into()),
    };
    if let Some(d) = date {
        if !is_valid_date_segment(d) {
            return Err("invalid date segment in transcript_path".into());
        }
    }
    if !filename.to_ascii_lowercase().ends_with(".jsonl") {
        return Err("transcript_path must end with .jsonl".into());
    }
    let mut out = PathBuf::new();
    if let Some(d) = date {
        out.push(d);
    }
    out.push(filename);
    Ok(out)
}

fn validated_meeting_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.contains('/')
        || id.contains('\\')
        || id.contains('\0')
        || id.contains("..")
    {
        return Err("invalid meeting_id".into());
    }
    Ok(())
}

/// 写一场会议的时间轴 jsonl，返回 history.transcript_path 用的相对路径。
/// payload 由前端拼好（每行一个 JSON）；Rust 不解析内容，只校验 id / 写文件。
#[tauri::command]
pub fn meeting_transcript_write<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    date: String,
    payload: String,
) -> Result<String, String> {
    validated_meeting_id(&meeting_id)?;
    if !is_valid_date_segment(&date) {
        return Err("invalid date".into());
    }
    let day_dir = db::ensure_recordings_dir(&app)?.join(&date);
    std::fs::create_dir_all(&day_dir)
        .map_err(|e| format!("mkdir {}: {e}", day_dir.display()))?;
    let abs = day_dir.join(format!("{meeting_id}.jsonl"));
    std::fs::write(&abs, payload).map_err(|e| format!("write {}: {e}", abs.display()))?;
    Ok(format!("recordings/{date}/{meeting_id}.jsonl"))
}

/// 读 jsonl 原文（前端自己 split + JSON.parse）。
#[tauri::command]
pub fn meeting_transcript_load<R: Runtime>(
    app: AppHandle<R>,
    transcript_path: String,
) -> Result<String, String> {
    let sub = validated_transcript_subpath(&transcript_path)?;
    let abs = db::recordings_dir(&app)?.join(sub);
    std::fs::read_to_string(&abs).map_err(|e| format!("read {}: {e}", abs.display()))
}

/// 删除 jsonl 文件（idempotent，不存在视为成功）。
#[tauri::command]
pub fn meeting_transcript_delete<R: Runtime>(
    app: AppHandle<R>,
    transcript_path: String,
) -> Result<(), String> {
    let sub = validated_transcript_subpath(&transcript_path)?;
    let abs = db::recordings_dir(&app)?.join(sub);
    match std::fs::remove_file(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", abs.display())),
    }
}

// dest_path 由前端 plugin-dialog::save() 给出（系统 Save 对话框选的绝对路径）；
// content 已是拼好的 Markdown，Rust 不解析格式只负责落盘。
#[tauri::command]
pub fn meeting_export_markdown(content: String, dest_path: String) -> Result<(), String> {
    if dest_path.is_empty() {
        return Err("dest_path is empty".into());
    }
    std::fs::write(&dest_path, content).map_err(|e| format!("write {dest_path}: {e}"))
}

// AI 纪要落盘到 jsonl 旁边的 `<id>.summary.md`——结构跟 transcript 一致：跟音频
// 同目录、跟 history 表关联（不进 SQLite，避免单行体积膨胀）。删除会议时由
// frontend 协同清理（jsonl 配套删除）。
fn validated_summary_subpath(p: &str) -> Result<PathBuf, String> {
    let Some(rest) = p.strip_prefix("recordings/") else {
        return Err("summary_path must start with recordings/".into());
    };
    if rest.is_empty() || rest.contains('\\') || rest.contains("..") {
        return Err("invalid summary_path".into());
    }
    let segs: Vec<&str> = rest.split('/').collect();
    let (date, filename) = match segs.as_slice() {
        [filename] => (None, *filename),
        [date, filename] => (Some(*date), *filename),
        _ => return Err("invalid summary_path".into()),
    };
    if let Some(d) = date {
        if !is_valid_date_segment(d) {
            return Err("invalid date segment in summary_path".into());
        }
    }
    let lower = filename.to_ascii_lowercase();
    if !lower.ends_with(".summary.md") {
        return Err("summary_path must end with .summary.md".into());
    }
    let mut out = PathBuf::new();
    if let Some(d) = date {
        out.push(d);
    }
    out.push(filename);
    Ok(out)
}

#[tauri::command]
pub fn meeting_summary_write<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    date: String,
    content: String,
) -> Result<String, String> {
    validated_meeting_id(&meeting_id)?;
    if !is_valid_date_segment(&date) {
        return Err("invalid date".into());
    }
    let day_dir = db::ensure_recordings_dir(&app)?.join(&date);
    std::fs::create_dir_all(&day_dir)
        .map_err(|e| format!("mkdir {}: {e}", day_dir.display()))?;
    let abs = day_dir.join(format!("{meeting_id}.summary.md"));
    std::fs::write(&abs, content).map_err(|e| format!("write {}: {e}", abs.display()))?;
    Ok(format!("recordings/{date}/{meeting_id}.summary.md"))
}

#[tauri::command]
pub fn meeting_summary_load<R: Runtime>(
    app: AppHandle<R>,
    summary_path: String,
) -> Result<String, String> {
    let sub = validated_summary_subpath(&summary_path)?;
    let abs = db::recordings_dir(&app)?.join(sub);
    match std::fs::read_to_string(&abs) {
        Ok(s) => Ok(s),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!("read {}: {e}", abs.display())),
    }
}

#[tauri::command]
pub fn meeting_summary_delete<R: Runtime>(
    app: AppHandle<R>,
    summary_path: String,
) -> Result<(), String> {
    let sub = validated_summary_subpath(&summary_path)?;
    let abs = db::recordings_dir(&app)?.join(sub);
    match std::fs::remove_file(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", abs.display())),
    }
}
