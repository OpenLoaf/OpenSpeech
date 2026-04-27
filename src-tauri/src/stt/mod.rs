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

use openloaf_saas::SaaSError;
use openloaf_saas::v4_tools::{
    RealtimeAsrLlmLanguage, RealtimeAsrLlmOlTlRt002Params, RealtimeAsrLlmVadMode,
    RealtimeAsrSession, RealtimeEvent,
};
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::openloaf::{SharedOpenLoaf, handle_session_expired};

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

/// send_finish 后等 Final 的最长时间。服务端典型 < 500ms，3s 能兜住抖动；
/// 超时走空串，前端自行决定是否把 history 标 failed。
const FINALIZE_WAIT_MS: u64 = 3000;
/// worker 每轮 next_event_timeout 的超时。太短空转多，太长 stop 响应迟。
const EVENT_POLL_MS: u64 = 30;

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

fn close_if_active() {
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

fn run_worker<R: Runtime>(
    app: AppHandle<R>,
    sess: RealtimeAsrSession,
    ctrl_rx: mpsc::Receiver<Control>,
    stop: Arc<AtomicBool>,
    final_segments: Arc<Mutex<BTreeMap<i64, String>>>,
    final_count: Arc<AtomicI64>,
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
                    if let Err(e) = sess.finish() {
                        log::warn!("[stt] finish: {e}");
                    }
                }
                Ok(Control::Stop) => {
                    break 'outer;
                }
                Err(mpsc::TryRecvError::Empty) => break,
                Err(mpsc::TryRecvError::Disconnected) => {
                    break 'outer;
                }
            }
        }

        // 2) 拉服务端事件（短超时让控制通道 / stop_signal 及时响应）。
        match sess.next_event_timeout(Duration::from_millis(EVENT_POLL_MS)) {
            Ok(Some(ev)) => {
                if handle_event(&app, ev, &final_segments, &final_count) {
                    break 'outer;
                }
            }
            Ok(None) => {} // 超时或 worker 已 disconnect；下一轮 try_recv 检测 Stop
            Err(SaaSError::Network(msg)) => {
                log::info!("[stt] worker exit on network: {msg}");
                break 'outer;
            }
            Err(e) => {
                log::warn!("[stt] next_event: {e}");
                let _ = app.emit(
                    EVENT_ERROR,
                    ErrorPayload {
                        code: "next_event".into(),
                        message: e.to_string(),
                    },
                );
                break 'outer;
            }
        }
    }

    // sess 随局部变量 drop → RealtimeAsrSession::drop 发 Close 帧 + 关 socket。
    log::info!("[stt] worker loop ended");
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
        RealtimeEvent::Ready { .. } => {
            log::info!("[stt] realtime Ready (WS handshake complete, server ready to ingest audio)");
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
            log::info!("[stt] credits update: remaining={remaining_credits}");
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
