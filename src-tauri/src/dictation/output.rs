// 听写文字输出：会话化的注入队列。
//
// 旧实现把「已敲到光标的前缀」存在前端模块级变量里，refine 一旦重置游标或旧会话的
// delta 迟到，就会把整段再敲一遍（用户看到的「先原文、再优化稿」双重输出）。
// 现在游标、目标 app、IME 判定都挂在 `OutputSession` 上，由唯一的输出线程串行处理：
// - job 的 session_id 与当前输出会话不符 → 直接丢弃；
// - 游标只在按键真正发出成功后才前移，tail 按游标差量补齐，永不重复。
//
// 线程：enigo / TIS（输入法）在 macOS 必须主线程调用，按键动作经 `on_main` 派回主线程；
// 本线程只做排队与判定，不会阻塞主线程事件循环。

use std::sync::{Mutex, OnceLock, mpsc};
use std::thread;
use std::time::Duration;

use serde::Serialize;
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

use crate::active_app::ActiveWindowInfo;

/// 注入时会吞 unicode keydown 的输入法：逐字 type 不落字，只能整段粘贴。
const BLOCKED_IME_PREFIXES: &[&str] = &[
    "com.apple.inputmethod.TCIM.",
    "com.apple.inputmethod.TYIM.",
    "im.rime.inputmethod.",
    "com.sogou.",
    "com.baidu.",
];

/// 自绘文本控件的 app：CGEvent unicode 键入报成功却不落字，AX 焦点判定也不可信。
const AX_UNRELIABLE_BUNDLE_IDS: &[&str] = &[
    "com.kingsoft.wpsoffice.mac",
    "com.microsoft.word",
    "com.microsoft.excel",
    "com.microsoft.powerpoint",
    "com.microsoft.onenote.mac",
    "com.tencent.xinwechat",
];
const AX_UNRELIABLE_NAME_NEEDLES: &[&str] = &[
    "wps office",
    "microsoft word",
    "microsoft excel",
    "microsoft powerpoint",
    "wechat",
    "微信",
];

/// 粘贴后等目标 app 消化 Cmd/Ctrl+V 再还原剪贴板，避免还原早于粘贴落地。
const CLIPBOARD_RESTORE_DELAY_MS: u64 = 80;

fn ime_blocks_unicode(id: Option<&str>) -> bool {
    id.is_some_and(|id| BLOCKED_IME_PREFIXES.iter().any(|p| id.starts_with(p)))
}

fn is_ax_unreliable(app: Option<&ActiveWindowInfo>) -> bool {
    let Some(app) = app else { return false };
    if let Some(id) = app.app_id.as_deref() {
        let lower = id.to_ascii_lowercase();
        if AX_UNRELIABLE_BUNDLE_IDS.contains(&lower.as_str()) {
            return true;
        }
    }
    let name = app.name.to_lowercase();
    AX_UNRELIABLE_NAME_NEEDLES.iter().any(|n| name.contains(n))
}

/// 当前前台 app 是否还是录音起点那个。拿不到任一侧信息时按「没变」处理。
fn same_app(target: &ActiveWindowInfo, current: &ActiveWindowInfo) -> bool {
    match (target.app_id.as_deref(), current.app_id.as_deref()) {
        (Some(a), Some(b)) => a == b,
        (_, None) => target.name == current.name,
        (None, Some(_)) => true,
    }
}

/// 在主线程同步执行（macOS TIS / enigo 的硬要求）。其它平台直接调用。
pub(super) fn on_main<T: Send, F: FnOnce() -> T + Send>(f: F) -> T {
    #[cfg(target_os = "macos")]
    {
        crate::mac_main_thread::run_sync(f)
    }
    #[cfg(not(target_os = "macos"))]
    {
        f()
    }
}

pub(super) fn active_window() -> Option<ActiveWindowInfo> {
    on_main(crate::active_app::get_active_window_info)
}

struct OutputSession {
    session_id: String,
    /// 已确认敲到光标的累计文本。
    cursor: String,
    /// 录音起点前台 app：流式注入的切窗防护按它比对（用户切走后不往别的 app 里打字）。
    target: Option<ActiveWindowInfo>,
    ime_blocked: Option<bool>,
    streaming: bool,
    clipboard_copy: bool,
}

fn current() -> &'static Mutex<Option<OutputSession>> {
    static CUR: OnceLock<Mutex<Option<OutputSession>>> = OnceLock::new();
    CUR.get_or_init(|| Mutex::new(None))
}

