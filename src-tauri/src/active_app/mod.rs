use active_win_pos_rs::get_active_window;

#[derive(Debug, serde::Serialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct ActiveWindowInfo {
    /// 前台应用名（如 "Chrome" / "VS Code" / "Slack"）。
    pub name: String,
    /// 窗口标题（如 "main.rs — vscode" / "Zhao 的 MacBook Pro - 终端"）。
    /// 部分 app + 平台组合可能为空（无 title 也是合法状态）。
    pub title: String,
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
            Some(ActiveWindowInfo {
                name,
                title: w.title.trim().to_string(),
            })
        }
        Err(_) => None,
    }
}
