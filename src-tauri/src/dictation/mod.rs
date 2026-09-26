// 听写会话 runtime：Rust 持有唯一的会话状态，前端与悬浮条只渲染、只发意图。
//
// 数据流：
//   快捷键 / ESC / 托盘 / 悬浮条按钮 / 前端 worker 上报 ──▶ dispatch(Input)
//   ──▶ Machine::handle（纯逻辑）──▶ Snapshot 广播 + Effect 执行（采集、提示音、托盘…）
//
// 前端 worker（主窗 webview）负责依赖前端数据的处理：拼提示词、调 ASR / AI 整理、
// 写历史。它通过 `dictation_*` 命令上报阶段与输出，所有上报都带 session_id，
// 过期会话的上报在状态机与输出队列两处都会被丢弃。
//
// 事件（全部广播到所有 webview）：
//   dictation/state         Snapshot，每次状态变化
//   dictation/started       采集就绪，worker 据此启动实时 ASR
//   dictation/process       录音已落盘，worker 开始转写 → 整理 → 输出
//   dictation/ended         会话非正常结束（取消 / 中断 / 登录失效），worker 收尾并写历史
//   dictation/blocked       未登录，前端弹登录框或悬浮条提示
//   dictation/skip-refine   用户要求跳过 AI 优化
//   dictation/mode-switched 录音中听写 ↔ 翻译互切

mod machine;
mod output;

use std::sync::{Mutex, OnceLock};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager};

use crate::active_app::ActiveWindowInfo;
use crate::audio::RecordingResult;
use crate::hotkey::BindingId;

pub use machine::{Intent, Snapshot};
use machine::{
    CueKind, Effect, EndKind, ErrorInfo, FAILED_DISMISS_MS, Gate, Input, Machine, Phase,
    SegmentMode, SessionConfig,
};
pub use output::FinishOutcome;

const STATE_EVENT: &str = "openspeech://dictation/state";
const STARTED_EVENT: &str = "openspeech://dictation/started";
const PROCESS_EVENT: &str = "openspeech://dictation/process";
const ENDED_EVENT: &str = "openspeech://dictation/ended";
const BLOCKED_EVENT: &str = "openspeech://dictation/blocked";
const SKIP_REFINE_EVENT: &str = "openspeech://dictation/skip-refine";
const MODE_SWITCHED_EVENT: &str = "openspeech://dictation/mode-switched";

/// 开录鉴权时静默恢复登录态的最长等待；超时按未登录处理。
const GATE_RECOVER_TIMEOUT: Duration = Duration::from_millis(1500);

/// 前端推来的听写配置；开录瞬间冻结进会话。
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationConfig {
    #[serde(flatten)]
    session: SessionConfig,
    /// 自定义听写供应商已配置完整（endpoint + key）：不需要 OpenLoaf 登录也能录。
    custom_dictation_ready: bool,
}

/// 会话运行期上下文（状态机之外、只有 runtime 需要的数据）。
#[derive(Clone)]
struct SessionCtx {
    session_id: String,
    target_app: Option<ActiveWindowInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct StartedPayload {
    session_id: String,
    binding: BindingId,
    config: SessionConfig,
    target_app: Option<ActiveWindowInfo>,
    debug: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProcessPayload {
    session_id: String,
    binding: BindingId,
    config: SessionConfig,
    rec: RecordingResult,
    target_app: Option<ActiveWindowInfo>,
    /// 松手瞬间的前台 app（历史 / 整理风格按落点）。REALTIME 模式文字已实时打进起点 app，
    /// 落点恒等于起点。
    dest_app: Option<ActiveWindowInfo>,
    /// 调试模拟会话：前端不写历史。
    debug: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct EndedPayload {
    session_id: String,
    kind: EndKind,
    binding: BindingId,
    rec: Option<RecordingResult>,
    target_app: Option<ActiveWindowInfo>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SessionRef {
    session_id: String,
    binding: BindingId,
}

static APP: OnceLock<AppHandle> = OnceLock::new();

fn machine() -> &'static Mutex<Machine> {
    static M: OnceLock<Mutex<Machine>> = OnceLock::new();
    M.get_or_init(|| Mutex::new(Machine::new()))
}

fn config() -> &'static Mutex<DictationConfig> {
    static C: OnceLock<Mutex<DictationConfig>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(DictationConfig::default()))
}

fn ctx() -> &'static Mutex<Option<SessionCtx>> {
    static C: OnceLock<Mutex<Option<SessionCtx>>> = OnceLock::new();
    C.get_or_init(|| Mutex::new(None))
}

