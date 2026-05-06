// OpenSpeech 悬浮录音条子窗口
//
// 独立窗口：transparent + alwaysOnTop + no-decorations + focus:false + skipTaskbar。
// 位置固定屏幕底部中央；显隐由前端状态机驱动，Rust 只做物理资源管理。
//
// 加载路径 /overlay；前端按 window label 分流渲染 OverlayPage。

use tauri::{
    AppHandle, LogicalPosition, Manager, Monitor, Runtime, WebviewUrl, WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay";
const WIDTH: f64 = 200.0;
// 窗口固定为"最大可能高度"——pill 36 + toast 42 + gap 4 + debug strip 28 + gap 4
// 还留 16 px 缓冲。固定窗口尺寸可以避免 toast 出现 / debug 切换那一瞬调
// NSWindow setContentSize 引起的整窗同步重绘（pill 看起来"闪一下刷新"）。
// pill 在 webview 内 flex justify-end 贴底，视觉位置与 36 高度时一致。
const HEIGHT: f64 = 130.0;
// macOS 的 visibleFrame 在 Dock 上方多让出一段缓冲（约 10–20px），负值吃掉这段
// 让胶囊真正贴近 Dock 顶边；Windows / Linux 的 work_area 已经精确排除任务栏，
// 再压负值会盖在任务栏之上，所以保留几像素留白即可。
#[cfg(target_os = "macos")]
const BOTTOM_MARGIN: f64 = -8.0;
#[cfg(not(target_os = "macos"))]
const BOTTOM_MARGIN: f64 = 4.0;
// hide 时把窗口先挪到屏幕外——任何一帧 webview 没合成到位也看不到残影。
const OFFSCREEN_POSITION: f64 = -10000.0;

/// 启动时预创建（hidden），第一次触发快捷键直接 show。
pub fn ensure_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return Ok(());
    }

    // transparent(true) + tauri.conf.json 的 macOSPrivateApi 让窗口本体没有底色，
    // 胶囊形状由前端 CSS 决定，hide / unmount 过程中露不出窗口背景。
    let builder =
        WebviewWindowBuilder::new(app, OVERLAY_LABEL, WebviewUrl::App("index.html".into()))
            .inner_size(WIDTH, HEIGHT)
            .resizable(false)
            .decorations(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .focused(false)
            .shadow(false)
            .visible(false)
            .transparent(true)
            .title("OpenSpeech Overlay");

    #[cfg(target_os = "macos")]
    let builder = builder.visible_on_all_workspaces(true);

    let window = builder.build()?;

    position_to_bottom_center(&window)?;

    #[cfg(target_os = "macos")]
    enable_accepts_first_mouse(&window);

    log::warn!("[overlay] window created (hidden, transparent)");
    Ok(())
}

