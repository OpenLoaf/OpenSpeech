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
use std::sync::Mutex;
#[cfg(target_os = "macos")]
use std::sync::atomic::AtomicI32;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition,
    PhysicalSize, Runtime, WebviewUrl, WebviewWindowBuilder, WindowEvent,
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

/// 托盘卡片（mode = recent-records）的视觉尺寸；webview 尺寸 = 卡片 + 透明边距。
const TRAY_CARD_WIDTH: f64 = 380.0;
const TRAY_CARD_HEIGHT: f64 = 520.0;
/// webview 四周给 CSS shadow 留的透明边距（logical px），与前端 `p-10` 对齐。
const SHADOW_MARGIN: f64 = 40.0;
/// 卡片与托盘图标之间的间隙（logical px）。
const TRAY_GAP: f64 = 6.0;

/// 托盘点击召唤的模式：最近识别记录的聊天式卡片，可直接改字。
pub const TRAY_MODE: &str = "recent-records";

/// 推给前端的透明边距事件：webview 四周各留多少 logical px 透明边距，前端按此设 padding。
/// 必须先于 mode 事件发出，避免新 mode 首帧用旧边距渲染。
pub const QUICK_PANEL_INSETS_EVENT: &str = "openspeech://quick-panel-insets";

/// webview 四周透明边距（logical px）。
#[derive(Debug, Clone, Copy, serde::Serialize)]
pub struct Insets {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}

impl Insets {
    const UNIFORM: Insets = Insets {
        top: SHADOW_MARGIN,
        right: SHADOW_MARGIN,
        bottom: SHADOW_MARGIN,
        left: SHADOW_MARGIN,
    };
}

/// 推给前端的 mode 事件——所有 mode 共用同一个 payload 结构。
pub const QUICK_PANEL_MODE_EVENT: &str = "openspeech://quick-panel-mode";

#[derive(Debug, Clone, Deserialize)]
pub struct ShowPayload {
    /// 当前面板要展示的功能模式，例如 `"edit-last-record"`。
    /// 字面值由前后端约定；后端不解释，原样转发给前端。
    pub mode: String,
}

/// 托盘图标在屏幕上的物理像素矩形（左上原点），用于把卡片贴在图标旁边。
#[derive(Debug, Clone, Copy)]
pub struct TrayAnchor {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl TrayAnchor {
    pub fn from_rect(rect: &tauri::Rect) -> Self {
        // tray-icon 给的就是 Physical 变体，scale 传 1.0 只是走一次类型转换。
        let pos = rect.position.to_physical::<f64>(1.0);
        let size = rect.size.to_physical::<f64>(1.0);
        Self {
            x: pos.x,
            y: pos.y,
            w: size.width,
            h: size.height,
        }
    }
}

/// 面板出现的位置：快捷键召唤居中；托盘召唤贴在图标旁。
#[derive(Debug, Clone, Copy)]
pub enum Placement {
    Center,
    Tray(TrayAnchor),
}

// 最近一次托盘事件带来的图标位置。托盘菜单项「最近识别」没有 rect，用它兜底定位；
// Linux 不发托盘事件，始终为 None → 居中。
static LAST_TRAY_ANCHOR: Mutex<Option<TrayAnchor>> = Mutex::new(None);

// 最近一次「失焦自动 hide」的时间戳（ms）。点击托盘图标时面板先失焦被 hide，
// 紧接着 Click 事件到达——此时用户的意图是「关」，不能再把面板重新弹出来。
static LAST_BLUR_HIDE_MS: AtomicU64 = AtomicU64::new(0);
const BLUR_TOGGLE_GUARD_MS: u64 = 400;

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn remember_tray_anchor(anchor: TrayAnchor) {
    if let Ok(mut g) = LAST_TRAY_ANCHOR.lock() {
        *g = Some(anchor);
    }
}

fn last_tray_placement() -> Placement {
    LAST_TRAY_ANCHOR
        .lock()
        .ok()
        .and_then(|g| *g)
        .map(Placement::Tray)
        .unwrap_or(Placement::Center)
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

    position_centered(&window, (WIDTH, HEIGHT))?;

    #[cfg(target_os = "macos")]
    promote_to_panel(&window);

    let app_handle = app.clone();
    window.on_window_event(move |event| {
        // 失焦立即 hide：用户切到别的窗口 / 点空白处时，面板自己消失。
        // ESC 由前端监听后调 quick_panel_hide 命令，不在此处理。
        if let WindowEvent::Focused(false) = event {
            log::warn!("[quick-panel] on_window_event: Focused(false) → hide");
            let visible = app_handle
                .get_webview_window(QUICK_PANEL_LABEL)
                .and_then(|w| w.is_visible().ok())
                .unwrap_or(false);
            if visible {
                LAST_BLUR_HIDE_MS.store(now_ms(), Ordering::SeqCst);
            }
            if let Err(e) = hide(&app_handle) {
                log::warn!("[quick-panel] auto-hide on blur failed: {e:?}");
            }
        }
    });

    log::warn!("[quick-panel] window created (hidden)");
    Ok(())
}

fn position_centered<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    (width, height): (f64, f64),
) -> tauri::Result<()> {
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
    let x = origin_x + (logical_w - width) / 2.0;
    // 上 1/3 处更接近 Spotlight 的视觉中心，比纯几何居中舒服。
    let y = origin_y + (logical_h - height) / 3.0;
    window.set_size(LogicalSize::new(width, height))?;
    window.set_position(LogicalPosition::new(x, y))?;
    Ok(())
}

