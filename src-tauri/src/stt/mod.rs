// OpenLoaf SaaS realtime ASR 会话编排。
//
// 职责：
// 1. `stt_start`  —— 前端在 recording 态进入时调用；从 openloaf state 拿已登录
//    SaaSClient，打开 `realtimeAsr` WebSocket，发 start 帧 `{language}`。
//    服务端固定按 16kHz mono pcm16 解码，sample rate / channel / encoding 都
//    不需要客户端告知；payload 由 audio callback 重采样到 16k 后送进来。
// 2. `stt_finalize` —— 前端在 hotkey 释放、录音 stop 之后调用。让 worker 发
//    send_finish，阻塞等最多 FINALIZE_WAIT_MS 拿 Final 事件里的最终文字。
// 3. `stt_cancel` —— Esc / 误触时调用。让 worker 立即退出，不等 Final。
//
// 线程模型（关键）：
// `RealtimeSession` 内部用 `std::sync::mpsc::Receiver`（!Sync），**不可以 Arc 跨线程
// 共享**——skill 文档里"send_\* 和 recv_\* 可在不同线程并发"的说法仅在 mpsc 单消费者
// 约定下成立（实际上 SDK 的背后 worker 线程是唯一消费者）。因此这里采用"session 单
// 所有者"模式：
// - 专用 `openspeech-stt` 线程独占 `RealtimeSession`。
// - 所有外部输入（PCM 帧 / finish / stop）走 `mpsc::Sender<Control>` → worker 在
//   主循环里 try_recv 排空后再 `recv_event_timeout(30ms)` 拉服务端事件。
// - audio 回调调 `try_send_audio_pcm16(...)` 丢字节到控制通道——try_lock 失败 /
//   worker 已退出则静默丢帧，不阻塞 audio callback。
//
// 生命周期：stt_finalize / stt_cancel / 会话意外断开 → worker 收 Stop 或
// Err(Network) → break 返回 → RealtimeSession 随局部变量 drop → SDK 的 Drop
// 自动发 Close 帧 + join 内部 worker + 关 tungstenite socket。
//
// 坑位（详见 .claude/skills/openloaf-saas-sdk-rust/SKILL.md）：
// - idle 60s 服务端主动关：持续发帧即可续活，hold-to-speak 天然满足。
// - 余额不足：先 `credits{warning:"low_balance"}` 再 `closed{reason:"insufficient_credits"}`。
// - 401：realtime 不会自动 refresh；假设 REST 链路已保持 token 新鲜，未登录直接拒。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use openloaf_saas::{RealtimeEvent, RealtimeSession, SaaSError};
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::openloaf::SharedOpenLoaf;

const EVENT_PARTIAL: &str = "openspeech://asr-partial";
const EVENT_FINAL: &str = "openspeech://asr-final";
const EVENT_ERROR: &str = "openspeech://asr-error";
const EVENT_CLOSED: &str = "openspeech://asr-closed";
const EVENT_CREDITS: &str = "openspeech://asr-credits";

// 服务端 feature 注册名是 `realtimeAsr`（小写 sr），不是 `realtimeASR`——
// 2026-04-25 发错全大写会在 WebSocket 握手阶段被服务端拒 500。
const FEATURE_ID: &str = "realtimeAsr";
/// send_finish 后等 Final 的最长时间。服务端典型 < 500ms，3s 能兜住抖动；
/// 超时走空串，前端自行决定是否把 history 标 failed。
const FINALIZE_WAIT_MS: u64 = 3000;
/// worker 每轮 recv_event_timeout 的超时。太短空转多，太长 stop 响应迟。
const EVENT_POLL_MS: u64 = 30;

/// worker 主循环里消费的控制消息。音频数据、send_finish、停止都走这一个通道，
/// 保证顺序与 session 独占性——worker 先排空通道再 recv_event。
enum Control {
    Audio(Vec<u8>),
    Finish,
    Stop,
}

struct SessionState {
    ctrl_tx: mpsc::Sender<Control>,
    worker: Option<JoinHandle<()>>,
    final_text: Arc<Mutex<Option<String>>>,
    stop_signal: Arc<AtomicBool>,
}

fn slot() -> &'static Mutex<Option<SessionState>> {
    static S: OnceLock<Mutex<Option<SessionState>>> = OnceLock::new();
    S.get_or_init(|| Mutex::new(None))
}

