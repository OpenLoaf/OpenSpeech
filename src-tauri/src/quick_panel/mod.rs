// OpenSpeech Quick Panel
//
// 通用快速操作面板：脱离主窗口的独立小窗，由全局快捷键拉起。
// 第一个落地的功能是「编辑上一条听写记录」（mode = edit-last-record）；
// 后续翻译、问答等"无需主窗"的快速操作都挂在这里，按 mode 切换内部视图。
//
// 与 overlay 的差异：
// - overlay 是 nonactivating NSPanel（不抢 key window，仅鼠标事件）
// - quick panel 必须能输入文字，所以是 **可成为 key window 的 NSPanel**（不带
//   nonactivating mask）。NSPanel 类型本身就让 AppKit 在 hide 时不去 raise 同 app 的
//   主窗口——这是 overlay 同款修复的根因，靠 NSApp.deactivate 救不回来：AppKit 在
//   `becomeKeyWindow` 那一帧就已经把主窗口顶上来了，等到我们能 deactivate 时已经晚了。
//
// 加载路径 = "index.html"；前端按 window label 分流渲染 QuickPanelPage。

use serde::Deserialize;
use std::sync::atomic::{AtomicI32, Ordering};
use tauri::{
    AppHandle, Emitter, LogicalPosition, Manager, Monitor, Runtime, WebviewUrl,
    WebviewWindowBuilder, WindowEvent,
};

/// macOS：记录召唤 quick panel 之前的 frontmost app PID。
/// hide 时用这个 PID 直接 activate 那个 app，把前台还给用户原来的工作 app。
/// 0 = 没记录（首次启动或上次记录的是 OpenSpeech 自己）。
#[cfg(target_os = "macos")]
static PREV_FRONTMOST_PID: AtomicI32 = AtomicI32::new(0);

pub const QUICK_PANEL_LABEL: &str = "quick-panel";
// 比 panel 视觉尺寸（560×360）大 80×80：四周各留 40 px 透明边距给 CSS shadow-2xl
// 渲染。系统 NSWindow shadow 已关闭（见 builder 注释），完全靠 CSS 画。
const WIDTH: f64 = 640.0;
const HEIGHT: f64 = 440.0;

/// 推给前端的 mode 事件——所有 mode 共用同一个 payload 结构。
pub const QUICK_PANEL_MODE_EVENT: &str = "openspeech://quick-panel-mode";

#[derive(Debug, Clone, Deserialize)]
pub struct ShowPayload {
    /// 当前面板要展示的功能模式，例如 `"edit-last-record"`。
    /// 字面值由前后端约定；后端不解释，原样转发给前端。
    pub mode: String,
}

/// 启动时预创建（hidden）。第一次触发快捷键直接 show，避免几百 ms 冷启动延迟。
pub fn ensure<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(QUICK_PANEL_LABEL).is_some() {
        log::warn!("[quick-panel] ensure: window already exists, skip");
        return Ok(());
    }
    log::warn!("[quick-panel] ensure: creating window…");

    let builder =
        WebviewWindowBuilder::new(app, QUICK_PANEL_LABEL, WebviewUrl::App("index.html".into()))
            .inner_size(WIDTH, HEIGHT)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            // 关掉系统 shadow：transparent + 圆角内容 + NSWindow 矩形 shadow 不匹配，
            // 底部圆角外会露出 shadow 的矩形角（视觉上像两个直角）。CSS 的 shadow-2xl
            // 跟着 rounded-2xl 边界画，圆角处的阴影自然过渡。
            .shadow(false)
            .visible(false)
            .transparent(true)
            .title("OpenSpeech Quick Panel");

    #[cfg(target_os = "macos")]
    let builder = builder.visible_on_all_workspaces(true);

    let window = builder.build()?;
    log::warn!("[quick-panel] ensure: builder.build() returned");

    position_centered(&window)?;

    #[cfg(target_os = "macos")]
    promote_to_panel(&window);

    let app_handle = app.clone();
    window.on_window_event(move |event| {
        // 失焦立即 hide：用户切到别的窗口 / 点空白处时，面板自己消失。
        // ESC 由前端监听后调 quick_panel_hide 命令，不在此处理。
        if let WindowEvent::Focused(false) = event {
            log::warn!("[quick-panel] on_window_event: Focused(false) → hide");
            if let Err(e) = hide(&app_handle) {
                log::warn!("[quick-panel] auto-hide on blur failed: {e:?}");
            }
        }
    });

    log::warn!("[quick-panel] window created (hidden)");
    Ok(())
}