enum Job {
    Stream {
        session_id: String,
        text: String,
    },
    Finish {
        session_id: String,
        text: String,
        reply: mpsc::Sender<FinishOutcome>,
    },
}

fn queue(app: &AppHandle) -> &'static mpsc::Sender<Job> {
    static TX: OnceLock<mpsc::Sender<Job>> = OnceLock::new();
    TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<Job>();
        let app = app.clone();
        thread::Builder::new()
            .name("openspeech-dictation-output".into())
            .spawn(move || {
                for job in rx {
                    match job {
                        Job::Stream { session_id, text } => stream(&session_id, &text),
                        Job::Finish {
                            session_id,
                            text,
                            reply,
                        } => {
                            let _ = reply.send(finish(&app, &session_id, &text));
                        }
                    }
                }
            })
            .expect("spawn dictation output thread");
        tx
    })
}

/// 会话开始时登记输出目标。
pub(super) fn begin(
    session_id: &str,
    target: Option<ActiveWindowInfo>,
    streaming: bool,
    clipboard_copy: bool,
) {
    if let Ok(mut cur) = current().lock() {
        *cur = Some(OutputSession {
            session_id: session_id.to_string(),
            cursor: String::new(),
            target,
            ime_blocked: None,
            streaming,
            clipboard_copy,
        });
    }
}

/// 会话结束（完成 / 取消 / 失败）：之后到达的该会话输出全部丢弃。
pub(super) fn end(session_id: &str) {
    if let Ok(mut cur) = current().lock()
        && cur.as_ref().is_some_and(|s| s.session_id == session_id)
    {
        *cur = None;
    }
}

pub(super) fn is_current(session_id: &str) -> bool {
    current()
        .lock()
        .map(|cur| cur.as_ref().is_some_and(|s| s.session_id == session_id))
        .unwrap_or(false)
}

/// 流式增量：`text` 是到目前为止的完整文本，线程内按游标算差量。
pub(super) fn enqueue_stream(app: &AppHandle, session_id: &str, text: String) {
    let _ = queue(app).send(Job::Stream {
        session_id: session_id.to_string(),
        text,
    });
}

/// 收尾：排在所有流式 job 之后执行，阻塞等结果。
pub(super) fn finish_blocking(app: &AppHandle, session_id: &str, text: String) -> FinishOutcome {
    let (reply, rx) = mpsc::channel();
    if queue(app)
        .send(Job::Finish {
            session_id: session_id.to_string(),
            text,
            reply,
        })
        .is_err()
    {
        return FinishOutcome::Stale;
    }
    rx.recv().unwrap_or(FinishOutcome::Stale)
}

fn with_session<T>(session_id: &str, f: impl FnOnce(&mut OutputSession) -> T) -> Option<T> {
    let mut cur = current().lock().ok()?;
    let s = cur.as_mut().filter(|s| s.session_id == session_id)?;
    Some(f(s))
}

fn probe_ime(session_id: &str) -> bool {
    if let Some(Some(v)) = with_session(session_id, |s| s.ime_blocked) {
        return v;
    }
    let id = crate::ime::active_ime_id_cmd();
    let blocked = ime_blocks_unicode(id.as_deref());
    log::info!("[dictation-output] ime probe id={id:?} blocks_unicode_keydown={blocked}");
    with_session(session_id, |s| s.ime_blocked = Some(blocked));
    blocked
}

