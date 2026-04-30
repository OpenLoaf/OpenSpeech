// OpenLoaf SaaS realtime ASR 会话编排（V4 通道：`OL-TL-RT-002` / Qwen3-ASR-Flash-Realtime）。
//
// 职责：
// 1. `stt_start`  —— 前端在 recording 态进入时调用；从 openloaf state 拿已登录
//    SaaSClient，调 `client.tools_v4().realtime_asr_llm_ol_tl_rt_002(...)` 打开 WebSocket
//    （SDK 内部自动发 start 帧，把 params 序列化进去）。服务端固定按 16kHz mono pcm16
//    解码，sample rate / channel / encoding 都不需要客户端告知；payload 由 audio
//    callback 重采样到 16k 后送进来。
//    入参 `mode`：
//       "manual" ⇒ vadMode = None（**默认 / 推荐**）。整段录音视为一句话；松手时
//                  send `finish` 才出唯一一个 Final。"按下到松开 = 一次完整对话"。
//                  push-to-talk 听写场景文档明确推荐：模型有完整上下文 → 更准；
//                  不会被 VAD 误切（用户停顿 >500ms 不会丢前文）。
//       "auto"   ⇒ vadMode = ServerVad。服务端按停顿自动切句，多次 Final，客户端
//                  按 sentenceId 累积拼接。仅适合会议字幕 / 直播 / 同传等需要按句
//                  独立 transcript 的无人值守场景。
//    依据：~/.agents/skills/openloaf-saas-sdk/tools/OL-TL-RT-002-realtime-asr-llm.md
// 2. `stt_finalize` —— 前端在 hotkey 释放、录音 stop 之后调用。让 worker 调
//    session.finish()，阻塞等最多 FINALIZE_WAIT_MS 拿 Final 事件里的最终文字。
// 3. `stt_cancel` —— Esc / 误触时调用。让 worker 立即退出，不等 Final。
//
// 线程模型（关键）：
// `RealtimeAsrSession` 内部用 `std::sync::mpsc::Receiver`（!Sync），**不可以 Arc 跨线程
// 共享**——SDK 文档里"send_/recv_ 可在不同线程并发"的说法仅在 mpsc 单消费者
// 约定下成立（实际上 SDK 的背后 worker 线程是唯一消费者）。因此这里采用"session 单
// 所有者"模式：
// - 专用 `openspeech-stt` 线程独占 `RealtimeAsrSession`。
// - 所有外部输入（PCM 帧 / finish / stop）走 `mpsc::Sender<Control>` → worker 在
//   主循环里 try_recv 排空后再 `next_event_timeout(30ms)` 拉服务端事件。
// - audio 回调调 `try_send_audio_pcm16(...)` 丢字节到控制通道——try_lock 失败 /
//   worker 已退出则静默丢帧，不阻塞 audio callback。
//
// 累积策略（防"打断后前面消失"）：
// - Auto 模式服务端 VAD 会切多段 Final。用 BTreeMap<sentence_id, text> 按 id 排序累积，
//   避免乱序导致句序错乱；partial 时拼"已 Final 全部 + 当前句 partial"给 UI。
// - Manual 模式只会拿到一个 sentence_id 的 Final，逻辑上同样兼容。
//
// 生命周期：stt_finalize / stt_cancel / 会话意外断开 → worker 收 Stop 或
// 通道断开 → break 返回 → RealtimeAsrSession 随局部变量 drop → SDK 的 Drop
// 自动发 Close 帧 + join 内部 worker + 关 tungstenite socket。
//
// 坑位：
// - idle 60s 服务端主动关：持续发帧即可续活，hold-to-speak 天然满足。
// - 余额不足：先 `credits{warning:"low_balance"}` 再 `closed{reason:"insufficient_credits"}`。
// - 401：realtime 自身的 WebSocket 握手不接 401 重试；改成 stt_start 进 blocking 前
//   先调 OpenLoafState::ensure_access_token_fresh —— JWT exp ≤ 30s 才主动用
//   refresh_token 续期，握手时一定拿到的是新鲜 access_token。续期失败 → 走
//   handle_session_expired 等价 REST 的 refresh-fail 清场路径。

use std::collections::BTreeMap;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use openloaf_saas::{SaaSError, SaaSResult};
use openloaf_saas::v4_tools::{
    RealtimeAsrLlmLanguage, RealtimeAsrLlmOlTlRt002Params, RealtimeAsrLlmVadMode,
    RealtimeAsrSession, RealtimeEvent, SpeechRefineOlTl005Input,
    SpeechRefineOlTl005StreamEvent,
};
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::openloaf::{OpenLoafState, SharedOpenLoaf, handle_session_expired};

/// 业务路径稳定错误码：前端按这个串路由（弹登录框 / cancel 录音），不要改文案。
const ERR_UNAUTHORIZED: &str = "unauthorized";
const ERR_NOT_AUTHENTICATED: &str = "not authenticated";

fn is_unauthorized(msg: &str) -> bool {
    msg.contains("401") || msg.contains("Unauthorized") || msg.contains("unauthorized")
}