/// 把卡片贴在托盘图标旁：图标在屏幕上半（macOS 菜单栏 / 顶部面板）→ 卡片在图标下方；
/// 否则（Windows 底部任务栏）→ 卡片在图标上方。水平以图标中心对齐，并夹在 work area 内。
///
/// 靠近图标那一侧**不留**透明边距：macOS 会把与菜单栏重叠的窗口整体往下推，四周统一
/// 40 px 边距时顶部边距压到菜单栏上，卡片就被推低整整 40 px；Windows 上底部边距盖住
/// 任务栏也会吃掉任务栏点击。返回实际使用的边距，由调用方推给前端。
fn position_near_tray<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    anchor: TrayAnchor,
    (card_w_l, card_h_l): (f64, f64),
) -> tauri::Result<Insets> {
    let app = window.app_handle();
    let cx = anchor.x + anchor.w / 2.0;
    let cy = anchor.y + anchor.h / 2.0;
    let Some(monitor) = monitor_at(app, cx, cy)? else {
        position_centered(
            window,
            (
                card_w_l + SHADOW_MARGIN * 2.0,
                card_h_l + SHADOW_MARGIN * 2.0,
            ),
        )?;
        return Ok(Insets::UNIFORM);
    };
    let scale = monitor.scale_factor();
    let gap = TRAY_GAP * scale;
    let (card_w, card_h) = (card_w_l * scale, card_h_l * scale);

    let wa = monitor.work_area();
    let wa_x0 = wa.position.x as f64;
    let wa_y0 = wa.position.y as f64;
    let wa_x1 = wa_x0 + wa.size.width as f64;
    let wa_y1 = wa_y0 + wa.size.height as f64;
    let screen_mid_y = monitor.position().y as f64 + monitor.size().height as f64 / 2.0;
    let below = cy < screen_mid_y;

    let card_x = clamp_range(cx - card_w / 2.0, wa_x0 + gap, wa_x1 - card_w - gap);
    let card_y = if below {
        anchor.y + anchor.h + gap
    } else {
        anchor.y - gap - card_h
    };
    let card_y = clamp_range(card_y, wa_y0, wa_y1 - card_h);

    let insets = if below {
        Insets {
            top: 0.0,
            ..Insets::UNIFORM
        }
    } else {
        Insets {
            bottom: 0.0,
            ..Insets::UNIFORM
        }
    };
    let win_w = card_w + (insets.left + insets.right) * scale;
    let win_h = card_h + (insets.top + insets.bottom) * scale;
    window.set_size(PhysicalSize::new(
        win_w.round() as u32,
        win_h.round() as u32,
    ))?;
    window.set_position(PhysicalPosition::new(
        (card_x - insets.left * scale).round() as i32,
        (card_y - insets.top * scale).round() as i32,
    ))?;
    Ok(insets)
}

