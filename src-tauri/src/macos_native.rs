// macOS 原生 objc 操作：把进程提前台 / 关全屏能力 / 关 App Nap。
// 整个文件由 lib.rs 的 `#[cfg(target_os = "macos")] mod macos_native;` 守门，
// 故内部不再逐函数重复 cfg。crate 根的 `#![allow(unexpected_cfgs)]` 向下覆盖
// objc 0.2.x 的 msg_send! 宏展开，子模块无需重复声明。

// 把进程提到前台并让主窗成为 key window。
// plugin-updater 走 app.restart() 直接 spawn 二进制，不经 LaunchServices/`open`，
// 新进程默认不是 active app，窗口虽然 visible 但落在其他 app 后面，用户感知"最小化"。
pub(crate) fn activate_macos_app(window: &tauri::WebviewWindow) {
    use objc::runtime::{Object, BOOL, YES};
    use objc::{class, msg_send, sel, sel_impl};

    unsafe {
        let ns_app: *mut Object = msg_send![class!(NSApplication), sharedApplication];
        if !ns_app.is_null() {
            let _: BOOL = msg_send![ns_app, activateIgnoringOtherApps: YES];
        }
    }

    if let Ok(ptr) = window.ns_window() {
        let ns_window = ptr as *mut Object;
        if !ns_window.is_null() {
            unsafe {
                let _: () = msg_send![ns_window, makeKeyAndOrderFront: std::ptr::null::<Object>()];
            }
        }
    }
}

// macOS：通过 NSWindow.collectionBehavior 关闭全屏能力。
// 同时覆盖绿色按钮点击（默认进入全屏）与双击标题栏（若系统偏好设为"缩放"时会触发全屏）。
// 清除 FullScreenPrimary (1<<7)、写入 FullScreenNone (1<<9)，绿色按钮随即降级为 zoom。
pub(crate) fn disable_macos_fullscreen(window: &tauri::WebviewWindow) {
    use objc::runtime::Object;
    use objc::{msg_send, sel, sel_impl};

    const NS_WINDOW_COLLECTION_BEHAVIOR_FULL_SCREEN_PRIMARY: u64 = 1 << 7;
    const NS_WINDOW_COLLECTION_BEHAVIOR_FULL_SCREEN_NONE: u64 = 1 << 9;

    match window.ns_window() {
        Ok(ptr) => {
            let ns_window = ptr as *mut Object;
            if ns_window.is_null() {
                return;
            }
            unsafe {
                let current: u64 = msg_send![ns_window, collectionBehavior];
                let new_behavior: u64 = (current
                    & !NS_WINDOW_COLLECTION_BEHAVIOR_FULL_SCREEN_PRIMARY)
                    | NS_WINDOW_COLLECTION_BEHAVIOR_FULL_SCREEN_NONE;
                let _: () = msg_send![ns_window, setCollectionBehavior: new_behavior];
            }
        }
        Err(e) => log::warn!("[window] ns_window() failed: {e:?}"),
    }
}

// 进程级关闭 App Nap。主窗被前台 app 完全遮挡时，macOS 会 nap 本进程并节流
// webview 的 JS event loop（timer coalescing），导致「ASR 出结果 → 前端驱动
// AI refine」的编排卡在 pending，直到一次用户输入才解冻。OpenSpeech 是全局
// 快捷键驱动、必须随时响应的工具，被 nap 属于根本性错误，全程持有一个
// user-initiated activity assertion 关掉它。
//
// 注意：wry 的 backgroundThrottling 配置走 WKWebView inactiveSchedulingPolicy，
// 只覆盖 webview「脱离窗口」(not in a window) 的场景，管不到「窗口可见但被遮挡」
// 这条 App Nap 路径——所以那个配置对本问题无效，这里才是真正的解。
pub(crate) fn disable_app_nap() {
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};

    // NSActivityUserInitiatedAllowingIdleSystemSleep：阻止 App Nap，但允许系统
    // 在整体 idle 时正常进入睡眠（不霸占整机电源）。
    const NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP: u64 = 0x00EF_FFFF;

    unsafe {
        let process_info: *mut Object = msg_send![class!(NSProcessInfo), processInfo];
        if process_info.is_null() {
            return;
        }
        let reason: *mut Object = msg_send![
            class!(NSString),
            stringWithUTF8String: c"OpenSpeech stays responsive to global push-to-talk".as_ptr()
        ];
        let token: *mut Object = msg_send![
            process_info,
            beginActivityWithOptions: NS_ACTIVITY_USER_INITIATED_ALLOWING_IDLE_SYSTEM_SLEEP
            reason: reason
        ];
        // retain 让 token 活到进程结束 = activity 永久有效。不存 rust 侧、也不 end。
        let _: *mut Object = msg_send![token, retain];
    }
    log::warn!("[app-nap] disabled via NSProcessInfo activity (UserInitiatedAllowingIdleSystemSleep)");
}
