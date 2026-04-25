// 系统权限检测 / 请求 / 跳转设置
//
// macOS 上需要三类授权：
//   - 麦克风（隐私 → 麦克风）
//   - 辅助功能（隐私 → 辅助功能）—— enigo 模拟键盘粘贴需要
//   - 输入监控（隐私 → 输入监控）—— rdev 监听全局键盘需要
//
// 检测走系统 API（精准、零误报）；macOS 之外的平台没有等价"未授权"概念，
// 直接返回 granted 让 UI 流程继续。
//
// 状态字符串与前端 src/lib/permissions.ts 的 PermissionStatus 类型一一对应。

#[cfg(target_os = "macos")]
mod macos;

#[tauri::command]
pub fn permission_check_microphone() -> String {
    #[cfg(target_os = "macos")]
    {
        macos::microphone_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

#[tauri::command]
pub fn permission_check_accessibility() -> String {
    #[cfg(target_os = "macos")]
    {
        macos::accessibility_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

#[tauri::command]
pub fn permission_check_input_monitoring() -> String {
    #[cfg(target_os = "macos")]
    {
        macos::input_monitoring_status()
    }
    #[cfg(not(target_os = "macos"))]
    {
        "granted".to_string()
    }
}

#[tauri::command]
pub fn permission_request_microphone() {
    #[cfg(target_os = "macos")]
    {
        macos::request_microphone();
    }
}

#[tauri::command]
pub fn permission_request_input_monitoring() {
    #[cfg(target_os = "macos")]
    {
        macos::request_input_monitoring();
    }
}

#[tauri::command]
pub fn permission_request_accessibility() {
    #[cfg(target_os = "macos")]
    {
        macos::request_accessibility();
    }
}

#[tauri::command]
pub fn permission_open_settings(kind: String) {
    #[cfg(target_os = "macos")]
    {
        macos::open_settings(&kind);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = kind;
    }
}

/// macOS 专用：清空 OpenSpeech 在 TCC 中的所有相关条目（Accessibility /
/// ListenEvent / Microphone）。用户重新打开系统设置授权时会按当前签名身份
/// 重新登记，规避"已勾选但读不到"的 ad-hoc 重签名困境。其它平台 no-op。
#[tauri::command]
pub fn permission_reset_tcc(app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = app.config().identifier.clone();
        macos::reset_tcc(&bundle_id);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
    }
}

/// macOS 专用：精细 reset 单一 service 的 TCC 条目。`kind` 取
/// `"microphone" | "accessibility" | "input-monitoring"`。
///
/// 用途：用户在权限卡片点「去系统设置」时，若当前 status 是 denied（被拒过
/// 或签名漂移），先用本命令清掉**该项**旧条目，再调 `request_*` 让系统按
/// 当前签名身份重新写入隐私列表，最后 open settings——用户在系统设置里就
/// 能看到 OpenSpeech 这一条可勾选项了。比 `permission_reset_tcc` 一次性清
/// 三项更精准，不动用户已正确授权的其他权限。
#[tauri::command]
pub fn permission_reset_tcc_one(app: tauri::AppHandle, kind: String) {
    #[cfg(target_os = "macos")]
    {
        let bundle_id = app.config().identifier.clone();
        macos::reset_tcc_one(&bundle_id, &kind);
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, kind);
    }
}

/// 内部使用（非 invoke）：启动阶段判断是否可以安全启动 `rdev::listen`。
/// 走 `IOHIDCheckAccess`（只读），不会触发系统弹框、不会把 App 写入「输入监控」
/// 列表——所以可在 setup 期间无副作用调用。
///
/// 用途见 `hotkey::modifier_only::init`：
///   - granted ⇒ 启动 listen
///   - 未授权（denied / notDetermined）⇒ 跳过 listen，等用户在 Onboarding
///     StepPermissions 主动 IOHIDRequestAccess + 重启进程后下次再启
///
/// 这避免了"首启时 listen 自动触发系统弹框 → 弹框被随后 show 的主窗口遮挡"
/// 的体验问题。
#[cfg(target_os = "macos")]
pub fn input_monitoring_granted() -> bool {
    macos::input_monitoring_status() == "granted"
}
