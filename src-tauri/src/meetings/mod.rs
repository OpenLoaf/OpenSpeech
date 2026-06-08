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
use crate::asr::meeting::{MeetingAsrProvider, MeetingEvent, MeetingSession, MeetingSessionConfig};
use crate::audio::is_valid_date_segment;
use crate::db;
use crate::meetings::writers::{MeetingAudioWriter, MeetingTranscriptAppender};
use crate::openloaf::{RefreshOutcome, SharedOpenLoaf, handle_session_expired};

mod writers;

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
    /// `recordings/<date>/<id>.ogg`——meeting_start 创建 writer 时就定好，
    /// meeting_stop 直接返回给前端写 history.audio_path，无需等 worker 回报。
    audio_rel_path: String,
    transcript_rel_path: String,
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
            Ok(Arc::new(SaasMeetingProvider::new(client)))
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

/// 当前是否有活动会议（含暂停态）——audio fanout 用来短路克隆。
pub fn has_active() -> bool {
    active_slot()
        .try_lock()
        .map(|g| g.is_some())
        .unwrap_or(false)
}

/// 是否有正在录音（非暂停）的会议——hotkey 用来决定是否拦截听写/翻译/Ask 快捷键。
/// 暂停态放行：用户暂停会议后可临时用听写，不被 maybe_block_for_meeting 拦下。
///
/// 用阻塞 lock 而非 try_lock：hotkey 是低频路径（一次按键一次），而 try_send_audio_pcm16
/// 每 ~10ms 持锁一瞬，PTT 按下刚好撞上就会 try_lock 失败 → unwrap_or(false) 把「锁正忙」
/// 误判成「没有会议」→ 放行听写、不发拦截提示。持锁方都是微秒级临界区，阻塞等锁无感、
/// 不死锁；拿到真实状态才能保证拦截可靠。
pub fn is_capturing() -> bool {
    active_slot()
        .lock()
        .map(|g| {
            g.as_ref()
                .is_some_and(|a| !a.paused.load(Ordering::Relaxed))
        })
        .unwrap_or(false)
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
    /// 本地日期 yyyy-MM-dd——audio/transcript 文件落到 recordings/<date>/<id>.{ogg,jsonl}。
    /// 由前端按本地时区生成，避免 Rust 端拿到 UTC 跟用户「翻文件夹」的语义偏一天。
    pub date: String,
}

/// meeting_start 的返回值：前端拿到 paths 后立刻 INSERT 一条 status='in_progress'
/// 的 history 行，会议中途崩溃也能在重启后找到入口。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStartResult {
    pub audio_path: String,
    pub transcript_path: String,
}

