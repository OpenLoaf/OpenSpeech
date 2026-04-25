// 系统权限检测 / 请求 / 跳转设置 / TCC 重置
//
// macOS 上需要三类授权：
//   - 麦克风（隐私 → 麦克风）
//   - 辅助功能（隐私 → 辅助功能）—— enigo 模拟键盘粘贴需要
//   - 输入监控（隐私 → 输入监控）—— rdev 监听全局键盘需要
//
// **职责切分（v2 重构）**：
//   - **检测（check_*）**：本模块自己实现，走 Apple 系统 API 拿精细 5 值状态
//     `granted | denied | notDetermined | restricted | unknown`，UX 文案需要
//     区分 notDetermined（"请求授权"）vs denied（"去系统设置"）。
//   - **请求 麦克风 / 辅助功能（request_*）**：迁移到 `tauri-plugin-macos-permissions`，
//     前端直接调 plugin 暴露的 `requestMicrophonePermission` /
//     `requestAccessibilityPermission`（更可靠：plugin 用 Apple 官方
//     `AVCaptureDevice requestAccessForMediaType` 与 `macos-accessibility-client`，
//     替代了原先的 cpal probe / objc 0.2 hack）。
//   - **请求 输入监控（request_input_monitoring）**：本模块自己保留 IOHIDRequestAccess，
//     plugin 不调这个 API（它的实现只 open settings），但只有 IOHIDRequestAccess
//     能把 OpenSpeech 写入「输入监控」列表，这是修复"列表为空"的唯一路径。
//   - **TCC 重置 / 跳转设置（reset_tcc / open_settings）**：本模块独有，
//     plugin 不暴露这两类能力，但它们是恢复签名漂移 / denied 状态的关键。
//
// 状态字符串与前端 src/lib/permissions.ts 的 PermissionStatus 类型一一对应。
// macOS 之外的平台没有等价"未授权"概念，一律返回 granted。

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
pub fn permission_request_input_monitoring() {
    #[cfg(target_os = "macos")]
    {
        macos::request_input_monitoring();
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