/// 供 audio 回调调：若有激活 session 就把 PCM16 LE bytes 入队。
/// try_lock 失败（stt_start/finalize 正在改 slot）或无 session 时静默丢帧，
/// 不阻塞 audio callback。
pub fn try_send_audio_pcm16(bytes: Vec<u8>) {
    let Ok(guard) = slot().try_lock() else {
        return;
    };
    if let Some(s) = guard.as_ref() {
        // `send` 只会在 receiver 已 drop（worker 已退出）时失败——不需要处理。
        let _ = s.ctrl_tx.send(Control::Audio(bytes));
    }
}

#[derive(Debug, Clone, Serialize)]
struct ErrorPayload {
    code: String,
    message: String,
}

fn close_if_active() {
    let state = slot().lock().ok().and_then(|mut g| g.take());
    if let Some(mut state) = state {
        state.stop_signal.store(true, Ordering::Relaxed);
        // 发 Stop 让 worker 立刻跳出 recv_event_timeout 的等待循环。
        let _ = state.ctrl_tx.send(Control::Stop);
        if let Some(h) = state.worker.take() {
            let _ = h.join();
        }
    }
}

/// async + spawn_blocking：stt_start 内部 `close_if_active()` 会 join 上一轮
/// worker，最坏可等一整个 recv_event_timeout（30ms）+ SDK Drop 发 Close 帧 +
/// 关 socket 的几十 ms。同步 command 会占用 Tauri 命令线程池的一个 worker，
/// 跟 stt_finalize / audio_level_stop 挤一起就可能让 UI 感觉卡。
#[tauri::command]
pub async fn stt_start<R: Runtime>(
    app: AppHandle<R>,
    lang: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || stt_start_impl(app, lang))
        .await
        .map_err(|e| format!("stt_start join: {e}"))?
        .map_err(|e| {
            log::warn!("[stt] start failed: {e}");
            e
        })
}

fn stt_start_impl<R: Runtime>(
    app: AppHandle<R>,
    lang: Option<String>,
) -> Result<(), String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol
        .authenticated_client()
        .ok_or_else(|| "not authenticated; login first".to_string())?;

    // 仅做"stream 是否在跑"的兜底校验——服务端 realtimeAsr 固定按 16kHz mono
    // pcm16 解码，**不接受**客户端传 sampleRate / channels / encoding。
    // 重采样到 16k + mono 下混都在 audio callback 里（push_to_stt_pcm16）完成。
    crate::audio::current_stream_info()
        .ok_or_else(|| "audio stream not running; start mic first".to_string())?;

    // 保险：旧 session 没清干净（上一次 finalize 崩了等）先兜底关。
    close_if_active();

    let sess = client
        .realtime()
        .connect(FEATURE_ID)
        .map_err(|e| format!("realtime connect: {e}"))?;
    // start 帧只认 `params.language`，inputs 是空对象（realtimeAsr 不带 tool 输入）。
    // 与 OpenLoaf-saas/scripts/test-realtime-asr-llm.ts 保持一致——多余字段会让
    // 服务端校验失败 / 静默忽略导致后续解码错位。
    sess.send_start(
        Some(json!({ "language": lang.unwrap_or_else(|| "zh".into()) })),
        Some(json!({})),
    )
    .map_err(|e| format!("send_start: {e}"))?;

    let (ctrl_tx, ctrl_rx) = mpsc::channel::<Control>();
    let stop_signal = Arc::new(AtomicBool::new(false));
    let final_text: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let stop_worker = stop_signal.clone();
    let final_worker = final_text.clone();
    let app_worker = app.clone();

    let worker = thread::Builder::new()
        .name("openspeech-stt".into())
        .spawn(move || run_worker(app_worker, sess, ctrl_rx, stop_worker, final_worker))
        .map_err(|e| format!("spawn stt worker: {e}"))?;

    *slot().lock().map_err(|e| e.to_string())? = Some(SessionState {
        ctrl_tx,
        worker: Some(worker),
        final_text,
        stop_signal,
    });
    log::info!("[stt] session started (feature={FEATURE_ID})");
    Ok(())
}