// 让悬浮条按钮在 OpenSpeech 不是前台 app 时一次点击就响应。
// 默认 NSView.acceptsFirstMouse: 返回 NO —— 用户在别的 app 里按快捷键触发未登录
// toast、点击「登录」时，第一次点击会被 AppKit 消化为"激活 app / key window"，
// 第二次点击才派发给 webview button。
//
// wry 的层级结构：NSWindow.contentView 是 wry 自己的 wrapper view，里面挂了
// WKWebView，WKWebView 内部还有真正接收 mouseDown 的 hit-test view。任何一层
// 没 patch，AppKit 都会回退到默认 NO。所以这里递归把整棵 view 树的类都加上
// acceptsFirstMouse: 永远 YES。class_addMethod 幂等：同一类被多次 add 同 selector
// 时会失败但不 crash，因此 root 节点和子节点共享同一类时也安全。
#[cfg(target_os = "macos")]
fn enable_accepts_first_mouse<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc::runtime::{
        class_addMethod, class_getInstanceMethod, method_setImplementation, Class, Imp, Object,
        Sel, BOOL, YES,
    };
    use objc::{msg_send, sel, sel_impl};
    use std::os::raw::c_char;

    extern "C" fn accepts_first_mouse(_: &Object, _: Sel, _: *mut Object) -> BOOL {
        YES
    }

    unsafe fn force_yes(class: *mut Class) {
        unsafe {
            let sel = sel!(acceptsFirstMouse:);
            let imp_fn: extern "C" fn(&Object, Sel, *mut Object) -> BOOL = accepts_first_mouse;
            let imp: Imp = std::mem::transmute(imp_fn);
            // 已有实现 → method_setImplementation 强制替换；未实现 → class_addMethod。
            // objc 0.2.7 没暴露 class_replaceMethod，组合这两个达到等价效果。
            let method = class_getInstanceMethod(class, sel);
            if !method.is_null() {
                let _ = method_setImplementation(method as *mut _, imp);
            } else {
                let types = b"c@:@\0".as_ptr() as *const c_char;
                let _: BOOL = class_addMethod(class, sel, imp, types);
            }
        }
    }

    unsafe fn patch_view_tree(view: *mut Object) {
        unsafe {
            if view.is_null() {
                return;
            }
            let view_class: *mut Class = msg_send![view, class];
            force_yes(view_class);
            // 递归子 view —— wry contentView → WKWebView → WKContentView 这条链都要打到。
            let subviews: *mut Object = msg_send![view, subviews];
            if subviews.is_null() {
                return;
            }
            let count: usize = msg_send![subviews, count];
            for i in 0..count {
                let child: *mut Object = msg_send![subviews, objectAtIndex: i];
                patch_view_tree(child);
            }
        }
    }

    let ptr = match window.ns_window() {
        Ok(p) => p,
        Err(e) => {
            log::warn!("[overlay] ns_window() failed: {e:?}");
            return;
        }
    };
    let ns_window = ptr as *mut Object;
    if ns_window.is_null() {
        return;
    }
    unsafe {
        // NSWindow 自己也实现了 acceptsFirstMouse: —— 给 window 类也补上一层兜底。
        let win_class: *mut Class = msg_send![ns_window, class];
        force_yes(win_class);
        let content_view: *mut Object = msg_send![ns_window, contentView];
        patch_view_tree(content_view);
        log::warn!("[overlay] acceptsFirstMouse patched on window + content view tree");
    }
}

fn position_to_bottom_center<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
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
    let y = origin_y + logical_h - HEIGHT - BOTTOM_MARGIN;
    log::warn!(
        "[overlay] target monitor name={:?} work_area_origin=({},{}) work_area_size=({}x{}) scale={} → logical_pos=({:.1},{:.1})",
        monitor.name(),
        work_area.position.x,
        work_area.position.y,
        work_area.size.width,
        work_area.size.height,
        scale,
        x,
        y,
    );
    window.set_position(LogicalPosition::new(x, y))?;
    Ok(())
}

// 鼠标命中的屏 → primary → 第一块。走 AppHandle 拿全局光标，避免 hidden window 上读不到。
fn active_monitor<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<Monitor>> {
    let monitors = app.available_monitors()?;
    if let Ok(cursor) = app.cursor_position() {
        let cx = cursor.x;
        let cy = cursor.y;
        log::warn!("[overlay] cursor physical=({cx},{cy})");
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
        log::warn!("[overlay] cursor outside all monitors, fall back to primary");
    } else {
        log::warn!("[overlay] cursor_position failed, fall back to primary");
    }
    if let Some(m) = app.primary_monitor()? {
        return Ok(Some(m));
    }
    Ok(monitors.into_iter().next())
}

pub fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    ensure_overlay(app)?;
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        // 窗口尺寸固定（HEIGHT），show 只重定位（cursor 跨屏 / 工作区切换后底部锚点
        // 可能变化），不再 set_size——避免 NSWindow setContentSize 引起的整窗重绘。
        position_to_bottom_center(&w)?;
        w.show()?;
        log::warn!("[overlay] show");
    }
    Ok(())
}

// hide 单 command：先移屏外再 hide，避免 hide 完成前的最后一帧露馅。
// 不再 set_size——窗口尺寸固定。
pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.set_position(LogicalPosition::new(OFFSCREEN_POSITION, OFFSCREEN_POSITION));
        w.hide()?;
        log::warn!("[overlay] hide");
    }
    Ok(())
}

#[tauri::command]
pub fn overlay_show<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    show(&app).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn overlay_hide<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    hide(&app).map_err(|e| e.to_string())
}

// 历史接口：曾经按 toast / debug strip 是否出现动态调窗口高度。改用固定窗口
// 尺寸 + 内部 motion 动画后，本命令是 noop——保留只为兼容前端 invoke，下一版
// 把前端调用点也清掉后可以彻底删除。
#[tauri::command]
pub fn overlay_set_height<R: Runtime>(_app: AppHandle<R>, _height: f64) -> Result<(), String> {
    Ok(())
}