/// 调试模拟会话（History 页「用这段录音模拟一次听写」）：不开麦克风，
/// 停止时直接拿这份录音当本次采集结果，其余流程与真实听写完全一致。
fn debug_rec() -> &'static Mutex<Option<(String, RecordingResult)>> {
    static D: OnceLock<Mutex<Option<(String, RecordingResult)>>> = OnceLock::new();
    D.get_or_init(|| Mutex::new(None))
}

fn is_debug(session_id: &str) -> bool {
    debug_rec()
        .lock()
        .is_ok_and(|d| d.as_ref().is_some_and(|(id, _)| id == session_id))
}

fn take_debug_rec(session_id: &str) -> Option<RecordingResult> {
    let mut d = debug_rec().lock().ok()?;
    if d.as_ref().is_some_and(|(id, _)| id == session_id) {
        d.take().map(|(_, rec)| rec)
    } else {
        None
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
}

fn target_app_of(session_id: &str) -> Option<ActiveWindowInfo> {
    ctx()
        .lock()
        .ok()?
        .as_ref()
        .filter(|c| c.session_id == session_id)
        .and_then(|c| c.target_app.clone())
}

/// 会话当前绑定与配置（录音中可能因听写 ↔ 翻译互切而变化，所以每次现取）。
fn session_info(session_id: &str) -> Option<(BindingId, SessionConfig, Phase)> {
    let m = machine().lock().ok()?;
    let s = m.session().filter(|s| s.id == session_id)?;
    Some((s.binding, s.config.clone(), m.phase()))
}

fn dispatch(input: Input) {
    let Some(app) = APP.get() else { return };
    let (effects, snapshot, prev_phase, prev_session, changed) = {
        let mut m = machine().lock().unwrap_or_else(|e| e.into_inner());
        let prev_seq = m.snapshot().seq;
        let prev_phase = m.phase();
        let prev_session = m.session().map(|s| s.id.clone());
        let fx = m.handle(input, now_ms());
        let snap = m.snapshot();
        let changed = snap.seq != prev_seq;
        (fx, snap, prev_phase, prev_session, changed)
    };
    if changed {
        if let Err(e) = app.emit(STATE_EVENT, &snapshot) {
            log::warn!("[dictation] emit state failed: {e}");
        }
        if prev_phase != snapshot.phase {
            log::info!(
                "[dictation] {prev_phase:?} → {:?} session={:?}",
                snapshot.phase,
                snapshot.session_id
            );
            apply_phase_change(app, prev_phase, snapshot.phase);
        }
        // 会话结束：之后到达的输出全部丢弃。
        if let Some(prev) = prev_session.as_deref()
            && snapshot.session_id.as_deref() != Some(prev)
        {
            output::end(prev);
        }
    }
    for effect in effects {
        run_effect(app, effect);
    }
}

/// 由阶段派生的副作用：托盘「停止录音」项、ESC 吞键、悬浮条弹出。
fn apply_phase_change(app: &AppHandle, prev: Phase, next: Phase) {
    let recording = |p: Phase| p == Phase::Recording;
    if recording(prev) != recording(next) {
        crate::tray::tray_set_recording(app.clone(), recording(next));
    }
    // 输出阶段不吞 ESC：注入只持续几十毫秒，吞了反而可能漏到下一次。
    let esc = |p: Phase| {
        matches!(
            p,
            Phase::Recording | Phase::Transcribing | Phase::Refining | Phase::Translating
        )
    };
    if esc(prev) != esc(next) {
        let app = app.clone();
        let on = esc(next);
        // esc_capture_* 持 hotkey_op_lock，必须脱离主线程。
        thread::spawn(move || {
            let r = if on {
                crate::hotkey::esc_capture_start(app)
            } else {
                crate::hotkey::esc_capture_stop(app)
            };
            if let Err(e) = r {
                log::warn!("[dictation] esc capture toggle failed: {e}");
            }
        });
    }
    if recording(next) && !recording(prev) {
        let app2 = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            if let Err(e) = crate::overlay::show(&app2) {
                log::warn!("[dictation] overlay show failed: {e:?}");
            }
        }) {
            log::warn!("[dictation] schedule overlay show failed: {e:?}");
        }
    }
}