#[tauri::command]
pub async fn meeting_start<R: Runtime>(
    app: AppHandle<R>,
    args: StartArgs,
) -> Result<MeetingStartResult, String> {
    // 只对 SaaS 直连做 token 协作；BYOK / Tencent 自带凭据不走 OpenLoaf。
    // dispatch 失败留给 meeting_start_impl 自己报 ERR_MEETING_PROVIDER_NOT_CONFIGURED。
    let needs_saas_auth = matches!(
        dispatch_dictation_backend(&args.provider, DictationModality::Realtime),
        Ok(DictationBackend::SaasRealtime)
    );

    let ol: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();

    // B：握手前先确保 access_token 没过期。睡眠唤醒后第一次开会必踩这条——
    // SDK 后台 refresh 定时器睡眠期间停跑，醒来 token 已过期，直接握手必 401。
    if needs_saas_auth {
        match ol.ensure_access_token_fresh().await {
            RefreshOutcome::Refreshed => {}
            RefreshOutcome::AuthLost => {
                log::warn!("[meetings] saas preflight rejected by server; signaling auth-lost");
                handle_session_expired(&app, &ol);
                return Err(format!("{ERR_NOT_AUTHENTICATED}: SaaS preflight rejected"));
            }
            RefreshOutcome::Network => {
                log::warn!(
                    "[meetings] saas preflight network/5xx; keeping session, returning network error"
                );
                return Err("network: saas preflight network/5xx".into());
            }
        }
    }

    let first = {
        let app = app.clone();
        let args = args.clone();
        tauri::async_runtime::spawn_blocking(move || meeting_start_impl(app, args))
            .await
            .map_err(|e| format!("meeting_start join: {e}"))?
    };

    match first {
        Ok(r) => Ok(r),
        Err(e) if needs_saas_auth && looks_unauthorized(&e) => {
            // C：握手 401 → 续期一次再重试一次；续期失败 / 重试还 401 才清场。
            // 第一次失败时 writer/worker/slot 都还没创建（meeting_start_impl 在
            // build_provider + provider.open 之前只清了 stale slot，那步幂等），
            // 直接整段重跑即可。
            log::warn!("[meetings] saas start hit 401; attempting refresh + retry. raw={e}");
            match ol.ensure_fresh_token().await {
                RefreshOutcome::Refreshed => {}
                RefreshOutcome::AuthLost => {
                    log::warn!("[meetings] refresh rejected; signaling auth-lost");
                    handle_session_expired(&app, &ol);
                    return Err(format!("{ERR_NOT_AUTHENTICATED}: refresh rejected"));
                }
                RefreshOutcome::Network => {
                    log::warn!(
                        "[meetings] refresh network/5xx; keeping session, returning network error"
                    );
                    return Err("network: refresh network/5xx".into());
                }
            }
            let retry = {
                let app = app.clone();
                tauri::async_runtime::spawn_blocking(move || meeting_start_impl(app, args))
                    .await
                    .map_err(|e| format!("meeting_start join: {e}"))?
            };
            match retry {
                Ok(r) => {
                    log::info!("[meetings] saas start retry after refresh succeeded");
                    Ok(r)
                }
                Err(e2) if looks_unauthorized(&e2) => {
                    log::warn!(
                        "[meetings] saas start retry still 401 after refresh; clearing session. raw={e2}"
                    );
                    handle_session_expired(&app, &ol);
                    Err(format!("{ERR_NOT_AUTHENTICATED}: retry still 401"))
                }
                Err(e2) => Err(e2),
            }
        }
        Err(e) => Err(e),
    }
}

/// 匹配从 `meeting_start_impl` 冒出来的 401 字符串。
///
/// SaaS provider 的 `[open] connect failed` 走 `MeetingProviderError::Unauthenticated`
/// → Display = `"unauthenticated: network error: HTTP error: 401 Unauthorized"`。
/// 故意**不**匹配 `not_authenticated`——那是 `build_provider` 在拿不到 client 时
/// 已经 handle_session_expired 过的清场路径，不该再重试。
fn looks_unauthorized(s: &str) -> bool {
    let l = s.to_ascii_lowercase();
    l.contains("401") || l.contains("unauthorized") || l.contains("unauthenticated")
}