fn position_centered<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    let app = window.app_handle();
    let Some(monitor) = active_monitor(app)? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let work_area = monitor.work_area();
    let logical_w = work_area.size.width as f64 / scale;
    let logical_h = work_area.size.height as f64 / scale;
    let origin_x = work_area.position.x as f64 / scale;
    let origin_y = work_area.position.y as f64 / scale;
    let x = origin_x + (logical_w - WIDTH) / 2.0;
    // 上 1/3 处更接近 Spotlight 的视觉中心，比纯几何居中舒服。
    let y = origin_y + (logical_h - HEIGHT) / 3.0;
    window.set_position(LogicalPosition::new(x, y))?;
    Ok(())
}

fn active_monitor<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<Monitor>> {
    let monitors = app.available_monitors()?;
    if let Ok(cursor) = app.cursor_position() {
        let cx = cursor.x;
        let cy = cursor.y;
        for m in &monitors {
            let pos = m.position();
            let sz = m.size();
            let x0 = pos.x as f64;
            let y0 = pos.y as f64;
            let x1 = x0 + sz.width as f64;
            let y1 = y0 + sz.height as f64;
            if cx >= x0 && cx < x1 && cy >= y0 && cy < y1 {
                return Ok(Some(m.clone()));
            }
        }
    }
    if let Some(m) = app.primary_monitor()? {
        return Ok(Some(m));
    }
    Ok(monitors.into_iter().next())
}

pub fn show<R: Runtime>(app: &AppHandle<R>, mode: &str) -> tauri::Result<()> {
    log::warn!("[quick-panel] show ENTER mode={mode}");

    // 在做任何 panel 操作之前先把当前 frontmost app 记下来——hide 时还给它。
    // 必须在 ensure / show 之前抓，因为虽然 panel 是 nonactivating 不应该改 frontmost，
    // 但稳妥起见在最早的时刻读。
    #[cfg(target_os = "macos")]
    record_prev_frontmost_app();

    ensure(app)?;

    let main_was_visible = app
        .get_webview_window("main")
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    let main_was_focused = app
        .get_webview_window("main")
        .and_then(|w| w.is_focused().ok())
        .unwrap_or(false);
    log::warn!(
        "[quick-panel] show: main pre-state visible={main_was_visible} focused={main_was_focused}"
    );

    if let Some(w) = app.get_webview_window(QUICK_PANEL_LABEL) {
        let _ = app.emit_to(QUICK_PANEL_LABEL, QUICK_PANEL_MODE_EVENT, mode);
        position_centered(&w)?;
        log::warn!("[quick-panel] show: about to call w.show() + set_focus()");
        w.show()?;
        // nonactivating panel：set_focus 触发的 makeKeyAndOrderFront 不再激活 OpenSpeech，
        // 主窗口（即便 visible）也不会被抬到 frontmost。键盘事件由 canBecomeKeyWindow=YES
        // 保证仍能进入 textarea。
        let _ = w.set_focus();
        log::warn!("[quick-panel] show: w.show()+set_focus() returned");

        let post_visible = app
            .get_webview_window("main")
            .and_then(|m| m.is_visible().ok())
            .unwrap_or(false);
        let post_focused = app
            .get_webview_window("main")
            .and_then(|m| m.is_focused().ok())
            .unwrap_or(false);
        log::warn!(
            "[quick-panel] show: main post-show visible={post_visible} focused={post_focused}"
        );
    }

    Ok(())
}

/// 快捷键再按一次：可见 → hide，不可见 → show。`mode` 仅在 show 路径生效。
pub fn toggle<R: Runtime>(app: &AppHandle<R>, mode: &str) -> tauri::Result<()> {
    let visible = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        log::warn!("[quick-panel] toggle: visible → hide");
        hide(app)
    } else {
        log::warn!("[quick-panel] toggle: hidden → show mode={mode}");
        show(app, mode)
    }
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    log::warn!("[quick-panel] hide ENTER");
    if let Some(w) = app.get_webview_window(QUICK_PANEL_LABEL) {
        if w.is_visible().unwrap_or(false) {
            // macOS：panel 是 keyable 的，orderOut 那一帧 AppKit 会去找下一个 key window
            // 候选——同 app 的主窗口（normal NSWindow, canBecomeKey=YES）就被 makeKey，
            // 顺带激活 OpenSpeech、抬到 frontmost。先让 panel 主动 resignKey + 让 NSApp
            // deactivate，把 frontmost 让回给上一个 app，AppKit 就不会再为我们找替补。
            #[cfg(target_os = "macos")]
            yield_to_previous_app(&w);

            w.hide()?;
            log::warn!("[quick-panel] hide: panel hidden");
        }
    }
    Ok(())
}

