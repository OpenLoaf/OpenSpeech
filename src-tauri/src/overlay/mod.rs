// OpenSpeech 悬浮录音条子窗口
//
// 独立窗口：transparent + alwaysOnTop + no-decorations + focus:false + skipTaskbar。
// 位置固定屏幕底部中央；显隐由前端状态机驱动，Rust 只做物理资源管理。
//
// 加载路径 /overlay；前端按 window label 分流渲染 OverlayPage。

use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};

use tauri::{
    AppHandle, LogicalPosition, Manager, Monitor, Runtime, WebviewUrl, WebviewWindowBuilder,
    utils::config::BackgroundThrottlingPolicy,
};

pub const OVERLAY_LABEL: &str = "overlay";

// follow-focus watcher 全局只起一份。多次 ensure_overlay 调用幂等。
static FOLLOW_FOCUS_STARTED: AtomicBool = AtomicBool::new(false);
// 上次定位时所在屏的 physical origin (x:i32, y:i32) 打包成 i64：高 32 位 x，低 32 位 y。
// MIN 表示尚未初始化，watcher 第一次 tick 会判定为"变了"，但此时悬浮条要么没显示
// （直接 skip）、要么 show() 刚定位完（key 已被 position_to_bottom_center 写入），
// 都不会产生无意义重定位。
static LAST_MON_ORIGIN: AtomicI64 = AtomicI64::new(i64::MIN);
// follow-focus 轮询节流 ms。手动切屏（cmd+tab / 鼠标点过去）后用户感知接受 ~400ms 延迟；
// 再低 CPU 收益不大，再高用户会察觉滞后。
const FOLLOW_FOCUS_INTERVAL_MS: u64 = 400;

fn pack_origin(x: i32, y: i32) -> i64 {
    ((x as i64) << 32) | (y as u32 as i64)
}
// 260：pill 设计宽度 200 已经偏窄——失败 toast 的 description 在 200 logical px
// 上即便放到 11px 字号也只能塞 1 行，常见错误（"自定义供应商凭证缺失，请到设置 →
// 听写 → 自定义供应商配置"）会被 ellipsis 吞掉一半。260 让 toast 字号能升到 11px、
// description 折两行可读，pill 形态（X · 波形 · ✓）依旧不显得稀疏。
const WIDTH: f64 = 260.0;
// 窗口固定为"最大可能高度"——pill 36 + toast 64 + gap 4 + debug strip 28 + gap 4
// 还留 16 px 缓冲。固定窗口尺寸可以避免 toast 出现 / debug 切换那一瞬调
// NSWindow setContentSize 引起的整窗同步重绘（pill 看起来"闪一下刷新"）。
// pill 在 webview 内 flex justify-end 贴底，视觉位置与 36 高度时一致。
const HEIGHT: f64 = 150.0;
// pill 与可视区底（macOS 即 Dock 顶 / Win·Linux 即 taskbar 顶）的留白：
// 正值往上抬。macOS 原 -8（pill 伸进 Dock 区域）视觉上挤兑 Dock，用户反馈太低，
// 改 +16 让 pill 与 Dock 之间留半个 menubar 高的视觉缓冲。
#[cfg(target_os = "macos")]
const BOTTOM_MARGIN: f64 = 16.0;
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
            // 悬浮条永远是 unfocused，macOS WebKit 默认会 throttle 它的 JS 事件循环，
            // 导致后台时 overlay 状态机迟迟不更新。强制关掉。
            .background_throttling(BackgroundThrottlingPolicy::Disabled)
            .title("OpenSpeech Overlay");

    #[cfg(target_os = "macos")]
    let builder = builder.visible_on_all_workspaces(true);

    let window = builder.build()?;

    position_to_bottom_center(&window)?;

    #[cfg(target_os = "macos")]
    {
        enable_accepts_first_mouse(&window);
        promote_to_nonactivating_panel(&window);
    }

    spawn_follow_focus_watcher(app);

    log::warn!("[overlay] window created (hidden, transparent)");
    Ok(())
}