const EVENT_PARTIAL: &str = "openspeech://asr-partial";
const EVENT_FINAL: &str = "openspeech://asr-final";
const EVENT_ERROR: &str = "openspeech://asr-error";
const EVENT_CLOSED: &str = "openspeech://asr-closed";
const EVENT_CREDITS: &str = "openspeech://asr-credits";
const EVENT_REFINE_DELTA: &str = "openspeech://refine-delta";
// 服务端 WS 握手成功后会发 Ready，携带本次会话的 sessionId。前端把它当作
// 后续 refine 调用 task_id 透传，关联 ASR/Realtime 与口语优化两侧日志。
const EVENT_READY: &str = "openspeech://stt-ready";

/// send_finish 后等 Final 的最长时间。服务端典型 < 500ms，3s 能兜住抖动；
/// 超时走空串，前端自行决定是否把 history 标 failed。
const FINALIZE_WAIT_MS: u64 = 3000;
/// worker 每轮 next_event_timeout 的超时。太短空转多，太长 stop 响应迟。
const EVENT_POLL_MS: u64 = 30;
/// 容忍连续 decode error 次数：超过则认定协议崩坏退出。
/// 服务端偶发某字段为 null（典型 60s 心跳的 credits 事件 `consumed_seconds` /
/// `remaining_credits` 是 f64 无 Option，端上偶发 null 解码失败）属于单条坏消息，
/// SDK 那条消息已被 ws.read 消费，下次循环读下一条即可恢复；持续解码失败才视为
/// 真协议崩坏。
const MAX_CONSECUTIVE_DECODE_ERRORS: u32 = 5;

/// worker 主循环里消费的控制消息。音频数据、finish、停止都走这一个通道，
/// 保证顺序与 session 独占性——worker 先排空通道再 next_event。
enum Control {
    Audio(Vec<u8>),
    Finish,
    Stop,
}

struct SessionState {
    ctrl_tx: mpsc::Sender<Control>,
    worker: Option<JoinHandle<()>>,
    /// sentence_id → 该句最终文字。BTreeMap 保证按 sentenceId 顺序拼接，
    /// 即便 Final 事件乱序到达也不会影响最终拼接顺序。
    final_segments: Arc<Mutex<BTreeMap<i64, String>>>,
    /// 已收到的 Final 段总数；finalize 用它判断"段是否还在增长"做尾部等待。
    final_count: Arc<AtomicI64>,
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
        let _ = s.ctrl_tx.send(Control::Audio(bytes));
    }
}

#[derive(Debug, Clone, Serialize)]
struct ErrorPayload {
    code: String,
    message: String,
}

pub fn close_if_active() {
    let state = slot().lock().ok().and_then(|mut g| g.take());
    if let Some(mut state) = state {
        state.stop_signal.store(true, Ordering::Relaxed);
        let _ = state.ctrl_tx.send(Control::Stop);
        if let Some(h) = state.worker.take() {
            let _ = h.join();
        }
    }
}

fn parse_language(lang: Option<&str>) -> RealtimeAsrLlmLanguage {
    match lang.map(|s| s.trim().to_ascii_lowercase()) {
        Some(ref s) if s == "auto" || s.is_empty() => RealtimeAsrLlmLanguage::Auto,
        Some(ref s) if s == "zh" || s == "zh-cn" || s == "zh-tw" => RealtimeAsrLlmLanguage::Zh,
        Some(ref s) if s == "en" || s.starts_with("en-") => RealtimeAsrLlmLanguage::En,
        Some(ref s) if s == "ja" => RealtimeAsrLlmLanguage::Ja,
        Some(ref s) if s == "ko" => RealtimeAsrLlmLanguage::Ko,
        Some(ref s) if s == "yue" => RealtimeAsrLlmLanguage::Yue,
        _ => RealtimeAsrLlmLanguage::Auto,
    }
}

fn parse_mode(mode: Option<&str>) -> RealtimeAsrLlmVadMode {
    // 默认 None（manual）：与前端 settings 默认值一致 + 符合文档对 push-to-talk
    // 听写的推荐。前端如果没传 mode 也走 manual 兜底。
    match mode.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("auto") | Some("server_vad") | Some("server-vad") => RealtimeAsrLlmVadMode::ServerVad,
        _ => RealtimeAsrLlmVadMode::None,
    }
}