fn run_worker<R: Runtime>(
    app: AppHandle<R>,
    sess: RealtimeSession,
    ctrl_rx: mpsc::Receiver<Control>,
    stop: Arc<AtomicBool>,
    final_text: Arc<Mutex<Option<String>>>,
) {
    'outer: while !stop.load(Ordering::Relaxed) {
        // 1) 排空控制通道（非阻塞）：音频帧直接转发、finish/stop 改 session 状态 / 退出。
        loop {
            match ctrl_rx.try_recv() {
                Ok(Control::Audio(bytes)) => {
                    if let Err(e) = sess.send_audio(bytes) {
                        log::debug!("[stt] send_audio: {e}");
                    }
                }
                Ok(Control::Finish) => {
                    if let Err(e) = sess.send_finish() {
                        log::warn!("[stt] send_finish: {e}");
                    }
                }
                Ok(Control::Stop) => {
                    break 'outer;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    // 外部 Sender 全部 drop 了 = state 被取走并 drop；结束循环。
                    break 'outer;
                }
            }
        }

        // 2) 拉服务端事件（短超时让控制通道 / stop_signal 及时响应）。
        match sess.recv_event_timeout(Duration::from_millis(EVENT_POLL_MS)) {
            Ok(Some(ev)) => {
                if handle_event(&app, ev, &final_text) {
                    break 'outer;
                }
            }
            Ok(None) => {} // 超时，继续下一轮
            Err(SaaSError::Network(msg)) => {
                log::info!("[stt] worker exit on network: {msg}");
                break 'outer;
            }
            Err(e) => {
                log::warn!("[stt] recv_event: {e}");
                let _ = app.emit(
                    EVENT_ERROR,
                    ErrorPayload {
                        code: "recv_event".into(),
                        message: e.to_string(),
                    },
                );
                break 'outer;
            }
        }
    }

    // sess 随局部变量 drop → RealtimeSession::drop 发 Close 帧 + 关 socket。
    log::info!("[stt] worker loop ended");
}

fn handle_event<R: Runtime>(
    app: &AppHandle<R>,
    ev: RealtimeEvent,
    final_text: &Arc<Mutex<Option<String>>>,
) -> bool {
    match ev {
        RealtimeEvent::Ready { .. } => {}
        RealtimeEvent::Partial { text, .. } => {
            let _ = app.emit(EVENT_PARTIAL, text);
        }
        RealtimeEvent::Final { text, .. } => {
            if let Ok(mut g) = final_text.lock() {
                *g = Some(text.clone());
            }
            let _ = app.emit(EVENT_FINAL, text);
        }
        RealtimeEvent::Credits {
            remaining_credits, ..
        } => {
            let _ = app.emit(EVENT_CREDITS, remaining_credits);
        }
        RealtimeEvent::Closed {
            reason,
            total_credits,
            ..
        } => {
            let _ = app.emit(
                EVENT_CLOSED,
                json!({ "reason": reason, "totalCredits": total_credits }),
            );
            return true;
        }
        RealtimeEvent::Error { code, message } => {
            let _ = app.emit(EVENT_ERROR, ErrorPayload { code, message });
            return true;
        }
    }
    false
}

/// 录音正常结束时调。发 send_finish 提示服务端"音频已送完"，等最多
/// FINALIZE_WAIT_MS 拿 Final 事件里的最终文本，然后关 session。
///
/// 返回值：最终文字。超时时返回空串——前端据此写 history（text 为空时
/// 可以标 failed，或保留 placeholder，产品决定）。
///
/// async + spawn_blocking：实现里有最长 3s 的 final_text 轮询 + worker join，
/// 同步 command 会把 IPC 命令线程池堵死，重按快捷键时感觉整个 app 卡。
#[tauri::command]
pub async fn stt_finalize() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(stt_finalize_impl)
        .await
        .map_err(|e| format!("stt_finalize join: {e}"))?
}

fn stt_finalize_impl() -> Result<String, String> {
    let state = slot().lock().map_err(|e| e.to_string())?.take();
    let Some(mut state) = state else {
        return Err("no active stt session".into());
    };

    // 让 worker 在下一轮排空通道时代发 send_finish。
    let _ = state.ctrl_tx.send(Control::Finish);

    // 轮询 final_text，最多等 FINALIZE_WAIT_MS。拿到就立即返回 + 触发 worker 收尾。
    let start = Instant::now();
    let text = loop {
        if let Ok(g) = state.final_text.lock() {
            if let Some(t) = g.clone() {
                break t;
            }
        }
        if start.elapsed() > Duration::from_millis(FINALIZE_WAIT_MS) {
            log::warn!("[stt] finalize timeout: no Final in {FINALIZE_WAIT_MS} ms");
            break String::new();
        }
        thread::sleep(Duration::from_millis(20));
    };

    state.stop_signal.store(true, Ordering::Relaxed);
    let _ = state.ctrl_tx.send(Control::Stop);
    if let Some(h) = state.worker.take() {
        let _ = h.join();
    }

    Ok(text)
}

/// 用户 Esc / 误触 / 前端异常时调。立即关 session，不等 Final，不返回文本。
///
/// async + spawn_blocking：close_if_active 里 join worker 可能等数十 ms，
/// 同 stt_start 理由。
#[tauri::command]
pub async fn stt_cancel() {
    let _ = tauri::async_runtime::spawn_blocking(close_if_active).await;
}
