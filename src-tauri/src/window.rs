// 主窗口显隐 / 聚焦 / Dock 图标策略。隐藏到托盘时让 audio 让位、macOS 切 Accessory；
// 唤出时切回 Regular 并抢前台。toggle/show 是 pub(crate)，被 hotkey 与 openloaf 跨模块调用。

use crate::audio;
use tauri::{LogicalSize, Manager, PhysicalPosition, Runtime, Size};

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

/// Windows 的 UI 按实际像素显示；其它平台继续跟随显示器缩放。
pub(crate) fn ui_scale_factor(monitor_scale: f64) -> f64 {
    if cfg!(target_os = "windows") {
        1.0
    } else {
        monitor_scale
    }
}

pub(crate) fn ui_size(width: f64, height: f64) -> Size {
    let size = LogicalSize::new(width, height);
    if cfg!(target_os = "windows") {
        size.to_physical::<u32>(1.0).into()
    } else {
        size.into()
    }
}

/// 保留进程的 DPI awareness，避免 Windows 把整个窗口做模糊的位图拉伸。
/// WebView2 的页面缩放抵消系统 DPI，窗口尺寸则由调用方使用实际像素设置。
pub(crate) fn configure_ui_scale<R: Runtime>(
    _window: &tauri::WebviewWindow<R>,
) -> tauri::Result<()> {
    #[cfg(target_os = "windows")]
    {
        let window = _window;
        window.set_zoom(window.scale_factor()?.recip())?;

        let window_handle = window.clone();
        window.on_window_event(move |event| {
            if let tauri::WindowEvent::ScaleFactorChanged { scale_factor, .. } = event {
                // tao 在应用 WM_DPICHANGED 的建议尺寸之前发出此事件，此时仍能读取
                // 旧的实际尺寸。保留用户手动调整后的大小；最大化窗口继续填满工作区。
                let size = window_handle.inner_size().ok().filter(|size| {
                    size.width > 0
                        && size.height > 0
                        && !window_handle.is_maximized().unwrap_or(true)
                        && !window_handle.is_minimized().unwrap_or(true)
                });
                let scale = *scale_factor;
                let window = window_handle.clone();
                // 从工作线程排入 UI 队列，等 tao 本轮 DPI 自动调整完成后再还原尺寸。
                // 在事件回调里直接 set_size 会先执行，随后被 tao 的调整覆盖。
                tauri::async_runtime::spawn(async move {
                    if let Err(error) = window.set_zoom(scale.recip()) {
                        log::warn!("[window] failed to keep 100% UI scale: {error}");
                    }
                    if let Some(size) = size
                        && let Err(error) = window.set_size(size)
                    {
                        log::warn!("[window] failed to preserve physical size: {error}");
                    }
                });
            }
        });
    }
    Ok(())
}

const MAIN_WINDOW_IDEAL_WIDTH: f64 = 1060.0;
const MAIN_WINDOW_IDEAL_HEIGHT: f64 = 740.0;
const MAIN_WINDOW_MIN_WIDTH: f64 = 720.0;
const MAIN_WINDOW_MIN_HEIGHT: f64 = 480.0;
// 总边距（左右 / 上下之和），单位为 logical px。目标尺寸始终先从 work area
// 扣掉这圈空间；不能再用静态 min size 把它顶回去，否则小屏幕上的窗口
// 最小高度可能越过任务栏。Windows 使用实际像素，其它平台使用 logical px。
const MAIN_WINDOW_MARGIN_X: f64 = 80.0;
const MAIN_WINDOW_MARGIN_Y: f64 = 80.0;

#[derive(Debug, PartialEq)]
struct MainWindowLayout {
    width: f64,
    height: f64,
    min_width: f64,
    min_height: f64,
}

fn main_window_layout(work_width: f64, work_height: f64) -> MainWindowLayout {
    let width = MAIN_WINDOW_IDEAL_WIDTH.min((work_width - MAIN_WINDOW_MARGIN_X).max(1.0));
    let height = MAIN_WINDOW_IDEAL_HEIGHT.min((work_height - MAIN_WINDOW_MARGIN_Y).max(1.0));

    // 小于静态最小尺寸的工作区仍以“完整留在屏幕内”为最高优先级。动态下调
    // min size 后再 set_size，避免 Windows 先把目标值 clamp 回 720×480。
    MainWindowLayout {
        width,
        height,
        min_width: MAIN_WINDOW_MIN_WIDTH.min(width),
        min_height: MAIN_WINDOW_MIN_HEIGHT.min(height),
    }
}