fn meeting_start_impl<R: Runtime>(
    app: AppHandle<R>,
    args: StartArgs,
) -> Result<MeetingStartResult, String> {
    log::info!(
        "[meetings] meeting_start id={} lang={} provider_mode={:?}",
        args.meeting_id,
        args.language,
        args.provider.mode,
    );
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

    let provider = build_provider(&app, &args.provider).map_err(|e| {
        log::warn!("[meetings] build_provider failed: {e}");
        e
    })?;
    let provider_id = provider.id().to_string();
    log::info!("[meetings] provider_id={provider_id}");
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
        log::warn!("[meetings] handshake timeout: no Ready within 8s");
        return Err("handshake timeout: no Ready within 8s".into());
    }
    log::info!(
        "[meetings] handshake ok session_id={:?} provider={provider_id}",
        session_id,
    );

    let _ = app.emit(
        EVENT_READY,
        ReadyPayload {
            meeting_id: args.meeting_id.clone(),
            session_id,
            provider: provider_id.clone(),
        },
    );

    // 流式落盘 writers：握手成功后才开文件，避免握手失败留下空 .ogg/.jsonl 孤儿。
    // create 失败要按顺序清理：transcript 失败时把已开的 audio 文件删掉，免得下次启动
    // 扫到一个没字幕的孤儿录音。
    let audio_writer = MeetingAudioWriter::create(&app, &args.meeting_id, &args.date)?;
    let audio_rel_path = audio_writer.rel_path().to_string();
    let transcript_writer =
        match MeetingTranscriptAppender::create(&app, &args.meeting_id, &args.date) {
            Ok(w) => w,
            Err(e) => {
                // audio_writer 拿在手里，drop 会 flush；这里直接放弃 audio 文件最干净。
                // 不显式 unlink——后续 orphan_scan 会收掉；当下保留可读 OGG 比静默删除更安全。
                drop(audio_writer);
                return Err(e);
            }
        };
    let transcript_rel_path = transcript_writer.rel_path().to_string();

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
                audio_writer,
                transcript_writer,
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
            audio_rel_path: audio_rel_path.clone(),
            transcript_rel_path: transcript_rel_path.clone(),
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

    Ok(MeetingStartResult {
        audio_path: audio_rel_path,
        transcript_path: transcript_rel_path,
    })
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
    // 累计帧/字节，每 ~1 秒 (96 帧 ≈ 1024ms 取整) 打一行，让肉眼能看到流量节奏。
    // 静音帧也照样灌（cpal callback 不区分），所以即使没说话这里也会持续累计。
    use std::sync::atomic::{AtomicU64, AtomicUsize};
    static FRAMES: AtomicUsize = AtomicUsize::new(0);
    static BYTES: AtomicU64 = AtomicU64::new(0);
    let n = FRAMES.fetch_add(1, Ordering::Relaxed) + 1;
    BYTES.fetch_add(pcm16.len() as u64, Ordering::Relaxed);
    if n == 1 {
        log::info!(
            "[meetings] first PCM16 frame fanout to meeting session ({}B)",
            pcm16.len()
        );
    } else if n % 96 == 0 {
        log::info!(
            "[meetings] audio progress frames={n} bytes={}",
            BYTES.load(Ordering::Relaxed)
        );
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

/// meeting_stop 的返回值：duration + audio/transcript 相对路径。
/// 前端拿 audio_path 直接 UPDATE history.audio_path，replace 原来 stopRecordingAndSave 的角色。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MeetingStopResult {
    pub duration_ms: u64,
    pub audio_path: String,
    pub transcript_path: String,
}

#[tauri::command]
pub async fn meeting_stop<R: Runtime>(app: AppHandle<R>) -> Result<MeetingStopResult, String> {
    tauri::async_runtime::spawn_blocking(move || meeting_stop_impl(app))
        .await
        .map_err(|e| format!("meeting_stop join: {e}"))?
}

