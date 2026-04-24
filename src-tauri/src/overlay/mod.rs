// OpenSpeech 悬浮录音条子窗口
//
// 独立于主窗口：transparent + alwaysOnTop + no-decorations + focus:false + skipTaskbar。
// 用户不会拖它；位置固定屏幕底部中央，由状态机控制显隐。
//
// 加载路径 /overlay；前端 router 识别到该路径后渲染 OverlayPage 而非 Layout。

use tauri::{
    AppHandle, LogicalPosition, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay";
const WIDTH: f64 = 200.0;
const HEIGHT: f64 = 36.0;
const BOTTOM_MARGIN: f64 = 32.0;

/// 启动时预创建（hidden），第一次触发快捷键时直接 show 即可，不再有首次渲染延迟。
pub fn ensure_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return Ok(());
    }

    // overlay 加载同一份 index.html；前端根据 window label 分流渲染 OverlayPage。
    // Transparent 窗口在 Tauri 2 需要额外 Cargo feature + conf 配置；这里改用
    // solid TE 黑底，窗口 280x56 就是内容尺寸，视觉上等同于浮条。
    let builder = WebviewWindowBuilder::new(
        app,
        OVERLAY_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .inner_size(WIDTH, HEIGHT)
    .resizable(false)
    .decorations(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .focused(false)
    .shadow(false)
    .visible(false)
    .title("OpenSpeech Overlay");

    #[cfg(target_os = "macos")]
    let builder = builder.visible_on_all_workspaces(true);

    let window = builder.build()?;

    position_to_bottom_center(&window)?;

    eprintln!("[overlay] window created (hidden)");
    Ok(())
}

fn position_to_bottom_center<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    let Some(monitor) = window.primary_monitor()? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let size = monitor.size(); // physical
    let origin = monitor.position(); // physical
    // 全部转 logical 再计算中点，避免高 DPI 误差。
    let logical_w = size.width as f64 / scale;
    let logical_h = size.height as f64 / scale;
    let origin_x = origin.x as f64 / scale;
    let origin_y = origin.y as f64 / scale;
    let x = origin_x + (logical_w - WIDTH) / 2.0;
    let y = origin_y + logical_h - HEIGHT - BOTTOM_MARGIN;
    window.set_position(LogicalPosition::new(x, y))?;
    eprintln!("[overlay] positioned at logical ({x:.1}, {y:.1})");
    Ok(())
}

pub fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 主窗口 focused 时跳过：Home 页的 Live 面板已经提供了 overlay 的全部信息
    // （状态标签 + 波形 + 实时文字占位），再在屏幕底部叠一个浮窗属于视觉重复。
    // 真正需要 overlay 的场景是用户在别的 app 里说话（主窗口失焦）。
    if let Some(main) = app.get_webview_window("main") {
        if main.is_focused().unwrap_or(false) {
            eprintln!("[overlay] skip show: main window focused");
            return Ok(());
        }
    }
    ensure_overlay(app)?;
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        position_to_bottom_center(&w)?;
        w.show()?;
        eprintln!("[overlay] show");
    }
    Ok(())
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        w.hide()?;
        eprintln!("[overlay] hide");
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

