use active_win_pos_rs::get_active_window;

/// 返回当前系统前台应用的可读名（如 "Chrome" / "VS Code" / "Slack"）。
/// 任何失败（无权限、无窗口、平台不支持）都返回 None，调用方按 NULL 处理。
pub fn get_active_app_name() -> Option<String> {
    match get_active_window() {
        Ok(w) => {
            let name = w.app_name.trim().to_string();
            if name.is_empty() { None } else { Some(name) }
        }
        Err(_) => None,
    }
}
