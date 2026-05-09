use active_win_pos_rs::get_active_window;

#[derive(Debug, serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowInfo {
    /// 前台应用名（如 "Chrome" / "VS Code" / "Slack"）。
    pub name: String,
    /// 窗口标题（如 "main.rs — vscode" / "Zhao 的 MacBook Pro - 终端"）。
    /// 部分 app + 平台组合可能为空（无 title 也是合法状态）。
    pub title: String,
    /// 跨平台稳定标识：
    ///   macOS  → NSWorkspace.frontmostApplication.bundleIdentifier（com.tencent.xinWeChat）
    ///   其他   → process_path 的 file_name（Code.exe / wechat），按 active-win-pos-rs 已返
    ///           回的 PathBuf 直接抽。
    /// 前端 AppOverride（按 appId 精确匹配某软件做规则覆盖）拿这个字段当 key。
    /// 拿不到（无 bundle_id / system process / 权限不足）= None，回落到 name 分类。
    pub app_id: Option<String>,
}

/// 返回前台窗口的应用名 + 标题。任何失败（无权限、无窗口、平台不支持）返回 None，
/// 调用方按 NULL 处理。空 name 视作"识别不到"，单独空 title 仍返回。
pub fn get_active_window_info() -> Option<ActiveWindowInfo> {
    match get_active_window() {
        Ok(w) => {
            let name = w.app_name.trim().to_string();
            if name.is_empty() {
                return None;
            }
            let app_id = resolve_app_id(&w.process_path);
            Some(ActiveWindowInfo {
                name,
                title: w.title.trim().to_string(),
                app_id,
            })
        }
        Err(_) => None,
    }
}

#[cfg(target_os = "macos")]
fn resolve_app_id(_process_path: &std::path::Path) -> Option<String> {
    // 任意线程都能调 frontmostApplication（不是 UI 操作，无线程亲和性）；但 tokio worker
    // 没有自带的 RunLoop autorelease pool，NSString 等 autoreleased 临时对象会一直挂到线程退出，
    // worker 长期复用 = 累积泄漏。包一层 autoreleasepool 把这次调用产生的临时对象立刻清掉。
    macos::frontmost_bundle_id()
}

#[cfg(not(target_os = "macos"))]
fn resolve_app_id(process_path: &std::path::Path) -> Option<String> {
    // Windows / Linux：active-win-pos-rs 已经返回了完整 process_path，
    // 取 file_name 当稳定 key（跨安装位置稳定，少数同名 exe 会撞但实务可接受）。
    process_path
        .file_name()
        .and_then(|s| s.to_str())
        .map(|s| s.to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(target_os = "macos")]
mod macos {
    use objc::rc::autoreleasepool;
    use objc::runtime::Object;
    use objc::{class, msg_send, sel, sel_impl};
    use std::ffi::CStr;

    /// 通过 NSWorkspace 拿当前 frontmost 应用的 bundleIdentifier。
    /// 返回值约定：拿不到 / 是 nil / 转换失败 → None；不要 panic。
    pub(super) fn frontmost_bundle_id() -> Option<String> {
        // autoreleasepool：保证本次调用产生的 autoreleased 对象（bundleIdentifier 取属性时
        // 内部走的 NSString 临时对象）在闭包结束时统一释放，不依赖外层 RunLoop。
        autoreleasepool(|| {
            // SAFETY: 只读取 NSWorkspace 单例 + 当前 frontmost app 的 NSString 字段。
            // 不持有 retain，所有指针由 pool 负责。任一步 nil 立刻 bail。
            unsafe {
                let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
                if workspace.is_null() {
                    return None;
                }
                let frontmost: *mut Object = msg_send![workspace, frontmostApplication];
                if frontmost.is_null() {
                    return None;
                }
                let ns_bundle: *mut Object = msg_send![frontmost, bundleIdentifier];
                if ns_bundle.is_null() {
                    return None;
                }
                let utf8: *const i8 = msg_send![ns_bundle, UTF8String];
                if utf8.is_null() {
                    return None;
                }
                // CStr → String 是 Rust 端 owned 拷贝，CStr 指向的内存归 autoreleased
                // NSString，pool 退出时释放——这里的 String 不持有任何 obj-c 内存。
                let s = CStr::from_ptr(utf8).to_string_lossy().into_owned();
                if s.is_empty() { None } else { Some(s) }
            }
        })
    }
}