fn emit<S: Serialize + Clone>(app: &AppHandle, event: &str, payload: S) {
    if let Err(e) = app.emit(event, payload) {
        log::warn!("[dictation] emit {event} failed: {e}");
    }
}

fn run_effect(app: &AppHandle, effect: Effect) {
    match effect {
        Effect::CheckGate {
            binding,
            at_ms,
            config,
            new_session_id,
        } => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let ok = match app.try_state::<crate::openloaf::SharedOpenLoaf>() {
                    Some(state) => {
                        let ol = state.inner().clone();
                        tokio::time::timeout(
                            GATE_RECOVER_TIMEOUT,
                            crate::openloaf::try_recover_session(&app, ol),
                        )
                        .await
                        .ok()
                        .and_then(Result::ok)
                        .unwrap_or(false)
                    }
                    None => false,
                };
                log::info!("[dictation] gate recover → {ok}");
                dispatch(Input::GateChecked {
                    binding,
                    at_ms,
                    ok,
                    config,
                    new_session_id,
                });
            });
        }
        Effect::Blocked { binding } => {
            log::info!("[dictation] blocked: not signed in");
            emit(app, BLOCKED_EVENT, binding);
        }
        Effect::OpenCapture { session_id } => {
            let app = app.clone();
            thread::spawn(move || open_capture(&app, session_id));
        }
        Effect::StopCaptureForProcessing { session_id } => {
            let app = app.clone();
            thread::spawn(move || stop_for_processing(&app, session_id));
        }
        Effect::StopCaptureAndEnd {
            session_id,
            binding,
            kind,
        } => {
            let app = app.clone();
            thread::spawn(move || {
                crate::stt::close_if_active();
                let rec = crate::audio::save_dictation_capture(&app, &session_id)
                    .and_then(|r| r.map_err(|e| log::warn!("[dictation] save on end failed: {e}")).ok());
                end_session(&app, session_id, kind, binding, rec);
            });
        }
        Effect::DiscardCapture {
            session_id,
            binding,
            kind,
        } => {
            let app = app.clone();
            thread::spawn(move || {
                crate::stt::close_if_active();
                crate::audio::discard_dictation_capture(&session_id);
                end_session(&app, session_id, kind, binding, None);
            });
        }
        Effect::EndWork {
            session_id,
            binding,
            kind,
        } => {
            crate::ai_refine::cancel_task(&session_id);
            let app = app.clone();
            thread::spawn(move || {
                crate::stt::close_if_active();
                end_session(&app, session_id, kind, binding, None);
            });
        }
        Effect::SkipRefine { session_id } => {
            crate::ai_refine::cancel_task(&session_id);
            emit(app, SKIP_REFINE_EVENT, session_id);
        }
        Effect::ModeSwitched {
            session_id,
            binding,
        } => emit(
            app,
            MODE_SWITCHED_EVENT,
            SessionRef {
                session_id,
                binding,
            },
        ),
        Effect::Cue(kind) => match kind {
            CueKind::Start => crate::cue::play_start(),
            CueKind::Stop => crate::cue::play_stop(),
            CueKind::Cancel => crate::cue::play_cancel(),
        },
        Effect::ScheduleDismiss { token } => {
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(FAILED_DISMISS_MS));
                dispatch(Input::DismissTimer { token });
            });
        }
    }
}

fn end_session(
    app: &AppHandle,
    session_id: String,
    kind: EndKind,
    binding: BindingId,
    rec: Option<RecordingResult>,
) {
    output::end(&session_id);
    take_debug_rec(&session_id);
    let target_app = target_app_of(&session_id);
    emit(
        app,
        ENDED_EVENT,
        EndedPayload {
            session_id,
            kind,
            binding,
            rec,
            target_app,
        },
    );
}