/// async + spawn_blocking：stt_start 内部 `close_if_active()` 会 join 上一轮
/// worker，最坏可等一整个 next_event_timeout（30ms）+ SDK Drop 发 Close 帧 +
/// 关 socket 的几十 ms。同步 command 会占用 Tauri 命令线程池的一个 worker。
#[tauri::command]
pub async fn stt_start<R: Runtime>(
    app: AppHandle<R>,
    lang: Option<String>,
    mode: Option<String>,
) -> Result<(), String> {
    log::info!(
        "[stt] stt_start request lang={:?} mode={:?}",
        lang,
        mode
    );
    // realtime 不走 call_authed，握手 401 服务端就会直接断。这里先按 JWT exp
    // 做新鲜度检查，临近过期（≤30s）就立刻用 refresh_token 续期；续期失败等价
    // REST 链路里 refresh-fail 的清场（handle_session_expired），让前端弹登录框。
    {
        let ol = app.state::<SharedOpenLoaf>();
        if !ol.ensure_access_token_fresh().await {
            log::warn!(
                "[stt] stt_start aborted: ensure_access_token_fresh returned false (no/expired token, refresh failed)"
            );
            handle_session_expired(&app, &ol);
            return Err(ERR_NOT_AUTHENTICATED.to_string());
        }
    }

    tauri::async_runtime::spawn_blocking(move || stt_start_impl(app, lang, mode))
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
    mode: Option<String>,
) -> Result<(), String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        log::warn!("[stt] stt_start aborted: authenticated_client() = None (not logged in)");
        // 没 access_token 就是未登录态——通知前端，不要走录音路径浪费用户力气。
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    // 兜底校验"stream 是否在跑"。新版 audio_level_start 已同步等到 stream_info
    // 写入才返回，理论上这里第一次读就有值；保留短自旋是为了覆盖：
    //   - 老版本前端绕过 await 直接调 stt_start
    //   - 切换设备瞬间（旧 stream 已 drop，新 stream 还差几 ms 写入）
    // 总等待上限 200ms，对用户无感知。服务端 OL-TL-RT-002 固定 16kHz mono pcm16 解码。
    let stream_ready = (0..10).any(|i| {
        if i > 0 {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        crate::audio::current_stream_info().is_some()
    });
    if !stream_ready {
        log::warn!("[stt] stt_start aborted: audio stream not running (start mic first)");
        return Err("audio stream not running; start mic first".to_string());
    }

    // 保险：旧 session 没清干净（上一次 finalize 崩了等）先兜底关。
    close_if_active();

    let language = parse_language(lang.as_deref());
    let vad_mode = parse_mode(mode.as_deref());

    let params = RealtimeAsrLlmOlTlRt002Params {
        language: Some(language),
        vad_mode: Some(vad_mode),
        ..Default::default()
    };

    let sess = client
        .tools_v4()
        .realtime_asr_llm_ol_tl_rt_002(&params)
        .map_err(|e| {
            let raw = e.to_string();
            // realtime 不走 call_authed，401 由 WebSocket 握手返回，需要这里兜
            // 一次清场 + 广播，等价于 REST 的自动 refresh-fail 路径。
            if is_unauthorized(&raw) {
                log::warn!("[stt] realtime connect 401, treating as session expired: {raw}");
                handle_session_expired(&app, &ol);
                ERR_UNAUTHORIZED.to_string()
            } else {
                log::error!("[stt] realtime connect failed: {raw}");
                format!("realtime connect: {e}")
            }
        })?;

    let (ctrl_tx, ctrl_rx) = mpsc::channel::<Control>();
    let stop_signal = Arc::new(AtomicBool::new(false));
    let final_segments: Arc<Mutex<BTreeMap<i64, String>>> = Arc::new(Mutex::new(BTreeMap::new()));
    let final_count = Arc::new(AtomicI64::new(0));

    let stop_worker = stop_signal.clone();
    let final_worker = final_segments.clone();
    let count_worker = final_count.clone();
    let app_worker = app.clone();

    let worker = thread::Builder::new()
        .name("openspeech-stt".into())
        .spawn(move || {
            run_worker(
                app_worker,
                sess,
                ctrl_rx,
                stop_worker,
                final_worker,
                count_worker,
            )
        })
        .map_err(|e| format!("spawn stt worker: {e}"))?;

    *slot().lock().map_err(|e| e.to_string())? = Some(SessionState {
        ctrl_tx,
        worker: Some(worker),
        final_segments,
        final_count,
        stop_signal,
    });
    log::info!(
        "[stt] session started (variant=OL-TL-RT-002 lang={:?} vad={:?})",
        language,
        vad_mode
    );
    Ok(())
}

/// next_event_timeout 结果分类（纯函数，副作用全部上提到 run_worker，便于单测）。
#[derive(Debug)]
enum LoopAction {
    /// 拿到一个事件，交给 handle_event 处理。
    Process(RealtimeEvent),
    /// 超时 / 通道断开，下一轮继续。
    Idle,
    /// 单条消息解码失败：emit asr-error 但不退出 —— SDK 已消费该坏消息，
    /// 下次能读到下一条；连续失败由 run_worker 的计数器把关。
    DecodeRecoverable(String),
    /// 网络层退出：与 SDK Drop 路径一致，安静退出。
    ExitNetwork(String),
}

fn classify_event_result(r: SaaSResult<Option<RealtimeEvent>>) -> LoopAction {
    match r {
        Ok(Some(ev)) => LoopAction::Process(ev),
        Ok(None) => LoopAction::Idle,
        Err(SaaSError::Network(msg)) => LoopAction::ExitNetwork(msg),
        Err(SaaSError::Decode(msg)) => LoopAction::DecodeRecoverable(msg),
        Err(e) => LoopAction::DecodeRecoverable(e.to_string()),
    }
}