/// macOS：把 frontmost app 还给召唤 quick panel 之前的那个 app。
///
/// 这是 Spotlight / Raycast 风格：用户的工作 app（比如 Chrome）抢回前台后，OpenSpeech
/// 自动让出 frontmost，AppKit 不会再去 OpenSpeech 内部找 next key window —— 主窗的 z-order
/// / visible 状态完全不动。
///
/// 之前几次尝试的对照：
/// - `[NSApp deactivate]` 异步生效，panel orderOut 那一帧 AppKit 已经 raise 主窗了 ❌
/// - `[NSApp hide:nil]` 同步但太狠，主窗 visible 时也跟着藏 ❌
/// - 这条路径同步 + 不动主窗 ✅
#[cfg(target_os = "macos")]
fn yield_to_previous_app<R: Runtime>(_window: &tauri::WebviewWindow<R>) {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    let pid = PREV_FRONTMOST_PID.swap(0, Ordering::SeqCst);
    if pid == 0 {
        log::warn!("[quick-panel] yield: no recorded prev app, fall back to NSApp.deactivate");
        unsafe {
            let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            if !ns_app.is_null() {
                let _: () = msg_send![ns_app, deactivate];
            }
        }
        return;
    }
    unsafe {
        let cls: *mut objc::runtime::Class =
            class!(NSRunningApplication) as *const _ as *mut objc::runtime::Class;
        let app: *mut Object =
            msg_send![cls, runningApplicationWithProcessIdentifier: pid];
        if app.is_null() {
            log::warn!("[quick-panel] yield: prev app pid={pid} no longer running");
            // fallback：deactivate 自己，AppKit 自己挑 next frontmost
            let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
            if !ns_app.is_null() {
                let _: () = msg_send![ns_app, deactivate];
            }
            return;
        }
        // activateWithOptions:0 = 默认行为（不强制 unhide all windows）。
        let activated: objc::runtime::BOOL = msg_send![app, activateWithOptions: 0u64];
        log::warn!(
            "[quick-panel] yield: activated prev app pid={pid} ok={}",
            activated != objc::runtime::NO
        );
    }
}

/// macOS：把当前 frontmost app（如果不是 OpenSpeech 自己）记到全局，hide 时还给它。
#[cfg(target_os = "macos")]
fn record_prev_frontmost_app() {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let ws: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
        if ws.is_null() {
            return;
        }
        let frontmost: *mut Object = msg_send![ws, frontmostApplication];
        if frontmost.is_null() {
            return;
        }
        let pid: i32 = msg_send![frontmost, processIdentifier];
        let our_pid = std::process::id() as i32;
        if pid == our_pid {
            // OpenSpeech 自己已经是 frontmost（用户在主窗里按了 Cmd+Shift+E）——不记录，
            // hide 时就走 deactivate fallback，主窗保持原状。
            log::warn!("[quick-panel] record: frontmost is OpenSpeech itself (pid={pid}), skip");
            return;
        }
        PREV_FRONTMOST_PID.store(pid, Ordering::SeqCst);
        log::warn!("[quick-panel] record: prev frontmost pid={pid}");
    }
}