fn open_capture(app: &AppHandle, session_id: String) {
    // 全局快捷键不改变前台焦点，此刻就是用户正在用的 app。
    let target_app = output::active_window();
    if let Ok(mut c) = ctx().lock() {
        *c = Some(SessionCtx {
            session_id: session_id.clone(),
            target_app: target_app.clone(),
        });
    }
    let debug = is_debug(&session_id);
    if !debug && let Err(e) = crate::audio::open_dictation_capture(app, &session_id) {
        log::warn!("[dictation] open capture failed: {e}");
        dispatch(Input::CaptureFailed { session_id });
        return;
    }
    // 打开期间会话可能已被取消 / 结束：此时的采集没有主人，立刻放掉。
    let Some((binding, config, Phase::Recording)) = session_info(&session_id) else {
        if !debug {
            crate::audio::discard_dictation_capture(&session_id);
        }
        return;
    };
    output::begin(
        &session_id,
        target_app.clone(),
        config.streaming_inject,
        config.clipboard_copy,
    );
    dispatch(Input::CaptureReady {
        session_id: session_id.clone(),
    });
    emit(
        app,
        STARTED_EVENT,
        StartedPayload {
            session_id,
            binding,
            config,
            target_app,
            debug,
        },
    );
}

fn stop_for_processing(app: &AppHandle, session_id: String) {
    let debug_rec = take_debug_rec(&session_id);
    let debug = debug_rec.is_some();
    let saved = match debug_rec {
        Some(rec) => Some(Ok(rec)),
        None => crate::audio::save_dictation_capture(app, &session_id),
    };
    let rec = match saved {
        Some(Ok(rec)) => rec,
        Some(Err(e)) => {
            log::warn!("[dictation] save recording failed: {e}");
            crate::stt::close_if_active();
            dispatch(Input::StopFailed {
                session_id,
                message: e,
            });
            return;
        }
        None => {
            crate::stt::close_if_active();
            dispatch(Input::StopFailed {
                session_id,
                message: "recording not available".into(),
            });
            return;
        }
    };
    if !rec.voiced {
        crate::stt::close_if_active();
        dispatch(Input::Stopped {
            session_id,
            voiced: false,
            audio_ms: 0,
        });
        return;
    }
    dispatch(Input::Stopped {
        session_id: session_id.clone(),
        voiced: true,
        audio_ms: rec.duration_ms,
    });
    let Some((binding, config, phase)) = session_info(&session_id) else {
        return;
    };
    if !phase.is_processing() {
        return;
    }
    let target_app = target_app_of(&session_id);
    let dest_app = match config.segment_mode {
        SegmentMode::Realtime => target_app.clone(),
        SegmentMode::Utterance => output::active_window().or_else(|| target_app.clone()),
    };
    emit(
        app,
        PROCESS_EVENT,
        ProcessPayload {
            session_id,
            binding,
            config,
            rec,
            target_app,
            dest_app,
            debug,
        },
    );
}

// ── 外部入口 ────────────────────────────────────────────────────────────────

/// 录音类快捷键（听写 / 翻译 / AskAI）。统一 toggle：只有按下推进状态机。
pub fn on_hotkey(binding: BindingId, pressed: bool, at_ms: u64) {
    if !pressed {
        return;
    }
    let Some(app) = APP.get() else { return };
    let cfg = config().lock().map(|c| c.clone()).unwrap_or_default();
    let gate = if cfg.custom_dictation_ready || crate::openloaf::has_session(app) {
        Gate::Open
    } else {
        Gate::NeedsCheck
    };
    dispatch(Input::Press {
        binding,
        at_ms,
        gate,
        config: cfg.session,
        new_session_id: crate::audio::new_recording_id(),
    });
}

/// ESC（非 auto-repeat 的按下）。
pub fn on_esc() {
    dispatch(Input::Esc);
}

/// 托盘「停止录音」：录音中正常结束（不丢用户的话），其它活跃态取消。
pub fn on_tray_stop() {
    let phase = machine().lock().map(|m| m.phase()).unwrap_or(Phase::Idle);
    let intent = if phase == Phase::Recording {
        Intent::Finish
    } else {
        Intent::Cancel
    };
    dispatch(Input::Intent {
        intent,
        at_ms: now_ms(),
    });
}

pub fn on_auth_lost() {
    dispatch(Input::AuthLost);
}

pub fn on_audio_stream_error(reason: &str) {
    dispatch(Input::StreamError {
        error: ErrorInfo {
            code: "mic_interrupted".into(),
            message: None,
        },
    });
    log::warn!("[dictation] audio stream error reason={reason}");
}