fn run_worker<R: Runtime>(
    app: AppHandle<R>,
    sess: RealtimeAsrSession,
    ctrl_rx: mpsc::Receiver<Control>,
    stop: Arc<AtomicBool>,
    final_segments: Arc<Mutex<BTreeMap<i64, String>>>,
    final_count: Arc<AtomicI64>,
) {
    // 退出原因：用于决定是否要给前端发 worker_dead 信号。
    // - Stop:        Control::Stop / stop_signal / 通道断开 —— 是上层主动收尾，
    //                finalize/cancel 流程会自己驱动 UI；不发额外信号。
    // - ServerEnd:   handle_event 返回 true（收到 Closed/Error）—— 已经在
    //                handle_event 里 emit 过 EVENT_CLOSED/ERROR，不再重复。
    // - WorkerDead:  非 Stop 路径下 worker 自己决定退出（连续 decode 错误 / 网络断）——
    //                需要主动 emit 兜底事件，让前端立即停录音 + 切 error，避免出现
    //                "音频还在录但 STT 已死，松手 finalize 才发现 segs=0"。
    enum ExitReason {
        Stop,
        ServerEnd,
        WorkerDead(&'static str),
    }

    let mut consecutive_decode_errs: u32 = 0;
    let exit_reason: ExitReason = 'outer: loop {
        if stop.load(Ordering::Relaxed) {
            break 'outer ExitReason::Stop;
        }

        // 1) 排空控制通道（非阻塞）：音频帧直接转发、finish/stop 改 session 状态 / 退出。
        let ctrl_exit = loop {
            match ctrl_rx.try_recv() {
                Ok(Control::Audio(bytes)) => {
                    if let Err(e) = sess.send_audio(bytes) {
                        log::debug!("[stt] send_audio: {e}");
                    }
                }
                Ok(Control::Finish) => {
                    if let Err(e) = sess.finish() {
                        log::warn!("[stt] finish: {e}");
                    }
                }
                Ok(Control::Stop) => break Some(ExitReason::Stop),
                Err(mpsc::TryRecvError::Empty) => break None,
                Err(mpsc::TryRecvError::Disconnected) => break Some(ExitReason::Stop),
            }
        };
        if let Some(r) = ctrl_exit {
            break 'outer r;
        }

        // 2) 拉服务端事件（短超时让控制通道 / stop_signal 及时响应）。
        let action = classify_event_result(
            sess.next_event_timeout(Duration::from_millis(EVENT_POLL_MS)),
        );
        match action {
            LoopAction::Process(ev) => {
                consecutive_decode_errs = 0;
                if handle_event(&app, ev, &final_segments, &final_count) {
                    break 'outer ExitReason::ServerEnd;
                }
            }
            LoopAction::Idle => {}
            LoopAction::DecodeRecoverable(msg) => {
                consecutive_decode_errs += 1;
                log::warn!(
                    "[stt] decode error (skipping, {consecutive_decode_errs}/{MAX_CONSECUTIVE_DECODE_ERRORS}): {msg}"
                );
                // 单条坏消息不打扰用户：只在预算耗尽真正放弃会话时，由 worker_dead
                // 分支兜底发 EVENT_CLOSED；中间的可恢复错误只记日志，不 emit。
                if consecutive_decode_errs >= MAX_CONSECUTIVE_DECODE_ERRORS {
                    break 'outer ExitReason::WorkerDead("decode_errors");
                }
            }
            LoopAction::ExitNetwork(msg) => {
                log::info!("[stt] worker exit on network: {msg}");
                break 'outer ExitReason::WorkerDead("network");
            }
        }
    };

    // sess 随局部变量 drop → RealtimeAsrSession::drop 发 Close 帧 + 关 socket。
    log::info!("[stt] worker loop ended");

    if let ExitReason::WorkerDead(reason) = exit_reason {
        // 前端 asr-closed 的 reason="worker_dead" 分支会立刻 stopMic + 切 error。
        // detail 字段透传给可观察性，前端不依赖它做路由。
        let _ = app.emit(
            EVENT_CLOSED,
            json!({
                "reason": "worker_dead",
                "detail": reason,
                "totalCredits": serde_json::Value::Null,
            }),
        );
    }
}

fn merge_segments(map: &BTreeMap<i64, String>) -> String {
    let mut out = String::new();
    for v in map.values() {
        out.push_str(v);
    }
    out
}

fn handle_event<R: Runtime>(
    app: &AppHandle<R>,
    ev: RealtimeEvent,
    final_segments: &Arc<Mutex<BTreeMap<i64, String>>>,
    final_count: &Arc<AtomicI64>,
) -> bool {
    match ev {
        RealtimeEvent::Ready { session_id, .. } => {
            log::info!(
                "[stt] realtime Ready (WS handshake complete, server ready to ingest audio) session_id={session_id}"
            );
            let _ = app.emit(EVENT_READY, json!({ "sessionId": session_id }));
        }
        RealtimeEvent::Partial { sentence_id, text } => {
            // partial 只反映「当前 sentence_id 这一句」从开口到现在的累积，前面已 Final
            // 的句子不会再回放。给 UI 一个连贯的 liveTranscript：把所有 Final 段（按
            // sentenceId 顺序）+ 当前 partial 拼起来；当前 partial 必须排除已经 Final
            // 的同 sentence_id（极少数乱序场景下保护不回退）。
            let combined = if let Ok(g) = final_segments.lock() {
                let mut s = String::new();
                for (&sid, v) in g.iter() {
                    if sid == sentence_id {
                        continue;
                    }
                    s.push_str(v);
                }
                if !text.is_empty() {
                    s.push_str(&text);
                }
                s
            } else {
                text
            };
            let _ = app.emit(EVENT_PARTIAL, combined);
        }
        RealtimeEvent::Final {
            sentence_id, text, ..
        } => {
            // 累积，不覆盖：按 sentenceId 索引存，避免同 id 的重复 Final 把内容写两次，
            // 同时保证乱序到达也能按 id 顺序拼接。
            let combined = if let Ok(mut g) = final_segments.lock() {
                let inserted = !g.contains_key(&sentence_id);
                g.insert(sentence_id, text);
                if inserted {
                    final_count.fetch_add(1, Ordering::Relaxed);
                }
                merge_segments(&g)
            } else {
                String::new()
            };
            let _ = app.emit(EVENT_FINAL, combined);
        }
        RealtimeEvent::Credits {
            remaining_credits, ..
        } => {
            // None = 服务端把 Infinity 序列化成 null（典型 internal/无限账号）。
            // 前端 EVENT_CREDITS 收到 null 视为"未知/无限"，不参与余额展示与告警。
            log::info!("[stt] credits update: remaining={remaining_credits:?}");
            let _ = app.emit(EVENT_CREDITS, remaining_credits);
        }
        RealtimeEvent::Closed {
            reason,
            total_credits,
            ..
        } => {
            log::warn!(
                "[stt] server closed session: reason={reason:?} total_credits={total_credits:?}"
            );
            let _ = app.emit(
                EVENT_CLOSED,
                json!({ "reason": reason, "totalCredits": total_credits }),
            );
            return true;
        }
        RealtimeEvent::Error { code, message } => {
            log::error!("[stt] server error: code={code} message={message}");
            let _ = app.emit(EVENT_ERROR, ErrorPayload { code, message });
            return true;
        }
    }
    false
}