/// 把 quick panel 的 NSWindow 切成 **可接收键盘的 nonactivating NSPanel**。
///
/// 真正根因：Tauri 的 `set_focus`（`makeKeyAndOrderFront`）在 macOS 下会激活整个
/// OpenSpeech app（NSApp.activateIgnoringOtherApps）。OpenSpeech 一旦成为 frontmost，
/// 它的所有 visible window —— 包括"虽然 visible 但被其他 app 挡住"的主窗口 —— 都被
/// 抬到 z-order 最前。用户感知就是"按 Cmd+Shift+E 主窗口冒出来了"。
///
/// 解法：让 quick panel 的 NSWindow 变成 `NSWindowStyleMaskNonactivatingPanel`——
/// 这是 overlay 同款 mask，它让 panel 在 makeKey 时**不激活 app**。但默认这个 mask
/// 会让 panel 的 `canBecomeKeyWindow` 返回 NO（textarea 收不到键盘）。
///
/// 破解：动态创建 NSPanel 子类，override `canBecomeKeyWindow` 强制返回 YES。
/// 这是 tauri-nspanel 等社区 plugin 的标准做法。注意：动态子类必须挂在 system NSPanel
/// 之下（**不能**挂在 wry 的 NSWindow class 下），否则会撞 wry 内部 KVO 链。
#[cfg(target_os = "macos")]
fn promote_to_panel<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc::runtime::{Class, Imp, Object, Sel, BOOL, NO, YES};
    use objc::{class, msg_send, sel, sel_impl};
    use std::os::raw::c_char;
    use std::sync::OnceLock;

    unsafe extern "C" {
        fn object_setClass(obj: *mut Object, cls: *mut Class) -> *mut Class;
        fn objc_allocateClassPair(
            superclass: *mut Class,
            name: *const c_char,
            extra: usize,
        ) -> *mut Class;
        fn objc_registerClassPair(cls: *mut Class);
        fn class_addMethod(
            cls: *mut Class,
            name: Sel,
            imp: Imp,
            types: *const c_char,
        ) -> BOOL;
    }

    extern "C" fn can_become_key_window(_: &Object, _: Sel) -> BOOL {
        YES
    }
    extern "C" fn can_become_main_window(_: &Object, _: Sel) -> BOOL {
        // main window 仍由真正的主窗口承担——这个 panel 不参与 main window 选举，
        // 否则 AppKit 把它当 main window 候选会更绕。
        NO
    }

    static PANEL_CLASS_USIZE: OnceLock<usize> = OnceLock::new();
    let panel_class_ptr = *PANEL_CLASS_USIZE.get_or_init(|| unsafe {
        let nspanel: *mut Class = class!(NSPanel) as *const _ as *mut Class;
        let name = b"OpenSpeechKeyableNonactivatingPanel\0".as_ptr() as *const c_char;
        let cls = objc_allocateClassPair(nspanel, name, 0);
        if cls.is_null() {
            log::error!("[quick-panel] objc_allocateClassPair returned NULL");
            return 0usize;
        }
        let types = b"c@:\0".as_ptr() as *const c_char;
        let imp_key: extern "C" fn(&Object, Sel) -> BOOL = can_become_key_window;
        let imp_key: Imp = std::mem::transmute(imp_key);
        let imp_main: extern "C" fn(&Object, Sel) -> BOOL = can_become_main_window;
        let imp_main: Imp = std::mem::transmute(imp_main);
        class_addMethod(cls, sel!(canBecomeKeyWindow), imp_key, types);
        class_addMethod(cls, sel!(canBecomeMainWindow), imp_main, types);
        objc_registerClassPair(cls);
        log::warn!("[quick-panel] OpenSpeechKeyableNonactivatingPanel class registered");
        cls as usize
    }) as *mut Class;
    if panel_class_ptr.is_null() {
        log::warn!("[quick-panel] panel class init failed; aborting promote");
        return;
    }

    let ns_window_ptr = match window.ns_window() {
        Ok(p) => p as *mut Object,
        Err(e) => {
            log::warn!("[quick-panel] ns_window() failed (panel promote): {e:?}");
            return;
        }
    };
    if ns_window_ptr.is_null() {
        return;
    }
    const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: u64 = 1 << 7;
    unsafe {
        let prev_class: *mut Class = object_setClass(ns_window_ptr, panel_class_ptr);
        let prev_name: *const c_char = objc::runtime::class_getName(prev_class);
        let next_class: *mut Class = msg_send![ns_window_ptr, class];
        let next_name: *const c_char = objc::runtime::class_getName(next_class);
        let prev_str = std::ffi::CStr::from_ptr(prev_name)
            .to_string_lossy()
            .into_owned();
        let next_str = std::ffi::CStr::from_ptr(next_name)
            .to_string_lossy()
            .into_owned();

        let cur_mask: u64 = msg_send![ns_window_ptr, styleMask];
        let new_mask = cur_mask | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL;
        let _: () = msg_send![ns_window_ptr, setStyleMask: new_mask];

        log::warn!(
            "[quick-panel] promoted: class {prev_str} → {next_str}, styleMask {cur_mask:#x} → {new_mask:#x} (nonactivating + keyable)"
        );
    }
}

#[tauri::command]
pub fn quick_panel_show<R: Runtime>(
    app: AppHandle<R>,
    payload: ShowPayload,
) -> Result<(), String> {
    show(&app, &payload.mode).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quick_panel_hide<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    hide(&app).map_err(|e| e.to_string())
}