// 让悬浮条跟随用户的"聚焦屏"。多显示器场景下，show() 时只按当时 cursor 位置定位一次，
// 之后用户把鼠标 / 注意力切到另一块屏时悬浮条还卡在原屏。本 watcher 在悬浮条可见期间
// 低频复用 active_monitor()（cursor → monitor）做对比，monitor origin 变化时重新定位。
//
// 信号选择：cursor 而非 frontmost window 的 NSScreen——绝大多数手动切屏会带鼠标过去，
// 实现还跨平台。纯键盘 cmd+tab 到另一屏的 app 不会触发，作为已知遗漏接受。
fn spawn_follow_focus_watcher<R: Runtime>(app: &AppHandle<R>) {
    if FOLLOW_FOCUS_STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    let app_clone = app.clone();
    tauri::async_runtime::spawn(async move {
        use std::time::Duration;
        let mut tick = tokio::time::interval(Duration::from_millis(FOLLOW_FOCUS_INTERVAL_MS));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        // 第一拍 interval 立刻 fire，但此时窗口刚建好通常还没 show，会直接 skip。
        tick.tick().await;
        loop {
            tick.tick().await;
            let app_for_main = app_clone.clone();
            // 全部丢到主线程：is_visible / set_position 在 macOS 必须主线程；cursor / monitors
            // 读取也一并放进去，避免分散在两边引入额外的同步开销。
            let _ = app_clone.run_on_main_thread(move || {
                follow_focus_tick(&app_for_main);
            });
        }
    });
}