/// 录音正常结束时调。发 finish 提示服务端"音频已送完"，等服务端把
/// 累积的所有 Final 段（VAD 分段）发完后，按 sentenceId 顺序拼成一整段返回。
///
/// 返回值：拼接后的最终文字；空串表示一段 Final 都没拿到（超时 / 全程静音）。
///
/// async + spawn_blocking：实现里有最长 FINALIZE_WAIT_MS 的轮询 + worker
/// join，同步 command 会把 IPC 命令线程池堵死，重按快捷键时感觉整个 app 卡。
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

    // PCM 帧由 cpal 回调线程经 ctrl_tx 推进；finalize 由 IPC 线程发 Finish。
    // 两个生产者抢同一个 channel，没有屏障保证"尾部 audio 已全部入 channel"。
    // 若 Finish 抢在最后一批 PCM 之前到达 worker，服务端会收到截断的音频后立刻
    // 被告知"无更多数据"，从而没产出 Final、credits=0 直接 Closed（已观察到）。
    // 简易兜底：发 Finish 前留一个短窗口让 audio callback 把残余帧 push 完。
    thread::sleep(Duration::from_millis(120));

    // 让 worker 在下一轮排空通道时代发 finish。
    let _ = state.ctrl_tx.send(Control::Finish);

    // 服务端 VAD 会把长录音切成多段 Final。这里要等到「本轮所有段都到齐」再返回，
    // 否则会丢 finish 之后才到的 tail Final。Manual 模式只有一段 Final，逻辑同样兜得住。
    //
    // 策略：以 finalize 调用瞬间为 t=0：
    //   1. 至少等 MIN_TAIL_WAIT_MS（给 tail Final 一个时间窗，实测 ~500ms 后到）
    //   2. 之后若在 LAST_FINAL_QUIET_MS 内没有新段到达，认为已稳定，返回
    //   3. 整体最长 FINALIZE_WAIT_MS，超时直接拼现有段返回
    const MIN_TAIL_WAIT_MS: u128 = 800;
    const LAST_FINAL_QUIET_MS: u128 = 500;
    let start = Instant::now();
    let mut last_seg_count = state.final_count.load(Ordering::Relaxed);
    let mut last_change_ms: u128 = 0;
    let combined = loop {
        let count = state.final_count.load(Ordering::Relaxed);
        let elapsed_ms = start.elapsed().as_millis();
        if count != last_seg_count {
            last_seg_count = count;
            last_change_ms = elapsed_ms;
        }
        let stable_for = elapsed_ms.saturating_sub(last_change_ms);
        let waited_enough = elapsed_ms >= MIN_TAIL_WAIT_MS;
        if waited_enough && last_seg_count > 0 && stable_for >= LAST_FINAL_QUIET_MS {
            let snapshot = state
                .final_segments
                .lock()
                .map(|g| merge_segments(&g))
                .unwrap_or_default();
            break snapshot;
        }
        if elapsed_ms > FINALIZE_WAIT_MS as u128 {
            log::warn!(
                "[stt] finalize timeout after {}ms (segs={})",
                elapsed_ms,
                last_seg_count
            );
            let snapshot = state
                .final_segments
                .lock()
                .map(|g| merge_segments(&g))
                .unwrap_or_default();
            break snapshot;
        }
        thread::sleep(Duration::from_millis(20));
    };

    state.stop_signal.store(true, Ordering::Relaxed);
    let _ = state.ctrl_tx.send(Control::Stop);
    if let Some(h) = state.worker.take() {
        let _ = h.join();
    }

    Ok(combined)
}

