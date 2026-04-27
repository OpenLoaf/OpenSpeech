// OpenSpeech 悬浮录音条子窗口
//
// 独立于主窗口：transparent + alwaysOnTop + no-decorations + focus:false + skipTaskbar。
// 用户不会拖它；位置固定屏幕底部中央，由状态机控制显隐。
//
// 加载路径 /overlay；前端 router 识别到该路径后渲染 OverlayPage 而非 Layout。

use std::sync::atomic::{AtomicBool, Ordering};

use tauri::{
    webview::Color, AppHandle, LogicalPosition, LogicalSize, Manager, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const OVERLAY_LABEL: &str = "overlay";
const WIDTH: f64 = 200.0;
const HEIGHT: f64 = 36.0;
const BOTTOM_MARGIN: f64 = 32.0;

// "期望可见"状态——`show()` / `hide()` 是这个状态的入口。
// 物理显隐再叠一层"主窗口聚焦时不显示"的策略：
//   desired=true  + main focused   → 物理隐藏（Home 的 Live 面板已展示状态）
//   desired=true  + main unfocused → 物理显示（用户在别的 app 里说话需要悬浮条）
//   desired=false                  → 物理隐藏（无录音流程）
// 主窗口 focus 变化由 `on_main_focus_changed` 钩入 lib.rs 的 WindowEvent。
static DESIRED_VISIBLE: AtomicBool = AtomicBool::new(false);

/// 启动时预创建（hidden），第一次触发快捷键时直接 show 即可，不再有首次渲染延迟。
pub fn ensure_overlay<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return Ok(());
    }

    // overlay 加载同一份 index.html；前端根据 window label 分流渲染 OverlayPage。
    // Transparent 窗口在 Tauri 2 需要额外 Cargo feature + conf 配置；这里改用
    // solid TE 黑底，窗口 280x56 就是内容尺寸，视觉上等同于浮条。
    // background_color 把 NSWindow / wry webview 默认色都设成 te-bg 黑——否则
    // window.show / 窗口尺寸变化的瞬间，webview 第一帧合成前会露出系统 NSWindow
    // 默认背景（macOS light mode 下是白），表现为出现/消失时一闪白色。
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
    .background_color(Color(0, 0, 0, 255))
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
    position_to_bottom_center_with_height(window, HEIGHT)
}

// 把 overlay 窗口移动到屏幕底部中央，保持底部边距 BOTTOM_MARGIN 不变；
// height 参数允许窗口纵向变高（错误条出现时），上沿向上扩展，胶囊本体位置不动。
fn position_to_bottom_center_with_height<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
    height: f64,
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
    let y = origin_y + logical_h - height - BOTTOM_MARGIN;
    window.set_position(LogicalPosition::new(x, y))?;
    eprintln!("[overlay] positioned at logical ({x:.1}, {y:.1}) h={height:.1}");
    Ok(())
}

pub fn show<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    // 期望可见：录音流程开始（快捷键按下）。先置位 desired，物理显隐再看
    // 主窗口焦点。主窗口聚焦时不实际 show（Home 的 Live 面板已展示同等信息），
    // 待 `on_main_focus_changed` 接到失焦事件再补偿。
    DESIRED_VISIBLE.store(true, Ordering::Relaxed);
    if let Some(main) = app.get_webview_window("main") {
        if main.is_focused().unwrap_or(false) {
            eprintln!("[overlay] desired=true, defer show (main focused)");
            return Ok(());
        }
    }
    show_now(app)
}

pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    DESIRED_VISIBLE.store(false, Ordering::Relaxed);
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        w.hide()?;
        eprintln!("[overlay] hide");
    }
    Ok(())
}

fn show_now<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    ensure_overlay(app)?;
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        position_to_bottom_center(&w)?;
        w.show()?;
        eprintln!("[overlay] show");
    }
    Ok(())
}

/// 主窗口 focus 状态变化时调用（由 lib.rs 的 WindowEvent::Focused 转发）：
/// - 失焦：若期望可见，立即物理 show（用户切到别的 app 里说话需要悬浮条）。
/// - 获焦：若期望可见，物理 hide（让 Home 的 Live 面板接管展示，避免视觉重复）；
///         desired 状态保持，等下一次失焦再补偿。
/// 期望不可见（无录音流程）时 focus 变化无副作用。
pub fn on_main_focus_changed<R: Runtime>(
    app: &AppHandle<R>,
    focused: bool,
) -> tauri::Result<()> {
    if !DESIRED_VISIBLE.load(Ordering::Relaxed) {
        return Ok(());
    }
    if focused {
        if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
            if w.is_visible().unwrap_or(false) {
                w.hide()?;
                eprintln!("[overlay] main focused → hide (desired remains true)");
            }
        }
    } else {
        eprintln!("[overlay] main blurred → compensating show");
        show_now(app)?;
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
pub fn overlay_set_height<R: Runtime>(
    app: AppHandle<R>,
    height: f64,
) -> Result<(), String> {
    let Some(w) = app.get_webview_window(OVERLAY_LABEL) else {
        return Ok(());
    };
    let h = height.clamp(HEIGHT, 240.0);
    w.set_size(LogicalSize::new(WIDTH, h))
        .map_err(|e| e.to_string())?;
    position_to_bottom_center_with_height(&w, h).map_err(|e| e.to_string())?;
    Ok(())
}