// ── 前端命令 ────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn dictation_snapshot() -> Snapshot {
    machine()
        .lock()
        .map(|m| m.snapshot())
        .unwrap_or_else(|e| e.into_inner().snapshot())
}

#[tauri::command]
pub fn dictation_set_config(config_in: DictationConfig) {
    if let Ok(mut c) = config().lock() {
        *c = config_in;
    }
}

#[tauri::command]
pub fn dictation_intent(intent: Intent) {
    dispatch(Input::Intent {
        intent,
        at_ms: now_ms(),
    });
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Stage {
    Transcribing,
    Refining,
    Translating,
}

#[tauri::command]
pub fn dictation_report_stage(session_id: String, stage: Stage) {
    let phase = match stage {
        Stage::Transcribing => Phase::Transcribing,
        Stage::Refining => Phase::Refining,
        Stage::Translating => Phase::Translating,
    };
    dispatch(Input::Stage { session_id, phase });
}

/// 流式输出：`text` 为到目前为止的完整文本。
#[tauri::command]
pub fn dictation_output(app: AppHandle, session_id: String, text: String) {
    if !output::is_current(&session_id) {
        return;
    }
    let chars = text.chars().count() as u32;
    dispatch(Input::Output {
        session_id: session_id.clone(),
        chars,
    });
    output::enqueue_stream(&app, &session_id, text);
}

/// 收尾输出：等流式队列排空，按游标补齐剩余部分，然后结束会话。
#[tauri::command]
pub async fn dictation_finish(
    app: AppHandle,
    session_id: String,
    text: String,
) -> Result<FinishOutcome, String> {
    let sid = session_id.clone();
    let outcome =
        tauri::async_runtime::spawn_blocking(move || output::finish_blocking(&app, &sid, text))
            .await
            .map_err(|e| format!("dictation_finish join: {e}"))?;
    log::info!("[dictation] finish outcome={outcome:?}");
    output::end(&session_id);
    dispatch(Input::Done { session_id });
    Ok(outcome)
}

/// 会话处理完毕但没有要输出的文字（跳过 AI 优化走结果面板等）。
#[tauri::command]
pub fn dictation_complete(session_id: String) {
    output::end(&session_id);
    dispatch(Input::Done { session_id });
}

#[tauri::command]
pub fn dictation_fail(session_id: String, code: String, message: Option<String>) {
    output::end(&session_id);
    dispatch(Input::Fail {
        session_id,
        error: ErrorInfo { code, message },
    });
}

/// DEV-ONLY：用一段已有录音模拟一次听写。会话照常进入录音态（悬浮条计时），
/// 录音时长到点自动结束——期间可以切到目标输入框，ESC / 悬浮条按钮随时取消。
/// 强制整句模式：没有真实音频流，边说边出字无从谈起。
#[tauri::command]
pub fn dictation_debug_simulate(audio_path: String, duration_ms: u64) -> Result<(), String> {
    let busy = machine().lock().map(|m| m.phase() != Phase::Idle).unwrap_or(true);
    if busy {
        return Err("dictation busy".into());
    }
    let session_id = crate::audio::new_recording_id();
    let rec = RecordingResult {
        audio_path,
        duration_ms,
        sample_rate: 16_000,
        channels: 1,
        samples: 0,
        voiced: true,
        raw_duration_ms: duration_ms,
        trimmed_head_ms: 0,
        trimmed_tail_ms: 0,
    };
    if let Ok(mut d) = debug_rec().lock() {
        *d = Some((session_id.clone(), rec));
    }
    let mut session = config().lock().map(|c| c.session.clone()).unwrap_or_default();
    session.segment_mode = SegmentMode::Utterance;
    session.streaming_inject = false;
    dispatch(Input::Press {
        binding: BindingId::DictateToggle,
        at_ms: now_ms(),
        gate: Gate::Open,
        config: session,
        new_session_id: session_id.clone(),
    });
    // 过短阈值之下的录音会被当误触丢弃，模拟时至少录够阈值。
    let wait = duration_ms.max(machine::TOO_SHORT_MS + 200);
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(wait));
        if matches!(session_info(&session_id), Some((_, _, Phase::Recording))) {
            dispatch(Input::Intent {
                intent: Intent::Finish,
                at_ms: now_ms(),
            });
        }
    });
    Ok(())
}