/// 用户 Esc / 误触 / 前端异常时调。立即关 session，不等 Final，不返回文本。
///
/// async + spawn_blocking：close_if_active 里 join worker 可能等数十 ms。
#[tauri::command]
pub async fn stt_cancel() {
    let _ = tauri::async_runtime::spawn_blocking(close_if_active).await;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineSpeechTextResult {
    pub refined_text: String,
    pub credits_consumed: f64,
    pub duration_ms: i64,
    pub warning: Option<String>,
    /// 服务端写入 / 续期后的热词缓存 ID；前端持久化后下一轮只发 ID 省网络。
    pub hotwords_cache_id: Option<String>,
}

/// 把整段 transcript 喂给 OL-TL-005 / speechRefine 做书面化整理。
/// 失败 / 短文本 / 超时一律由 SDK 回退为输入原文，前端拿到的 refined_text
/// 永远是"可用"的字符串；warning 透传给 UI 决定是否提示。
///
/// 热词缓存（v0.3.6+）：优先发 hotwords_cache_id 命中 Redis；服务端 410
/// HOTWORDS_CACHE_MISS 时若调用方还传了 hotwords，自动用明文重发一次刷新缓存。
#[tauri::command]
pub async fn refine_speech_text<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    hotwords: Option<String>,
    hotwords_cache_id: Option<String>,
    task_id: Option<String>,
    reference_context: Option<String>,
) -> Result<RefineSpeechTextResult, String> {
    {
        let ol = app.state::<SharedOpenLoaf>();
        if !ol.ensure_access_token_fresh().await {
            handle_session_expired(&app, &ol);
            return Err(ERR_NOT_AUTHENTICATED.to_string());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        refine_speech_text_impl(
            app,
            text,
            hotwords,
            hotwords_cache_id,
            task_id,
            reference_context,
        )
    })
    .await
    .map_err(|e| format!("refine_speech_text join: {e}"))?
}

fn refine_speech_text_impl<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    hotwords: Option<String>,
    hotwords_cache_id: Option<String>,
    task_id: Option<String>,
    reference_context: Option<String>,
) -> Result<RefineSpeechTextResult, String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    let hotwords_clean = hotwords
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let cache_id_clean = hotwords_cache_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let task_id_clean = task_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let reference_context_clean = reference_context
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let build_input = |use_cache: bool| -> SpeechRefineOlTl005Input {
        let mut input = SpeechRefineOlTl005Input::new(text.clone());
        if use_cache {
            if let Some(id) = cache_id_clean.as_deref() {
                input = input.with_hotwords_cache_id(id);
            }
        } else if let Some(hw) = hotwords_clean.as_deref() {
            input = input.with_hotwords(hw);
        }
        if let Some(tid) = task_id_clean.as_deref() {
            input = input.with_task_id(tid);
        }
        if let Some(ctx) = reference_context_clean.as_deref() {
            input = input.with_reference_context(ctx);
        }
        input
    };

    let try_call = |input: &SpeechRefineOlTl005Input| {
        client.tools_v4().speech_refine_ol_tl_005(input)
    };

    let result = if cache_id_clean.is_some() {
        match try_call(&build_input(true)) {
            Ok(r) => r,
            Err(SaaSError::Http { status: 410, .. }) if hotwords_clean.is_some() => {
                log::info!("[stt] hotwords cache miss (410), retrying with literal hotwords");
                try_call(&build_input(false)).map_err(|e| map_refine_err(&app, &ol, e))?
            }
            Err(e) => return Err(map_refine_err(&app, &ol, e)),
        }
    } else {
        try_call(&build_input(false)).map_err(|e| map_refine_err(&app, &ol, e))?
    };

    Ok(RefineSpeechTextResult {
        refined_text: result.refined_text,
        credits_consumed: result.credits_consumed,
        duration_ms: result.duration_ms,
        warning: result.warning.map(|w| format!("{w:?}")),
        hotwords_cache_id: result.hotwords_cache_id,
    })
}

fn map_refine_err<R: Runtime>(
    app: &AppHandle<R>,
    ol: &OpenLoafState,
    e: SaaSError,
) -> String {
    let raw = e.to_string();
    if is_unauthorized(&raw) {
        handle_session_expired(app, ol);
        ERR_UNAUTHORIZED.to_string()
    } else {
        log::warn!("[stt] speech_refine_ol_tl_005 failed: {raw}");
        format!("speech_refine: {e}")
    }
}

/// 流式版 OL-TL-005：阻塞直到 stream Done，期间每个 Delta 都通过
/// `openspeech://refine-delta` 事件发到前端做逐字注入。命令返回值是最终
/// 整段 refined_text + cacheId（与非流式版一致），用于：(1) 写 history；
/// (2) 把整段写回剪贴板，覆盖 deltas 留下的最后一段。
///
/// 410 HOTWORDS_CACHE_MISS 由 `with_hotwords_cache_id` 建立 stream 时
/// 直接返回 SaaSError，这里捕获后用明文重开 stream。
#[tauri::command]
pub async fn refine_speech_text_stream<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    hotwords: Option<String>,
    hotwords_cache_id: Option<String>,
    task_id: Option<String>,
    reference_context: Option<String>,
) -> Result<RefineSpeechTextResult, String> {
    {
        let ol = app.state::<SharedOpenLoaf>();
        if !ol.ensure_access_token_fresh().await {
            handle_session_expired(&app, &ol);
            return Err(ERR_NOT_AUTHENTICATED.to_string());
        }
    }
    tauri::async_runtime::spawn_blocking(move || {
        refine_speech_text_stream_impl(
            app,
            text,
            hotwords,
            hotwords_cache_id,
            task_id,
            reference_context,
        )
    })
    .await
    .map_err(|e| format!("refine_speech_text_stream join: {e}"))?
}

