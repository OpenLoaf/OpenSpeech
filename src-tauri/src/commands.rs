// 零散平台 / 工具类命令：互不相关、都是薄包装，集中在此避免堆在 lib.rs 顶部。
// 窗口显隐相关命令见 window.rs，托盘相关见 tray.rs，日志相关见 logging.rs。

use crate::{active_app, audio, db, stt};

#[tauri::command]
pub(crate) fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
pub(crate) fn get_platform_info() -> serde_json::Value {
    // hostname / devicename / username 来自 whoami；获取失败（罕见，如 sandbox 限制）走空串兜底——
    // 前端按空字符串视作"不可用"，省掉 Result 一路 await 错误处理。
    let hostname = whoami::hostname().unwrap_or_default();
    let device_name = whoami::devicename().unwrap_or_default();
    let username = whoami::username().unwrap_or_default();
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
        "hostname": hostname,
        "deviceName": device_name,
        "username": username,
    })
}

#[tauri::command]
pub(crate) fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub(crate) fn get_saas_sdk_version() -> &'static str {
    env!("OPENLOAF_SAAS_SDK_VERSION")
}

/// 应急清场：强制 drop cpal stream + 关掉残留 stt session。
/// 前端 boot 时调一次兜底"上轮 webview reload / 状态机错乱"导致的 mic 占用泄漏——
/// macOS 状态栏的橙色录音指示灯只在 cpal Stream 还活着时点亮，正常 stop 路径减不到
/// ref_count=0 就关不掉。无副作用：没有遗留时是 no-op。
#[tauri::command]
pub(crate) fn app_emergency_reset() {
    audio::force_stop();
    stt::close_if_active();
}

// 用于权限授权后重启进程：macOS AXIsProcessTrusted 与 AVCaptureDevice
// authorizationStatus 都是 per-process 缓存，用户在系统设置勾选后老进程
// 仍读到 not-granted；必须重启进程才能拿到新值。Tauri 2 的 AppHandle.restart()
// 会 spawn 一个新实例并干净退出当前进程。
#[tauri::command]
pub(crate) fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
pub(crate) fn get_active_window_info_cmd() -> Option<active_app::ActiveWindowInfo> {
    active_app::get_active_window_info()
}

/// 打开 `app_data_dir/recordings/`（不存在则先创建）。给历史记录页"打开存储
/// 文件夹"按钮用——按日期子目录拆分后，用户从这里翻历史 OGG 最方便。
#[tauri::command]
pub(crate) fn open_recordings_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let dir = db::ensure_recordings_dir(&app)?;
    let path = dir
        .to_str()
        .ok_or_else(|| format!("recordings dir contains non-utf8 chars: {dir:?}"))?
        .to_string();

    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("open_path failed: {e:?}"))
}

// "没有互联网连接"对话框上的"打开系统设置"按钮调用。
// 直接 spawn 系统命令打开网络设置面板——`tauri-plugin-opener` 默认 scope 不允许
// `x-apple.systempreferences:` / `ms-settings:` 这种自定义 scheme，自管更省事。
// 失败只记日志（按钮已经按下了，弹另一个错误对话框打扰更甚）。
#[tauri::command]
pub(crate) fn open_network_settings() {
    use std::process::Command;

    #[cfg(target_os = "macos")]
    let result = Command::new("open")
        .arg("x-apple.systempreferences:com.apple.Network-Settings.extension")
        .spawn();

    // Windows 10/11：ms-settings:network-status 是网络与 Internet 设置主页
    #[cfg(target_os = "windows")]
    let result = Command::new("cmd")
        .args(["/C", "start", "ms-settings:network-status"])
        .spawn();

    // Linux 没有统一入口；优先 GNOME（gnome-control-center），失败时回退 KDE。
    // 都失败也不强求——用户可以自己去打开。
    #[cfg(target_os = "linux")]
    let result = Command::new("gnome-control-center")
        .arg("network")
        .spawn()
        .or_else(|_| {
            Command::new("kcmshell5")
                .arg("kcm_networkmanagement")
                .spawn()
        });

    if let Err(e) = result {
        log::warn!("[network] open_network_settings failed: {e:?}");
    }
}