fn meeting_stop_impl<R: Runtime>(app: AppHandle<R>) -> Result<MeetingStopResult, String> {
    let (worker_handle, meeting_id, total_ms, audio_path, transcript_path) = {
        let mut slot = active_slot().lock().map_err(|e| e.to_string())?;
        let mut a = slot.take().ok_or("no active meeting")?;
        let total_ms = a.elapsed_baseline_ms
            + if a.paused.load(Ordering::Relaxed) {
                0
            } else {
                a.started_at.elapsed().as_millis() as u64
            };
        // drop a → drop audio_tx → worker 在 try_recv 拿到 Disconnected 后调 session.finish()
        // → worker 退出前 finalize writers（flush OGG EOS page、jsonl flush）
        (
            a.worker.take(),
            a.meeting_id,
            total_ms,
            a.audio_rel_path,
            a.transcript_rel_path,
        )
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
    Ok(MeetingStopResult {
        duration_ms: total_ms,
        audio_path,
        transcript_path,
    })
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
#[allow(clippy::too_many_arguments)]
fn event_pump<R: Runtime>(
    app: AppHandle<R>,
    meeting_id: String,
    mut session: Box<dyn MeetingSession>,
    audio_rx: Receiver<Vec<u8>>,
    paused: Arc<AtomicBool>,
    provider: Arc<dyn MeetingAsrProvider>,
    config: MeetingSessionConfig,
    mut audio_writer: MeetingAudioWriter,
    mut transcript_writer: MeetingTranscriptAppender,
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
            &mut audio_writer,
            &mut transcript_writer,
        );

        match exit {
            SessionExit::EndOfStream => {
                finalize_writers(audio_writer, transcript_writer);
                let _ = app.emit(EVENT_END, meeting_id.clone());
                return;
            }
            SessionExit::Error { code, message } => {
                finalize_writers(audio_writer, transcript_writer);
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
                    finalize_writers(audio_writer, transcript_writer);
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
                // 锚到 OGG 实际写入时长，而非 vendor end_ms（后者不含尾部静音，每次
                // 重连/暂停都会让新段字幕 seek 越攒越早）。断网期间不写盘，故重连前后
                // written_ms 不变，与排空丢弃的 OGG 时间线对齐。
                time_offset_ms = audio_writer.written_ms();
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
                        finalize_writers(audio_writer, transcript_writer);
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
            SessionExit::Paused => {
                // 用户暂停：关掉当前 session（drop=关 WS，避免服务端 idle 15s 后 4008
                // 把会话判死），但不结束会议、不 finalize writers。
                drop(session);
                // 结转 offset：resume 时新 session 的 sid/时间戳从这里续接，与暂停前的
                // 字幕和已落盘 OGG 对齐（暂停区间不占时间轴——麦克风此时已停采集）。
                if max_sid_in_session >= 0 {
                    sentence_id_offset += max_sid_in_session + 1;
                }
                // time_offset 不在这里结转：resume 握手窗口还会往 OGG 写真实音频，
                // 必须等写完后用 written_ms() 锚定，否则新段字幕会比音频早握手那段时长。
                max_sid_in_session = -1;
                max_end_ms_in_session = 0;

                // 等 resume（paused→false）或 stop（audio_tx 断开）。
                let resumed = loop {
                    if !paused.load(Ordering::Relaxed) {
                        break true;
                    }
                    if let Err(TryRecvError::Disconnected) = audio_rx.try_recv() {
                        break false;
                    }
                    thread::sleep(Duration::from_millis(100));
                };
                if !resumed {
                    // 暂停中 stop：正常收尾结束会议。
                    finalize_writers(audio_writer, transcript_writer);
                    let _ = app.emit(EVENT_END, meeting_id.clone());
                    return;
                }
                // resume：重建 session（无 backoff、不计 reconnect_attempts——这不是错误）。
                match open_session_await_ready(provider.as_ref(), &config) {
                    Some(new_session) => {
                        session = new_session;
                        // resume 握手窗口（最多 8s）cpal 已在采集真实音频：写盘保 OGG
                        // 时间线连续（不灌新 session，它从 Ready 后才接帧）。
                        while let Ok(pcm) = audio_rx.try_recv() {
                            let _ = audio_writer.push_pcm16(&pcm);
                        }
                        // 锚到 OGG 实际写入时长（含上面握手期写盘）：新 session 字幕
                        // start_ms 从这里续接，与 OGG 中新音频的位置精确对齐。
                        time_offset_ms = audio_writer.written_ms();
                    }
                    None => {
                        finalize_writers(audio_writer, transcript_writer);
                        let _ = app.emit(
                            EVENT_ERROR,
                            ErrorPayload {
                                meeting_id: meeting_id.clone(),
                                code: "resume_failed".into(),
                                message: "failed to reopen meeting session after resume".into(),
                            },
                        );
                        return;
                    }
                }
            }
        }
    }
}

/// 同时 finalize 两个 writer。一个失败不阻断另一个——OGG 文件失 EOS 仍能被 ffmpeg
/// 读前半段，jsonl 失 flush 也能丢 4KB 内的数据，最大化保留可用资产。
fn finalize_writers(audio: MeetingAudioWriter, transcript: MeetingTranscriptAppender) {
    if let Err(e) = audio.finalize() {
        log::warn!("[meetings] audio writer finalize failed: {e}");
    }
    if let Err(e) = transcript.finalize() {
        log::warn!("[meetings] transcript writer finalize failed: {e}");
    }
}

enum SessionExit {
    EndOfStream,
    Error {
        code: String,
        message: String,
    },
    NetworkExit(String),
    /// 用户暂停：worker 主动放弃当前 session（关 WS，避免服务端 idle 超时 4008），
    /// 但不结束会议；event_pump 等 resume 后用 offset 重建续接。
    Paused,
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
    audio_writer: &mut MeetingAudioWriter,
    transcript_writer: &mut MeetingTranscriptAppender,
) -> SessionExit {
    let mut finished = false;
    let mut finish_deadline: Option<Instant> = None;
    loop {
        // 用户暂停：主动退出让 event_pump 关闭 session 并在 resume 时重建——否则服务端
        // idle 15s 后会发 4008（"客户端超过15秒未发送音频"）把整场会议判死。
        if !finished && paused.load(Ordering::Relaxed) {
            return SessionExit::Paused;
        }
        // 1) 排空 audio queue 灌进 session，同时把 PCM 编码追加到本地 OGG。
        //    暂停时前端已 stopAudioLevel 停掉 cpal 采集，正常无帧到达；下方 send_audio
        //    的 paused gate 是防御：共享 stream 被其他 holder 占着没真停时，丢帧不识别。
        loop {
            match audio_rx.try_recv() {
                Ok(pcm) => {
                    if let Err(e) = audio_writer.push_pcm16(&pcm) {
                        log::warn!("[meetings] audio writer push failed: {e}");
                    }
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
                let payload = SegmentPayload {
                    meeting_id: meeting_id.to_string(),
                    sentence_id: s.sentence_id + sentence_id_offset,
                    speaker_id: s.speaker_id,
                    text: s.text,
                    start_ms: s.start_ms.saturating_add(time_offset_ms),
                    end_ms: s.end_ms.saturating_add(time_offset_ms),
                };
                // 先落盘后 emit：哪怕 emit 期间 webview crash，磁盘上字幕已落定。
                if let Err(e) = transcript_writer.append_final(&payload) {
                    log::warn!("[meetings] transcript append failed: {e}");
                }
                let _ = app.emit(EVENT_FINAL, payload);
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
    let backoff_ms =
        (RECONNECT_BACKOFF_BASE.as_millis() as u64).saturating_mul(1u64 << (attempt - 1).min(20));
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

    open_session_await_ready(provider, config)
}

/// provider.open() + 轮询到首个 Ready（最多 8s）。失败 / 超时 / 握手 Error 都返回 None。
/// reconnect（带 backoff）和 resume（暂停后重建，无 backoff）共用这段握手。
fn open_session_await_ready(
    provider: &dyn MeetingAsrProvider,
    config: &MeetingSessionConfig,
) -> Option<Box<dyn MeetingSession>> {
    let mut session = match provider.open(config.clone()) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("[meetings] open failed: {e}");
            return None;
        }
    };
    // 等新一次 Ready，最多 8s——超时也算失败。
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        match session.next_event(Duration::from_millis(200)) {
            MeetingEvent::Ready { .. } => return Some(session),
            MeetingEvent::Error { code, message } => {
                log::warn!("[meetings] handshake error: {code}: {message}");
                return None;
            }
            MeetingEvent::NetworkExit(m) => {
                log::warn!("[meetings] handshake network exit: {m}");
                return None;
            }
            _ => continue,
        }
    }
    log::warn!("[meetings] handshake timeout");
    None
}

// ---------- 孤儿扫描 ----------
//
// 会议中途进程被杀（webview OOM、用户强退、系统断电）时：
//   - audio writer 已经在 worker 内 push_pcm16 写盘，BufWriter 内最多丢几 KB
//   - transcript appender 每段 final 都 flush，已识别段全部落地
//   - **但** history 行因为前端没机会调 insertMeetingHistory，没插入
//
// 启动时枚举 recordings/<date>/*.jsonl，前端拿这个 list 对照 history 表，
// 缺失的就读 jsonl 拼回一条 status='recovered' 的 history 行。
//
// 只返回路径不读内容——读 jsonl 走前端已有 meeting_transcript_load 通道，
// 避免在 Rust 端再写一遍同样的解析逻辑。

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrphanCandidate {
    /// 从文件名解出的 meeting_id（去掉 .jsonl 后缀）。
    pub meeting_id: String,
    /// 形如 "recordings/2026-05-19/<id>.jsonl"，前端可直接传给 meeting_transcript_load。
    pub transcript_path: String,
    /// 形如 "recordings/2026-05-19/<id>.ogg"——可能不存在（writer 创建失败 / 旧版数据）。
    pub audio_path: Option<String>,
    /// 文件 mtime 毫秒，给前端排序/展示用。
    pub mtime_ms: Option<i64>,
}

#[tauri::command]
pub fn meeting_scan_orphans<R: Runtime>(
    app: AppHandle<R>,
    dates: Vec<String>,
) -> Result<Vec<OrphanCandidate>, String> {
    let base = db::recordings_dir(&app)?;
    let mut out = Vec::new();
    for date in dates {
        if !is_valid_date_segment(&date) {
            continue;
        }
        let day_dir = base.join(&date);
        let Ok(entries) = std::fs::read_dir(&day_dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
                continue;
            };
            let Some(stem) = name.strip_suffix(".jsonl") else {
                continue;
            };
            // meeting_id 校验：start 时同样的规则——防止有人手动塞奇怪文件名进来
            if stem.is_empty() || stem.contains("..") {
                continue;
            }
            let transcript_path = format!("recordings/{date}/{stem}.jsonl");
            let ogg_abs = day_dir.join(format!("{stem}.ogg"));
            let audio_path = if ogg_abs.exists() {
                Some(format!("recordings/{date}/{stem}.ogg"))
            } else {
                None
            };
            let mtime_ms = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64);
            out.push(OrphanCandidate {
                meeting_id: stem.to_string(),
                transcript_path,
                audio_path,
                mtime_ms,
            });
        }
    }
    Ok(out)
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
    std::fs::create_dir_all(&day_dir).map_err(|e| format!("mkdir {}: {e}", day_dir.display()))?;
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

/// 双语翻译的译文行 append 入参（前端逐段翻完，会议 stop 后批量落库）。
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TranslationAppendItem {
    sentence_id: i64,
    translation: String,
}

#[derive(serde::Serialize)]
struct TranslationLine<'a> {
    #[serde(rename = "sentenceId")]
    sentence_id: i64,
    translation: &'a str,
}