fn refine_speech_text_stream_impl<R: Runtime>(
    app: AppHandle<R>,
    text: String,
    hotwords: Option<String>,
    hotwords_cache_id: Option<String>,
    task_id: Option<String>,
    reference_context: Option<String>,
) -> Result<RefineSpeechTextResult, String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    let hotwords_clean = hotwords
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let cache_id_clean = hotwords_cache_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let task_id_clean = task_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let reference_context_clean = reference_context
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string);

    let build_input = |use_cache: bool| -> SpeechRefineOlTl005Input {
        let mut input = SpeechRefineOlTl005Input::new(text.clone());
        if use_cache {
            if let Some(id) = cache_id_clean.as_deref() {
                input = input.with_hotwords_cache_id(id);
            }
        } else if let Some(hw) = hotwords_clean.as_deref() {
            input = input.with_hotwords(hw);
        }
        if let Some(tid) = task_id_clean.as_deref() {
            input = input.with_task_id(tid);
        }
        if let Some(ctx) = reference_context_clean.as_deref() {
            input = input.with_reference_context(ctx);
        }
        input
    };

    let open_stream = |input: &SpeechRefineOlTl005Input| {
        client.tools_v4().speech_refine_ol_tl_005_stream(input)
    };

    let stream = if cache_id_clean.is_some() {
        match open_stream(&build_input(true)) {
            Ok(s) => s,
            Err(SaaSError::Http { status: 410, .. }) if hotwords_clean.is_some() => {
                log::info!("[stt] refine stream cache miss (410), retrying with literal hotwords");
                open_stream(&build_input(false)).map_err(|e| map_refine_err(&app, &ol, e))?
            }
            Err(e) => return Err(map_refine_err(&app, &ol, e)),
        }
    } else {
        open_stream(&build_input(false)).map_err(|e| map_refine_err(&app, &ol, e))?
    };

    let mut final_refined = String::new();
    let mut final_duration_ms = 0i64;
    let mut final_credits = 0f64;
    let mut final_warning: Option<String> = None;
    let mut final_cache_id: Option<String> = None;
    let mut got_done = false;

    for evt in stream {
        let evt = evt.map_err(|e| map_refine_err(&app, &ol, e))?;
        match evt {
            SpeechRefineOlTl005StreamEvent::Delta { content } => {
                if !content.is_empty() {
                    let _ = app.emit(EVENT_REFINE_DELTA, content);
                }
            }
            SpeechRefineOlTl005StreamEvent::Done {
                refined_text,
                duration_ms,
                credits_consumed,
                hotwords_cache_id,
                warning,
            } => {
                final_refined = refined_text;
                final_duration_ms = duration_ms;
                final_credits = credits_consumed;
                final_cache_id = hotwords_cache_id;
                final_warning = warning.map(|w| format!("{w:?}"));
                got_done = true;
            }
            SpeechRefineOlTl005StreamEvent::Error { message } => {
                log::warn!("[stt] refine stream error event: {message}");
                return Err(format!("speech_refine_stream: {message}"));
            }
        }
    }

    if !got_done {
        return Err("speech_refine_stream: closed without Done frame".into());
    }

    Ok(RefineSpeechTextResult {
        refined_text: final_refined,
        credits_consumed: final_credits,
        duration_ms: final_duration_ms,
        warning: final_warning,
        hotwords_cache_id: final_cache_id,
    })
}

#[cfg(test)]
mod tests {
    //! 回归点：长录音 60s 后 worker 突然死亡 + 录音继续白录到松手才发现 segs=0。
    //! 根因：服务端心跳期发的某帧（典型为 credits）某 f64 字段为 null，SDK
    //! `serde_json::from_str::<RealtimeEvent>` 解码失败 → `SaaSError::Decode`。
    //! 旧 worker 把 `Err(_)` 一概当致命错误 `break 'outer`，整个 STT 会话当场死。
    //! 但 SDK 那条坏消息已被 `ws.read` 消费，下次循环可读到下一条 → decode 错误
    //! 应作为单条可恢复错误，仅在连续多次失败时才视为协议崩坏退出。

    use super::*;
    use openloaf_saas::SaaSError;
    use openloaf_saas::v4_tools::RealtimeEvent;

    fn assert_recoverable(action: LoopAction) {
        match action {
            LoopAction::DecodeRecoverable(_) => {}
            other => panic!(
                "expected DecodeRecoverable (worker should NOT exit on a single bad frame), got {other:?}"
            ),
        }
    }

    #[test]
    fn classify_processes_event() {
        let ev = RealtimeEvent::Partial {
            sentence_id: 1,
            text: "hello".into(),
        };
        assert!(matches!(
            classify_event_result(Ok(Some(ev))),
            LoopAction::Process(_)
        ));
    }

    #[test]
    fn classify_idle_on_none() {
        assert!(matches!(
            classify_event_result(Ok(None)),
            LoopAction::Idle
        ));
    }