/// 与 f64::clamp 不同：区间倒挂（屏幕比卡片还小）时取下界而不是 panic。
fn clamp_range(v: f64, lo: f64, hi: f64) -> f64 {
    if hi < lo { lo } else { v.max(lo).min(hi) }
}

fn monitor_at<R: Runtime>(app: &AppHandle<R>, x: f64, y: f64) -> tauri::Result<Option<Monitor>> {
    let monitors = app.available_monitors()?;
    for m in &monitors {
        let pos = m.position();
        let sz = m.size();
        let x0 = pos.x as f64;
        let y0 = pos.y as f64;
        if x >= x0 && x < x0 + sz.width as f64 && y >= y0 && y < y0 + sz.height as f64 {
            return Ok(Some(m.clone()));
        }
    }
    active_monitor(app)
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
    show_at(app, mode, Placement::Center)
}

pub fn show_at<R: Runtime>(
    app: &AppHandle<R>,
    mode: &str,
    placement: Placement,
) -> tauri::Result<()> {
    log::warn!("[quick-panel] show ENTER mode={mode} placement={placement:?}");

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
        let insets = match (mode == TRAY_MODE, placement) {
            (true, Placement::Tray(anchor)) => {
                position_near_tray(&w, anchor, (TRAY_CARD_WIDTH, TRAY_CARD_HEIGHT))?
            }
            (true, Placement::Center) => {
                position_centered(
                    &w,
                    (
                        TRAY_CARD_WIDTH + SHADOW_MARGIN * 2.0,
                        TRAY_CARD_HEIGHT + SHADOW_MARGIN * 2.0,
                    ),
                )?;
                Insets::UNIFORM
            }
            (false, _) => {
                position_centered(&w, (WIDTH, HEIGHT))?;
                Insets::UNIFORM
            }
        };
        let _ = app.emit_to(QUICK_PANEL_LABEL, QUICK_PANEL_INSETS_EVENT, insets);
        let _ = app.emit_to(QUICK_PANEL_LABEL, QUICK_PANEL_MODE_EVENT, mode);
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

/// 托盘图标左键：可见 → hide；不可见 → 贴着图标弹出最近识别卡片。
/// `anchor` 为 None 时（托盘菜单项触发）用最近一次记下的图标位置。
pub fn toggle_from_tray<R: Runtime>(
    app: &AppHandle<R>,
    anchor: Option<TrayAnchor>,
) -> tauri::Result<()> {
    if let Some(a) = anchor {
        remember_tray_anchor(a);
    }
    let visible = app
        .get_webview_window(QUICK_PANEL_LABEL)
        .and_then(|w| w.is_visible().ok())
        .unwrap_or(false);
    if visible {
        return hide(app);
    }
    // 点击托盘图标这一下本身会让面板失焦被 hide，随后 Click 才到——那次点击的语义是「关」。
    // 菜单项触发（anchor=None）不受此限：菜单弹出前面板早已失焦关掉，用户明确要打开。
    let since_blur = now_ms().saturating_sub(LAST_BLUR_HIDE_MS.load(Ordering::SeqCst));
    if anchor.is_some() && since_blur < BLUR_TOGGLE_GUARD_MS {
        log::warn!("[quick-panel] tray toggle: just hidden by blur ({since_blur}ms), keep hidden");
        return Ok(());
    }
    show_at(app, TRAY_MODE, last_tray_placement())
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
        let app: *mut Object = msg_send![cls, runningApplicationWithProcessIdentifier: pid];
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
    use objc::runtime::{BOOL, Class, Imp, NO, Object, Sel, YES};
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
        fn class_addMethod(cls: *mut Class, name: Sel, imp: Imp, types: *const c_char) -> BOOL;
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
pub fn quick_panel_show<R: Runtime>(app: AppHandle<R>, payload: ShowPayload) -> Result<(), String> {
    show(&app, &payload.mode).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn quick_panel_hide<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    hide(&app).map_err(|e| e.to_string())
}