fn stream(session_id: &str, text: &str) {
    let Some((streaming, cursor, target)) = with_session(session_id, |s| {
        (s.streaming, s.cursor.clone(), s.target.clone())
    }) else {
        return;
    };
    // 关了逐字输出 / 自绘控件 app：本轮全交给 tail 整段粘贴。
    if !streaming || is_ax_unreliable(target.as_ref()) {
        return;
    }
    if probe_ime(session_id) {
        return;
    }
    let Some(delta) = text.strip_prefix(cursor.as_str()) else {
        return;
    };
    if delta.is_empty() {
        return;
    }
    // 切窗防护：按键永远打到当下前台，已切走就跳过本段，由 tail 在落点决定去向。
    if let (Some(target), Some(now)) = (target.as_ref(), active_window())
        && !same_app(target, &now)
    {
        log::info!(
            "[dictation-output] stream skip: app changed {} → {} delta={}",
            target.name,
            now.name,
            delta.chars().count()
        );
        return;
    }
    let delta = delta.to_string();
    match on_main(move || crate::inject::inject_type(delta)) {
        Ok(()) => {
            with_session(session_id, |s| s.cursor = text.to_string());
        }
        Err(e) => log::warn!("[dictation-output] stream type failed: {e}"),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FinishOutcome {
    /// 剩余部分已粘贴到光标。
    Pasted,
    /// 流式已覆盖全部文本，无需再粘贴。
    Complete,
    /// 焦点明确不可写：文本已写入剪贴板，前端展示结果面板。
    NotEditable,
    /// 已敲下的前缀与最终文本对不上：不强行接尾，文本写入剪贴板，前端展示结果面板。
    Diverged,
    /// 粘贴失败：文本已写入剪贴板，前端展示结果面板。
    PasteFailed,
    /// 会话已结束（取消 / 被新会话取代），什么都没做。
    Stale,
}

fn write_clipboard(app: &AppHandle, text: &str) {
    if let Err(e) = app.clipboard().write_text(text.to_string()) {
        log::warn!("[dictation-output] clipboard write failed: {e}");
    }
}

fn finish(app: &AppHandle, session_id: &str, text: &str) -> FinishOutcome {
    let Some((cursor, target, clipboard_copy)) = with_session(session_id, |s| {
        (s.cursor.clone(), s.target.clone(), s.clipboard_copy)
    }) else {
        return FinishOutcome::Stale;
    };
    // 焦点可写性等到真正要写字时现场判定：录音开始时焦点不可信。
    let focus_editable = on_main(crate::focus_check::focus_is_editable_cmd);
    let ax_unreliable = is_ax_unreliable(target.as_ref());
    log::info!(
        "[dictation-output] finish focus_editable={focus_editable:?} ax_unreliable={ax_unreliable} typed={} final={}",
        cursor.chars().count(),
        text.chars().count()
    );
    if focus_editable == Some(false) && !ax_unreliable {
        write_clipboard(app, text);
        return FinishOutcome::NotEditable;
    }
    let Some(remaining) = text.strip_prefix(cursor.as_str()) else {
        write_clipboard(app, text);
        return FinishOutcome::Diverged;
    };
    if remaining.is_empty() {
        if clipboard_copy {
            write_clipboard(app, text);
        }
        return FinishOutcome::Complete;
    }
    let backup = if clipboard_copy {
        None
    } else {
        app.clipboard().read_text().ok()
    };
    write_clipboard(app, remaining);
    // 注音 / RIME 等输入法的 composition 由 inject_paste 内部的 ime_bypass 兜底。
    if let Err(e) = on_main(crate::inject::inject_paste) {
        log::warn!("[dictation-output] paste failed: {e}");
        write_clipboard(app, text);
        return FinishOutcome::PasteFailed;
    }
    with_session(session_id, |s| s.cursor = text.to_string());
    thread::sleep(Duration::from_millis(CLIPBOARD_RESTORE_DELAY_MS));
    if clipboard_copy {
        write_clipboard(app, text);
    } else {
        write_clipboard(app, backup.as_deref().unwrap_or(""));
    }
    FinishOutcome::Pasted
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(name: &str, id: Option<&str>) -> ActiveWindowInfo {
        ActiveWindowInfo {
            name: name.into(),
            title: String::new(),
            app_id: id.map(Into::into),
        }
    }

    #[test]
    fn detects_blocking_ime() {
        assert!(ime_blocks_unicode(Some("im.rime.inputmethod.Squirrel.Hans")));
        assert!(!ime_blocks_unicode(Some("com.apple.keylayout.ABC")));
        assert!(!ime_blocks_unicode(None));
    }

    #[test]
    fn detects_ax_unreliable_apps() {
        assert!(is_ax_unreliable(Some(&app("WeChat", Some("com.tencent.xinWeChat")))));
        assert!(is_ax_unreliable(Some(&app("微信", None))));
        assert!(!is_ax_unreliable(Some(&app("Ghostty", Some("com.mitchellh.ghostty")))));
    }

    #[test]
    fn app_change_prefers_bundle_id() {
        let a = app("Chrome", Some("com.google.Chrome"));
        assert!(same_app(&a, &app("Google Chrome", Some("com.google.Chrome"))));
        assert!(!same_app(&a, &app("Chrome", Some("com.apple.Safari"))));
        assert!(same_app(&app("Code", None), &app("Code", None)));
    }
}