    #[test]
    fn classify_network_exits() {
        let r: SaaSResult<Option<RealtimeEvent>> =
            Err(SaaSError::Network("connection reset".into()));
        match classify_event_result(r) {
            LoopAction::ExitNetwork(msg) => assert_eq!(msg, "connection reset"),
            other => panic!("expected ExitNetwork, got {other:?}"),
        }
    }

    /// SDK 0.3.7 修复：服务端 internal 账号每分钟计费心跳里 `remainingCredits=Infinity`
    /// 被 JS `JSON.stringify` 写成 null。0.3.7 把 Credits 三个 f64 改成 Option<f64>，
    /// 该 payload 现在解码为 `Credits { ..None.. }`，不再 decode error。
    #[test]
    fn credits_with_null_f64_field_is_decoded_to_none() {
        let payload = r#"{"type":"credits","consumedSeconds":null,"consumedCredits":0.0,"remainingCredits":1.5}"#;
        let ev = serde_json::from_str::<RealtimeEvent>(payload).expect(
            "SDK ≥ 0.3.7 必须把 null f64 视为 None；若失败说明 SDK 回退或被降级",
        );
        match ev {
            RealtimeEvent::Credits {
                consumed_seconds,
                consumed_credits,
                remaining_credits,
                ..
            } => {
                assert!(consumed_seconds.is_none());
                assert_eq!(consumed_credits, Some(0.0));
                assert_eq!(remaining_credits, Some(1.5));
            }
            other => panic!("expected Credits, got {other:?}"),
        }
    }

    /// Bug 1 修复点：SaaSError::Decode 必须不让 worker 退出。
    #[test]
    fn classify_saas_decode_error_is_recoverable() {
        let r: SaaSResult<Option<RealtimeEvent>> = Err(SaaSError::Decode(
            "invalid type: null, expected f64 at line 1 column 42".into(),
        ));
        assert_recoverable(classify_event_result(r));
    }

    /// 端到端：日志里那条会让旧 SDK 崩的 payload，在 0.3.7 上直接走 Process 分支。
    /// 这是上游修复的回归用例 —— 一旦失败说明计费心跳的 null 字段又能炸 worker。
    #[test]
    fn null_f64_credits_payload_flows_through_as_process() {
        let payload = r#"{"type":"credits","consumedSeconds":null,"consumedCredits":0.0,"remainingCredits":1.5}"#;
        let ev = serde_json::from_str::<RealtimeEvent>(payload).expect("0.3.7 应能解码");
        let r: SaaSResult<Option<RealtimeEvent>> = Ok(Some(ev));
        assert!(matches!(
            classify_event_result(r),
            LoopAction::Process(RealtimeEvent::Credits { .. })
        ));
    }

    /// 防御性：HTTP / Input 类错误如果在 next_event_timeout 路径上意外冒出，
    /// 也按可恢复处理（不该比 Network 更激进地杀会话）。
    #[test]
    fn classify_http_and_input_errors_are_recoverable() {
        let http: SaaSResult<Option<RealtimeEvent>> = Err(SaaSError::Http {
            status: 500,
            message: "internal".into(),
            body: None,
        });
        assert_recoverable(classify_event_result(http));

        let input: SaaSResult<Option<RealtimeEvent>> = Err(SaaSError::Input("bad".into()));
        assert_recoverable(classify_event_result(input));
    }

    /// 容错预算：连续 MAX_CONSECUTIVE_DECODE_ERRORS 次坏消息时退出，
    /// 期间任何一条好消息都应把计数清零。这里手动跑 run_worker 的同款决策步进逻辑。
    #[test]
    fn consecutive_decode_error_budget() {
        let mut consecutive: u32 = 0;
        let bump = |c: &mut u32| {
            *c += 1;
            *c >= MAX_CONSECUTIVE_DECODE_ERRORS
        };
        for i in 1..MAX_CONSECUTIVE_DECODE_ERRORS {
            assert!(!bump(&mut consecutive), "must not exit at iter {i}");
        }
        assert!(
            bump(&mut consecutive),
            "must exit once budget reached at iter {MAX_CONSECUTIVE_DECODE_ERRORS}"
        );
    }

    /// 错→好→错→错 的真实序列：good event 必须把累计 streak 归零，
    /// 否则单次偶发 null 长期叠加会被误判成"协议崩坏"提前杀会话。
    #[test]
    fn good_event_resets_decode_error_streak() {
        let make_decode = || -> SaaSResult<Option<RealtimeEvent>> {
            Err(SaaSError::Decode("null f64".into()))
        };
        let make_good = || -> SaaSResult<Option<RealtimeEvent>> {
            Ok(Some(RealtimeEvent::Partial {
                sentence_id: 1,
                text: "ok".into(),
            }))
        };

        // 模拟 run_worker 内累计语义。
        let mut streak: u32 = 0;
        for r in [make_decode(), make_decode(), make_good(), make_decode()] {
            match classify_event_result(r) {
                LoopAction::Process(_) => streak = 0,
                LoopAction::DecodeRecoverable(_) => streak += 1,
                other => panic!("unexpected branch: {other:?}"),
            }
        }
        assert_eq!(
            streak, 1,
            "good event 之后只剩 1 次错误，不应触达预算上限"
        );
        assert!(streak < MAX_CONSECUTIVE_DECODE_ERRORS);
    }
}
