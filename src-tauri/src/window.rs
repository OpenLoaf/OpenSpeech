// 主窗口显隐 / 聚焦 / Dock 图标策略。隐藏到托盘时让 audio 让位、macOS 切 Accessory；
// 唤出时切回 Regular 并抢前台。toggle/show 是 pub(crate)，被 hotkey 与 openloaf 跨模块调用。

use crate::audio;
use tauri::{Manager, Runtime};

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

// 主窗口可见时把进程切回 Regular（显示 Dock 图标 + 出现在 Cmd+Tab）。
// 与 hide_main_window 切 Accessory 配对：托盘隐藏期间 Dock 图标消失。
#[cfg(target_os = "macos")]
pub(crate) fn apply_dock_icon_policy<R: Runtime>(app: &tauri::AppHandle<R>) {
    let _ = app.set_activation_policy(ActivationPolicy::Regular);
}

fn hide_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    // macOS：切换到 Accessory 让 Dock 图标消失，应用变为"仅状态栏"。
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }
    // 主窗隐藏 = 用户明确想暂离 UI，audio 也得让位。否则 ref_count 上一轮漏减（webview
    // reload / PTT 被打断 / stt 错误路径未平衡）残留的 stream 会一直把 macOS 状态栏的
    // 麦克风指示灯钉亮，用户体感「OpenSpeech 没关麦克风」。
    // 用 force_stop 而不是 stop()——后者要求 ref_count 已经 0，但出现这种现象的前提
    // 恰恰就是 ref_count 没被减到 0。trade-off：极少数「PTT 录音中主窗被主动 hide」
    // 场景会被掐——但 PTT 期间用户在按键 + 看 overlay，不会同时主动收主窗，实际近 0。
    audio::force_stop();
}

/// 全局 toggle：可见 + 已聚焦 → 隐藏；其它一律 show + focus。
/// 拆出来给 ShowMainWindow hotkey 用——单一入口避免和 show_main_window
/// / hide_main_window 各自的竞态走两套路径。
#[track_caller]
pub(crate) fn toggle_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    let caller = std::panic::Location::caller();
    log::debug!(
        "[main_window] toggle_main_window called from {}:{}",
        caller.file(),
        caller.line()
    );
    let Some(window) = app.get_webview_window("main") else {
        show_main_window(app);
        return;
    };
    let visible = window.is_visible().unwrap_or(false);
    let focused = window.is_focused().unwrap_or(false);
    if visible && focused {
        hide_main_window(app);
    } else {
        show_main_window(app);
    }
}

#[track_caller]
pub(crate) fn show_main_window<R: Runtime>(app: &tauri::AppHandle<R>) {
    let caller = std::panic::Location::caller();
    log::debug!(
        "[main_window] show_main_window called from {}:{}",
        caller.file(),
        caller.line()
    );
    // macOS：hide_main_window 隐藏到托盘时切到了 Accessory，这里再切回 Regular。
    // 幂等检查（visible+focused+!minimized 短路）之前先 apply：dock 图标状态
    // 独立于窗口可见性，跳过 set_focus 不代表跳过 dock policy 同步。
    #[cfg(target_os = "macos")]
    {
        apply_dock_icon_policy(app);
    }
    if let Some(window) = app.get_webview_window("main") {
        let visible = window.is_visible().unwrap_or(false);
        let focused = window.is_focused().unwrap_or(false);
        let minimized = window.is_minimized().unwrap_or(false);
        log::debug!(
            "[main_window] show_main_window pre-state visible={visible} focused={focused} minimized={minimized}"
        );
        // 幂等短路：窗口已经在前台 + 已聚焦 + 未最小化 → 这三个 API 调下去都是
        // 状态不变的 no-op，但 set_focus 在 Windows 上即便对已聚焦窗口也会触发
        // foreground 抢占副作用（任务栏图标闪烁、SetForegroundWindow 重新激活）。
        // 未登录 gate 在 PTT cycle 期间会高频调本函数，跳过抢焦点是核心修复。
        if visible && focused && !minimized {
            log::debug!("[main_window] show_main_window already foreground, skip");
            return;
        }
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[tauri::command]
pub(crate) fn show_main_window_cmd(app: tauri::AppHandle) {
    show_main_window(&app);
}

#[tauri::command]
pub(crate) fn hide_to_tray(app: tauri::AppHandle) {
    hide_main_window(&app);
}
