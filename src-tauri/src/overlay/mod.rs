// OpenSpeech 悬浮录音条子窗口
//
// 独立窗口：transparent + alwaysOnTop + no-decorations + focus:false + skipTaskbar。
// 位置固定屏幕底部中央；显隐由前端状态机驱动，Rust 只做物理资源管理。
//
// 加载路径 /overlay；前端按 window label 分流渲染 OverlayPage。

use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, Monitor, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay";
const WIDTH: f64 = 200.0;
const HEIGHT: f64 = 36.0;
const BOTTOM_MARGIN: f64 = 32.0;
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

    log::warn!("[overlay] window created (hidden, transparent)");
    Ok(())
}

fn position_to_bottom_center<R: Runtime>(window: &tauri::WebviewWindow<R>) -> tauri::Result<()> {
    position_to_bottom_center_with_height(window, HEIGHT)
}

// 让 height 参数控制纵向扩展（错误条 ~96），上沿向上长，胶囊本体位置不动。
fn position_to_bottom_center_with_height<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    height: f64,
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
    let x = origin_x + (logical_w - WIDTH) / 2.0;
    let y = origin_y + logical_h - height - BOTTOM_MARGIN;
    log::warn!(
        "[overlay] target monitor name={:?} origin=({},{}) size=({}x{}) scale={} → logical_pos=({:.1},{:.1})",
        monitor.name(),
        origin.x,
        origin.y,
        size.width,
        size.height,
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
        // hide 路径已做尺寸复位，这里是兜底——首次创建后 ensure_overlay 直接出来时
        // 也能保证 200×36 一致状态。
        w.set_size(LogicalSize::new(WIDTH, HEIGHT))?;
        position_to_bottom_center(&w)?;
        w.show()?;
        log::warn!("[overlay] show");
    }
    Ok(())
}

// hide 单 command：同一函数内串行完成"先移屏外 → 复位尺寸 → hide"，
// 避免多条 IPC 顺序错乱导致下次 show 卡尺寸或残留矩形。
pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.set_position(LogicalPosition::new(OFFSCREEN_POSITION, OFFSCREEN_POSITION));
        let _ = w.set_size(LogicalSize::new(WIDTH, HEIGHT));
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

// 错误条出现/消失时由前端调一次：传入新的窗口高度（默认 36；展开时 ~96）。
// 重新设置 inner_size 后立即重新定位，使底部胶囊保持原位，错误条向上扩展。
#[tauri::command]
pub fn overlay_set_height<R: Runtime>(app: AppHandle<R>, height: f64) -> Result<(), String> {
    let Some(w) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    let h = height.clamp(HEIGHT, 240.0);
    w.set_size(LogicalSize::new(WIDTH, h))
        .map_err(|e| e.to_string())?;
    position_to_bottom_center_with_height(&w, h).map_err(|e| e.to_string())?;
    Ok(())
}