/// 把译文以 append 模式补写进已 finalize 的会议 jsonl（每行 `{sentenceId, translation}`）。
/// 不 truncate、不碰原文行；读取时按 sentenceId 合并。文件不存在直接报错（不该发生）。
#[tauri::command]
pub fn meeting_translation_append<R: Runtime>(
    app: AppHandle<R>,
    transcript_path: String,
    items: Vec<TranslationAppendItem>,
) -> Result<(), String> {
    if items.is_empty() {
        return Ok(());
    }
    let sub = validated_transcript_subpath(&transcript_path)?;
    let abs = db::recordings_dir(&app)?.join(sub);
    let mut file = std::fs::OpenOptions::new()
        .append(true)
        .open(&abs)
        .map_err(|e| format!("open append {}: {e}", abs.display()))?;
    use std::io::Write as _;
    let mut buf = String::new();
    for it in &items {
        let line = TranslationLine {
            sentence_id: it.sentence_id,
            translation: &it.translation,
        };
        let json = serde_json::to_string(&line).map_err(|e| format!("serialize: {e}"))?;
        buf.push_str(&json);
        buf.push('\n');
    }
    file.write_all(buf.as_bytes())
        .map_err(|e| format!("append {}: {e}", abs.display()))?;
    file.flush().map_err(|e| format!("flush: {e}"))?;
    Ok(())
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
    std::fs::create_dir_all(&day_dir).map_err(|e| format!("mkdir {}: {e}", day_dir.display()))?;
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