fn follow_focus_tick<R: Runtime>(app: &AppHandle<R>) {
    let Some(w) = app.get_webview_window(OVERLAY_LABEL) else {
        return;
    };
    if !w.is_visible().unwrap_or(false) {
        return;
    }

    // macOS：position_to_bottom_center 内部走 native 路径，自带判变 + 落位 + 写 LAST_MON_ORIGIN。
    #[cfg(target_os = "macos")]
    {
        if let Err(e) = position_to_bottom_center(&w) {
            log::warn!("[overlay] follow-focus reposition failed: {e:?}");
        }
        let _ = app;
        return;
    }

    // 非 macOS：先用 Tauri 抽象拿 cursor → monitor，origin 变了才走完整重定位。
    #[cfg(not(target_os = "macos"))]
    {
        let Ok(Some(m)) = active_monitor(app) else {
            return;
        };
        let key = pack_origin(m.position().x, m.position().y);
        if LAST_MON_ORIGIN.load(Ordering::Relaxed) == key {
            return;
        }
        log::info!(
            "[overlay] active monitor changed → repositioning (cursor monitor origin=({},{}))",
            m.position().x,
            m.position().y,
        );
        if let Err(e) = position_to_bottom_center(&w) {
            log::warn!("[overlay] follow-focus reposition failed: {e:?}");
        }
    }
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
        BOOL, Class, Imp, Object, Sel, YES, class_addMethod, class_getInstanceMethod,
        method_setImplementation,
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
    // macOS：跳过 Tauri 抽象，自己用 NSScreen / NSEvent / setFrameOrigin: 落位。
    // 原因——tao 在 cursor_position() 里用 primary_monitor 的 scale_factor 把 NSEvent
    // mouseLocation 的 logical 坐标乘成 physical，但 monitor.position() 用各自屏的
    // scale_factor 把 CGDisplayBounds 乘成 physical。混合 DPI 多屏（如内屏 retina +
    // 外屏非 retina）下两边 scale 来源不一样，cursor → monitor 命中检测必错，最终
    // 不管鼠标在哪一屏 active_monitor 都会回落到 primary。
    #[cfg(target_os = "macos")]
    {
        match position_macos_native(window) {
            Ok(true) => return Ok(()),
            Ok(false) => {
                log::warn!("[overlay] native macOS positioning failed, fall back to Tauri path");
            }
            Err(e) => {
                log::warn!("[overlay] native macOS positioning errored: {e}, fall back");
            }
        }
    }

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
    log::info!(
        "[overlay] (fallback) target monitor name={:?} work_area_origin=({},{}) work_area_size=({}x{}) scale={} → logical_pos=({:.1},{:.1})",
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
    LAST_MON_ORIGIN.store(
        pack_origin(monitor.position().x, monitor.position().y),
        Ordering::Relaxed,
    );
    Ok(())
}

// macOS 上自己实现"按输入焦点屏落位"，绕开 tao 的混 DPI cursor_position bug、并把
// 信号从"鼠标在哪屏"切换成"前台 app 的 key window 在哪屏"。
//
// 信号链：
//   1. NSWorkspace.frontmostApplication → 拿到前台 app 的 PID。
//      如果前台 app 就是 OpenSpeech 自己（用户切回主窗或子窗），不重定位 —— 悬浮条留在
//      它"为目标 app 服务"那一屏；否则切设置/主窗时悬浮条会一直跟着我们自己跑。
//   2. CGWindowListCopyWindowInfo（OnScreenOnly + ExcludeDesktopElements）拿到当前所有可见
//      window；过滤 PID == frontmost；按数组顺序取第一个 size > 50pt 的 → 作为 key window。
//      （CGWindowList 数组顺序是 z-order 从上到下，最前面就是 key window；这是 active-win-pos-rs
//      底层用的同一套办法。复用其 ActiveWindow 拿到 CGRect。）
//   3. 用该 window 的中心点判定它在哪个 NSScreen 内。注意坐标系：
//      - CGWindowBounds（即 active-win-pos-rs 的 WindowPosition）= 全局 logical points，
//        Top-Left 原点（主屏左上为 0,0），Y 向下。
//      - NSScreen.frame = 全局 logical points，Bottom-Left 原点（主屏左下为 0,0），Y 向上。
//      转换：ns_y = mainScreen.frame.size.height - cg_y（在主屏高度上做镜像）。
//   4. 用命中 NSScreen 的 visibleFrame 算窗口左下角 NSPoint，直接 setFrameOrigin: 落位。
//
// BOTTOM_MARGIN 负值表示"超出 visibleFrame 底边再下一点"，让胶囊视觉上更贴 Dock 顶；
// NSScreen Y-up，所以 ns_origin.y = visibleFrame.origin.y + BOTTOM_MARGIN。
//
// 返回 Ok(true) 表示已成功定位（含"焦点屏没变 → silent skip"），
// Ok(false) / Err 触发 fallback 到 Tauri 路径。
#[cfg(target_os = "macos")]
fn position_macos_native<R: Runtime>(
    window: &tauri::WebviewWindow<R>,
) -> Result<bool, &'static str> {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSRect {
        origin: NSPoint,
        size: NSSize,
    }

    let our_pid = std::process::id() as u64;
    let prev_key = LAST_MON_ORIGIN.load(Ordering::Relaxed);
    let first_time = prev_key == i64::MIN;

    // 第一步：拿前台 app 的 key window CGRect。前台 = OpenSpeech 自己 / 取不到 window 时，
    // 走分支二（首次兜底到 mainScreen；后续保持原位）。
    let active = match active_win_pos_rs::get_active_window() {
        Ok(w) if w.process_id != our_pid => Some(w),
        Ok(_) => None,
        Err(_) => None,
    };

    unsafe {
        let screens: *mut Object = msg_send![class!(NSScreen), screens];
        if screens.is_null() {
            return Ok(false);
        }
        let count: usize = msg_send![screens, count];

        // CG 坐标系的"主屏" = 含 menubar 那块 = NSScreen.screens 里 frame.origin == (0,0)
        // 的那一块（CG/NSScreen 系都以此屏为原点）。**不要**用 NSScreen.mainScreen ——
        // 它的语义是"含 key window 的屏"，焦点跑到副屏后会变成副屏，用它的高度做 Y 翻转
        // 基准就错了，命中检测在副屏永远 miss。
        let mut cg_primary_height: f64 = 0.0;
        for i in 0..count {
            let s: *mut Object = msg_send![screens, objectAtIndex: i];
            if s.is_null() {
                continue;
            }
            let f: NSRect = msg_send![s, frame];
            if f.origin.x == 0.0 && f.origin.y == 0.0 {
                cg_primary_height = f.size.height;
                break;
            }
        }
        if cg_primary_height == 0.0 {
            // 极端兜底：没找到 origin (0,0) 的屏（不应该发生，macOS 总有一块在原点）。
            // 退到 NSScreen[0]，避免直接放弃整个 native 路径。
            let s0: *mut Object = msg_send![screens, objectAtIndex: 0];
            if !s0.is_null() {
                let f0: NSRect = msg_send![s0, frame];
                cg_primary_height = f0.size.height;
                log::warn!(
                    "[overlay] no NSScreen at origin (0,0); falling back to screens[0].height={:.1}",
                    cg_primary_height
                );
            } else {
                return Ok(false);
            }
        }

        let mut target: *mut Object = std::ptr::null_mut();
        let mut target_frame = NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize {
                width: 0.0,
                height: 0.0,
            },
        };

        if let Some(ref a) = active {
            let win_cx = a.position.x + a.position.width / 2.0;
            let win_cy_cg = a.position.y + a.position.height / 2.0;
            // CG (top-left origin, Y-down) → NSScreen (bottom-left origin, Y-up)：
            // 以 CG 主屏高度为基准镜像。
            let win_cy_ns = cg_primary_height - win_cy_cg;
            for i in 0..count {
                let s: *mut Object = msg_send![screens, objectAtIndex: i];
                if s.is_null() {
                    continue;
                }
                let f: NSRect = msg_send![s, frame];
                if win_cx >= f.origin.x
                    && win_cx < f.origin.x + f.size.width
                    && win_cy_ns >= f.origin.y
                    && win_cy_ns < f.origin.y + f.size.height
                {
                    target = s;
                    target_frame = f;
                    break;
                }
            }
            if target.is_null() && !first_time {
                // 焦点窗口中心点不在任何 NSScreen（极少见：fullscreen 异常 / 跨屏边缘）。
                // 非首次：保持原位，不强行回 main，避免把悬浮条从用户屏上拽走。
                log::warn!(
                    "[overlay] focused window center ({:.1},{:.1} CG / {:.1} NS-y) outside any NSScreen → keep",
                    win_cx,
                    win_cy_cg,
                    win_cy_ns
                );
                return Ok(true);
            }
        } else if !first_time {
            // 没拿到外部前台 window（前台是自己 / 拿不到）→ 非首次保持原位。
            log::debug!(
                "[overlay] frontmost not external (pid_self={}), keep current screen",
                our_pid
            );
            return Ok(true);
        }

        // 走到这里：要么命中了一个 target（焦点信号有效），要么 first_time + 焦点信号无效
        // → 兜底到 CG 主屏（含 menubar 那块）给窗口一个合理初始位置。
        if target.is_null() {
            for i in 0..count {
                let s: *mut Object = msg_send![screens, objectAtIndex: i];
                if s.is_null() {
                    continue;
                }
                let f: NSRect = msg_send![s, frame];
                if f.origin.x == 0.0 && f.origin.y == 0.0 {
                    target = s;
                    target_frame = f;
                    break;
                }
            }
            if target.is_null() {
                let s0: *mut Object = msg_send![screens, objectAtIndex: 0];
                if s0.is_null() {
                    return Ok(false);
                }
                target = s0;
                target_frame = msg_send![target, frame];
            }
            log::info!(
                "[overlay] first-time positioning fallback → CG primary screen (origin=({:.1},{:.1}))",
                target_frame.origin.x,
                target_frame.origin.y
            );
        }

        let screen_key = pack_origin(target_frame.origin.x as i32, target_frame.origin.y as i32);

        let visible: NSRect = msg_send![target, visibleFrame];
        let ns_x = visible.origin.x + (visible.size.width - WIDTH) / 2.0;
        let ns_y = visible.origin.y + BOTTOM_MARGIN;

        if prev_key == screen_key {
            return Ok(true);
        }

        let (front_name, front_pid, win_x, win_y, win_w, win_h) = match active.as_ref() {
            Some(a) => (
                a.app_name.as_str(),
                a.process_id,
                a.position.x,
                a.position.y,
                a.position.width,
                a.position.height,
            ),
            None => ("<none>", 0, 0.0, 0.0, 0.0, 0.0),
        };
        log::info!(
            "[overlay] native position: frontmost=\"{}\" pid={} win_cg=({:.1},{:.1},{:.1}x{:.1}) → screen.frame.origin=({:.1},{:.1}) visibleFrame=({:.1},{:.1})/({:.1}x{:.1}) → setFrameOrigin=({:.1},{:.1})",
            front_name,
            front_pid,
            win_x,
            win_y,
            win_w,
            win_h,
            target_frame.origin.x,
            target_frame.origin.y,
            visible.origin.x,
            visible.origin.y,
            visible.size.width,
            visible.size.height,
            ns_x,
            ns_y,
        );

        let ns_window_ptr: *mut Object = match window.ns_window() {
            Ok(p) => p as *mut Object,
            Err(_) => return Err("ns_window() failed"),
        };
        if ns_window_ptr.is_null() {
            return Err("ns_window() null");
        }
        let origin = NSPoint { x: ns_x, y: ns_y };
        let _: () = msg_send![ns_window_ptr, setFrameOrigin: origin];
        LAST_MON_ORIGIN.store(screen_key, Ordering::Relaxed);
        Ok(true)
    }
}

