// 应用级事件名常量：托盘菜单点击 / 窗口关闭与退出请求。前端在 Layout.tsx 订阅，
// 决定"关闭到后台 / 退出 / 弹对话框"以及托盘唤出主窗口 + Dialog/Navigate。

// 前端订阅此事件以决定"关闭到后台 / 退出 / 弹对话框"，见 Layout.tsx。
// close-requested: 关闭当前窗口的请求（红叉 / Cmd+W）。Onboarding 阶段会忽略，
// 避免误触关闭引导；主界面按 closeBehavior 偏好走（HIDE/QUIT/PROMPT）。
pub(crate) const CLOSE_REQUESTED_EVENT: &str = "openspeech://close-requested";
// quit-requested: 用户明确退出应用的请求（Cmd+Q）。Onboarding 与主界面都直接退出，
// 不弹"关闭还是隐藏"对话框——Cmd+Q 的语义就是退出。
#[cfg(target_os = "macos")]
pub(crate) const QUIT_REQUESTED_EVENT: &str = "openspeech://quit-requested";
// 托盘菜单事件：前端在 Layout.tsx 订阅，负责唤出主窗口 + Dialog/Navigate。
pub(crate) const TRAY_OPEN_HOME_EVENT: &str = "openspeech://tray-open-home";
pub(crate) const TRAY_OPEN_SETTINGS_EVENT: &str = "openspeech://tray-open-settings";
pub(crate) const TRAY_OPEN_DICTIONARY_EVENT: &str = "openspeech://tray-open-dictionary";
pub(crate) const TRAY_OPEN_TOOLBOX_EVENT: &str = "openspeech://tray-open-toolbox";
pub(crate) const TRAY_OPEN_HISTORY_EVENT: &str = "openspeech://tray-open-history";
pub(crate) const TRAY_OPEN_FEEDBACK_EVENT: &str = "openspeech://tray-open-feedback";
pub(crate) const TRAY_CHECK_UPDATE_EVENT: &str = "openspeech://tray-check-update";
pub(crate) const TRAY_SELECT_MIC_EVENT: &str = "openspeech://tray-select-mic";