pub(crate) fn fit_main_window_to_primary_monitor(window: &tauri::WebviewWindow) {
    let Some(monitor) = window.primary_monitor().ok().flatten() else {
        log::warn!("[main_window] primary monitor unavailable; keep configured startup size");
        return;
    };

    let scale = ui_scale_factor(monitor.scale_factor());
    let work_area = monitor.work_area();
    let work_width = work_area.size.width as f64 / scale;
    let work_height = work_area.size.height as f64 / scale;
    let layout = main_window_layout(work_width, work_height);

    if let Err(error) = window.set_min_size(Some(ui_size(layout.min_width, layout.min_height))) {
        log::warn!("[main_window] failed to adapt minimum size: {error}");
    }
    // 配置中的 maxWidth / maxHeight 也必须采用同一单位，否则 Windows 切屏后
    // 仍可能把窗口上限放大。其它平台继续使用 Tauri 的 logical size。
    if let Some(config) = window
        .app_handle()
        .config()
        .app
        .windows
        .iter()
        .find(|config| config.label == window.label())
        && let (Some(width), Some(height)) = (config.max_width, config.max_height)
        && let Err(error) = window.set_max_size(Some(ui_size(width, height)))
    {
        log::warn!("[main_window] failed to adapt maximum size: {error}");
    }
    if let Err(error) = window.set_size(ui_size(layout.width, layout.height)) {
        log::warn!("[main_window] failed to set startup size: {error}");
        return;
    }

    // center() 按整块显示器居中，任务栏停靠在左/上侧时仍可能把窗口压到任务栏下。
    // 直接按 work area 的物理坐标居中，避开任务栏并绕开混合 DPI 下坐标换算误差。
    let physical_width = (layout.width * scale).round().max(1.0) as u32;
    let physical_height = (layout.height * scale).round().max(1.0) as u32;
    let offset_x = work_area.size.width.saturating_sub(physical_width) / 2;
    let offset_y = work_area.size.height.saturating_sub(physical_height) / 2;
    let position = PhysicalPosition::new(
        work_area.position.x.saturating_add(offset_x as i32),
        work_area.position.y.saturating_add(offset_y as i32),
    );
    if let Err(error) = window.set_position(position) {
        log::warn!("[main_window] failed to center in work area: {error}");
    }

    log::info!(
        "[main_window] startup layout ui_scale={scale:.2} work_area={}x{} physical target={:.0}x{:.0} UI min={:.0}x{:.0}",
        work_area.size.width,
        work_area.size.height,
        layout.width,
        layout.height,
        layout.min_width,
        layout.min_height,
    );
}

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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_compact_default_on_large_work_area() {
        let layout = main_window_layout(1920.0, 1080.0);

        assert_eq!(layout.width, 1060.0);
        assert_eq!(layout.height, 740.0);
        assert_eq!(layout.min_width, 720.0);
        assert_eq!(layout.min_height, 480.0);
    }

    #[test]
    fn preserves_margin_on_small_logical_work_area() {
        let work_width = 1920.0 / 1.75;
        let work_height = 1040.0 / 1.75;
        let layout = main_window_layout(work_width, work_height);

        assert!((work_width - layout.width - MAIN_WINDOW_MARGIN_X).abs() < f64::EPSILON);
        assert!((work_height - layout.height - MAIN_WINDOW_MARGIN_Y).abs() < f64::EPSILON);
        assert!(layout.width <= work_width);
        assert!(layout.height <= work_height);
    }

    #[test]
    fn lowers_minimum_for_extremely_small_logical_work_area() {
        let layout = main_window_layout(780.0, 400.0);

        assert_eq!(layout.width, 700.0);
        assert_eq!(layout.height, 320.0);
        assert_eq!(layout.min_width, 700.0);
        assert_eq!(layout.min_height, 320.0);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn windows_uses_100_percent_size_at_every_monitor_scale() {
        for monitor_scale in [1.0, 1.25, 1.5, 1.75, 2.0] {
            let scale = ui_scale_factor(monitor_scale);
            let layout = main_window_layout(1920.0 / scale, 1040.0 / scale);

            assert_eq!(layout.width, 1060.0);
            assert_eq!(layout.height, 740.0);
            assert_eq!(
                ui_size(layout.width, layout.height).to_physical::<u32>(monitor_scale),
                tauri::PhysicalSize::new(1060, 740),
            );
            assert_eq!(
                ui_size(260.0, 150.0).to_physical::<u32>(monitor_scale),
                tauri::PhysicalSize::new(260, 150),
            );
            assert_eq!(
                ui_size(640.0, 440.0).to_physical::<u32>(monitor_scale),
                tauri::PhysicalSize::new(640, 440),
            );
        }
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn other_platforms_keep_logical_sizes() {
        assert_eq!(ui_scale_factor(2.0), 2.0);
        assert_eq!(
            ui_size(1060.0, 740.0).to_physical::<u32>(2.0),
            tauri::PhysicalSize::new(2120, 1480),
        );
    }
}