// 鼠标命中的屏 → primary → 第一块。走 AppHandle 拿全局光标，避免 hidden window 上读不到。
fn active_monitor<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Option<Monitor>> {
    let monitors = app.available_monitors()?;
    if let Ok(cursor) = app.cursor_position() {
        let cx = cursor.x;
        let cy = cursor.y;
        log::debug!("[overlay] cursor physical=({cx},{cy})");
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
        log::debug!("[overlay] show");
    }
    Ok(())
}

// hide 单 command：先移屏外再 hide，避免 hide 完成前的最后一帧露馅。
pub fn hide<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.set_position(LogicalPosition::new(OFFSCREEN_POSITION, OFFSCREEN_POSITION));
        w.hide()?;
        // 清掉锚屏 key —— 我们刚把窗口物理位置改成 (-10000,-10000)，下一次 show() 即便
        // 焦点屏没变，也必须重新 setFrameOrigin: 把窗口拉回正确位置；否则 native 路径会
        // 误以为"同屏可以 silent skip"，悬浮条永远卡在屏外。
        LAST_MON_ORIGIN.store(i64::MIN, Ordering::Relaxed);
        log::info!("[overlay] hide invoked");
    }
    Ok(())
}

// 根因修复：把 overlay 的 NSWindow isa 切到系统 NSPanel + 加 nonactivating panel
// styleMask。这是 macOS 处理 spotlight / 状态栏 popover 类悬浮窗的标准方式（社区
// tauri-nspanel plugin 用同样手法）。
//
// 为什么这是根因——NSApp.deactivate / hide-before-deactivate 都救不回来：
//   T0:    user click overlay button (mouseDown)
//   T0+ε:  overlay NSWindow becomeKeyWindow → NSApp 被 AppKit 设为 active
//   T0+ε:  AppKit 立即把同 app 的 main window raise 到前面 ← 主窗在这一瞬已经露脸
//   T0+ε:  webview button onClick 才轮到执行
//   T1+:   我们才能 invoke overlay_hide
// 等我们能 deactivate 时主窗早就被顶上来了，靠 hide 路径救不回来。
//
// NSWindowStyleMaskNonactivatingPanel (1 << 7) 仅对 NSPanel 类型生效——AppKit 看
// 到这位会把 click 当成「不抢 key window 不激活 app」处理，鼠标事件仍照常派发
// 给 contentView。所以必须先把这个 NSWindow 实例的 isa 换成 NSPanel。
//
// object_setClass 切到 system 的 NSPanel（不是动态创建子类），不会撞 wry 内部
// KVO（之前 objc_allocateClassPair(wry_class) 创建子类才会撞）。NSPanel 是
// NSWindow 的子类，dealloc 链 / observer 链都还能正常走完。
#[cfg(target_os = "macos")]
fn promote_to_nonactivating_panel<R: Runtime>(window: &tauri::WebviewWindow<R>) {
    use objc::runtime::{Class, Object};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe extern "C" {
        fn object_setClass(obj: *mut Object, cls: *mut Class) -> *mut Class;
    }

    const NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL: u64 = 1 << 7;

    let ns_window_ptr = match window.ns_window() {
        Ok(p) => p as *mut Object,
        Err(e) => {
            log::warn!("[overlay] ns_window() failed (panel promote): {e:?}");
            return;
        }
    };
    if ns_window_ptr.is_null() {
        return;
    }
    unsafe {
        let panel_class: *mut Class = class!(NSPanel) as *const _ as *mut Class;
        let _: *mut Class = object_setClass(ns_window_ptr, panel_class);

        let current_mask: u64 = msg_send![ns_window_ptr, styleMask];
        let new_mask = current_mask | NS_WINDOW_STYLE_MASK_NONACTIVATING_PANEL;
        let _: () = msg_send![ns_window_ptr, setStyleMask: new_mask];

        log::info!(
            "[overlay] promoted to NSPanel + nonactivating panel (styleMask {:#x} -> {:#x})",
            current_mask,
            new_mask
        );
    }
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
