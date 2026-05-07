// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// objc 0.2.x 的 msg_send! 宏内部仍在用 cfg(feature = "cargo-clippy")，新 rustc 在
// 宏展开点报 unexpected_cfgs lint。函数级 / mod 级 #[allow] 都覆盖不到展开 token，
// 必须 crate 级 inner attribute 才生效。upstream 不再维护，无法通过升级解决。
#![allow(unexpected_cfgs)]

use std::sync::Mutex;
use tauri::{
    Emitter, LogicalSize, Manager, Runtime, WindowEvent,
    menu::{
        CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
        SubmenuBuilder,
    },
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_store::StoreExt;

#[cfg(target_os = "macos")]
use tauri::ActivationPolicy;

mod active_app;
mod ai_refine;
pub mod asr;
mod audio;
mod cue;
mod db;
mod hotkey;
mod http;
mod idle;
mod inject;
mod meetings;
mod openloaf;
mod overlay;
mod permissions;
pub mod secrets;
mod stt;
mod transcribe;
mod update_channel;

// 前端订阅此事件以决定"关闭到后台 / 退出 / 弹对话框"，见 Layout.tsx。
// close-requested: 关闭当前窗口的请求（红叉 / Cmd+W）。Onboarding 阶段会忽略，
// 避免误触关闭引导；主界面按 closeBehavior 偏好走（HIDE/QUIT/PROMPT）。
const CLOSE_REQUESTED_EVENT: &str = "openspeech://close-requested";
// quit-requested: 用户明确退出应用的请求（Cmd+Q）。Onboarding 与主界面都直接退出，
// 不弹"关闭还是隐藏"对话框——Cmd+Q 的语义就是退出。
#[cfg(target_os = "macos")]
const QUIT_REQUESTED_EVENT: &str = "openspeech://quit-requested";
// 托盘菜单事件：前端在 Layout.tsx 订阅，负责唤出主窗口 + Dialog/Navigate。
const TRAY_OPEN_HOME_EVENT: &str = "openspeech://tray-open-home";
const TRAY_OPEN_SETTINGS_EVENT: &str = "openspeech://tray-open-settings";
const TRAY_OPEN_DICTIONARY_EVENT: &str = "openspeech://tray-open-dictionary";
const TRAY_OPEN_TOOLBOX_EVENT: &str = "openspeech://tray-open-toolbox";
const TRAY_OPEN_HISTORY_EVENT: &str = "openspeech://tray-open-history";
const TRAY_OPEN_FEEDBACK_EVENT: &str = "openspeech://tray-open-feedback";
const TRAY_CHECK_UPDATE_EVENT: &str = "openspeech://tray-check-update";
const TRAY_SELECT_MIC_EVENT: &str = "openspeech://tray-select-mic";

// 托盘菜单文案：Rust 不嵌 i18n，文案完全由前端按当前语言推过来。bootPromise 完成后
// 前端 syncI18nFromSettings 会调用 update_tray_labels 一次；之后切语言再推。空槽位
// 用英文兜底（首次启动 / 前端未来得及推）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub struct TrayLabels {
    pub feedback: String,
    pub open_home: String,
    /// `show_main_window` 当前 binding 的 muda accelerator 字符串（如 "Ctrl+Alt+O"）。
    /// 空字符串 = 不显示快捷键。前端 i18n-sync 在 binding 变动 / 切语言时一起 push。
    #[serde(default)]
    pub open_home_accel: String,
    pub open_toolbox: String,
    pub open_history: String,
    pub open_settings: String,
    pub mic_submenu: String,
    pub auto_detect: String,
    // "Auto-detect ({name})" 模板里的前缀，用于显示当前默认设备名。
    pub auto_detect_with_name: String,
    pub open_dictionary: String,
    pub check_update: String,
    pub quit: String,
}

impl Default for TrayLabels {
    fn default() -> Self {
        Self {
            feedback: "Feedback".into(),
            open_home: "Open home".into(),
            open_home_accel: String::new(),
            open_toolbox: "AI Tools".into(),
            open_history: "History".into(),
            open_settings: "Settings…".into(),
            mic_submenu: "Microphone".into(),
            auto_detect: "Auto-detect".into(),
            auto_detect_with_name: "Auto-detect ({{name}})".into(),
            open_dictionary: "Dictionary".into(),
            check_update: "Check for updates".into(),
            quit: "Quit OpenSpeech".into(),
        }
    }
}

static TRAY_LABELS: Mutex<Option<TrayLabels>> = Mutex::new(None);

fn current_tray_labels() -> TrayLabels {
    TRAY_LABELS
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

#[tauri::command]
fn update_tray_labels(app: tauri::AppHandle, labels: TrayLabels) {
    if let Ok(mut g) = TRAY_LABELS.lock() {
        *g = Some(labels);
    }
    rebuild_tray_menu(&app);
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn get_platform_info() -> serde_json::Value {
    serde_json::json!({
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "family": std::env::consts::FAMILY,
    })
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// 应急清场：强制 drop cpal stream + 关掉残留 stt session。
/// 前端 boot 时调一次兜底"上轮 webview reload / 状态机错乱"导致的 mic 占用泄漏——
/// macOS 状态栏的橙色录音指示灯只在 cpal Stream 还活着时点亮，正常 stop 路径减不到
/// ref_count=0 就关不掉。无副作用：没有遗留时是 no-op。
#[tauri::command]
fn app_emergency_reset() {
    audio::force_stop();
    stt::close_if_active();
}

// 用于权限授权后重启进程：macOS AXIsProcessTrusted 与 AVCaptureDevice
// authorizationStatus 都是 per-process 缓存，用户在系统设置勾选后老进程
// 仍读到 not-granted；必须重启进程才能拿到新值。Tauri 2 的 AppHandle.restart()
// 会 spawn 一个新实例并干净退出当前进程。
#[tauri::command]
fn relaunch_app(app: tauri::AppHandle) {
    app.restart();
}

#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    hide_main_window(&app);
}

#[tauri::command]
fn get_active_app_name_cmd() -> Option<String> {
    active_app::get_active_app_name()
}

#[tauri::command]
fn show_main_window_cmd(app: tauri::AppHandle) {
    show_main_window(&app);
}

// 前端改了 inputDevice（或其他需要体现在托盘菜单的设置）后调用一次，
// Rust 重读 settings.json 并重建菜单，使"选择麦克风"子菜单的 ✓ 实时跟手。
#[tauri::command]
fn tray_refresh(app: tauri::AppHandle) {
    rebuild_tray_menu(&app);
}

// "没有互联网连接"对话框上的"打开系统设置"按钮调用。
// 直接 spawn 系统命令打开网络设置面板——`tauri-plugin-opener` 默认 scope 不允许
// `x-apple.systempreferences:` / `ms-settings:` 这种自定义 scheme，自管更省事。
// 失败只记日志（按钮已经按下了，弹另一个错误对话框打扰更甚）。
// 日志目录：~/Library/Application Support/com.openspeech.app/logs（macOS）
// Windows: %LOCALAPPDATA%\com.openspeech.app\logs；Linux: $XDG_DATA_HOME/com.openspeech.app/logs
// 必须与 tauri_plugin_log 的 Folder target 保持同源，否则按钮打开的目录看不到日志。
fn resolved_log_dir() -> std::path::PathBuf {
    const IDENTIFIER: &str = "com.openspeech.app";

    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
        .join("Library/Application Support");

    #[cfg(target_os = "windows")]
    let base = std::env::var("LOCALAPPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("APPDATA")
                .map(std::path::PathBuf::from)
                .unwrap_or_default()
        });

    #[cfg(target_os = "linux")]
    let base = std::env::var("XDG_DATA_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|h| std::path::PathBuf::from(h).join(".local/share"))
                .unwrap_or_default()
        });

    let dir = base.join(IDENTIFIER).join("logs");
    std::fs::create_dir_all(&dir).ok();
    dir
}

// dev 日志文件名（debug 构建用，覆盖式写入）。
// 不依赖 tauri.dev.conf.json 的 productName——`pnpm tauri dev` 走默认 conf
// 时 productName 仍是 "OpenSpeech"，会和正式版日志混写。
const DEV_LOG_FILE_NAME: &str = "OpenSpeech_dev";

// debug 构建启动时把上一轮 dev 日志删掉，实现"每次启动覆盖"。
// 必须在 tauri_plugin_log 注册之前调用——plugin 注册即打开文件句柄，
// 之后再 remove，macOS 下 fd 仍可写入幽灵 inode。
fn truncate_dev_log_on_start() {
    if !cfg!(debug_assertions) {
        return;
    }
    let path = resolved_log_dir().join(format!("{DEV_LOG_FILE_NAME}.log"));
    if path.exists() {
        if let Err(e) = std::fs::remove_file(&path) {
            eprintln!("[log] truncate dev log failed: {e:?}");
        }
    }
}

// RotationStrategy::KeepAll 不会自删历史，配合 max_file_size=10MB 长期会无限堆。
// 启动时清掉 mtime 超过 7 天的滚动归档（OpenSpeech_<timestamp>.log）；
// 当前正在写的 OpenSpeech.log 文件名不带下划线时间戳，不会被命中。
fn purge_old_log_files() {
    use std::time::{Duration, SystemTime};
    const RETENTION: Duration = Duration::from_secs(7 * 24 * 60 * 60);
    let dir = resolved_log_dir();
    let Some(cutoff) = SystemTime::now().checked_sub(RETENTION) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(name) = path.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // 仅滚动归档：OpenSpeech_<YYYY-MM-DD_HH-MM-SS>.log，剥前缀后首字符是数字。
        // 排除 OpenSpeech_dev.log 这类自定义名字。
        let Some(rest) = name
            .strip_prefix("OpenSpeech_")
            .and_then(|r| r.strip_suffix(".log"))
        else {
            continue;
        };
        if !rest.chars().next().is_some_and(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(modified) = entry.metadata().and_then(|m| m.modified()) else {
            continue;
        };
        if modified < cutoff {
            if let Err(e) = std::fs::remove_file(&path) {
                log::warn!("[log] purge {name} failed: {e:?}");
            } else {
                log::info!("[log] purged old log {name}");
            }
        }
    }
}

// Bug 反馈附带日志：读当前正在写的日志文件尾部，避免反馈 payload 爆掉。
// 200KB 上限够覆盖近一两小时活动，又不会让公开 feedback 端点超时。
const FEEDBACK_LOG_TAIL_BYTES: u64 = 200 * 1024;

#[tauri::command]
fn read_recent_log_tail() -> Result<String, String> {
    use std::io::{Read, Seek, SeekFrom};

    let dir = resolved_log_dir();
    // debug 构建写到 OpenSpeech_dev.log；正式包写到 OpenSpeech.log。
    let file_name = if cfg!(debug_assertions) {
        format!("{DEV_LOG_FILE_NAME}.log")
    } else {
        "OpenSpeech.log".to_string()
    };
    let path = dir.join(&file_name);

    let mut file = std::fs::File::open(&path)
        .map_err(|e| format!("open log file failed ({}): {e}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|e| format!("stat log failed: {e}"))?
        .len();

    let start = len.saturating_sub(FEEDBACK_LOG_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))
        .map_err(|e| format!("seek log failed: {e}"))?;

    let mut buf = Vec::with_capacity((len - start) as usize);
    file.read_to_end(&mut buf)
        .map_err(|e| format!("read log failed: {e}"))?;

    // 从中间字节切下来的可能不是合法 UTF-8 起点，丢掉第一行残片。
    let text = String::from_utf8_lossy(&buf).into_owned();
    let trimmed = if start > 0 {
        match text.find('\n') {
            Some(idx) => text[idx + 1..].to_string(),
            None => text,
        }
    } else {
        text
    };
    Ok(trimmed)
}

#[tauri::command]
fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    let log_dir = resolved_log_dir();
    let path = log_dir
        .to_str()
        .ok_or_else(|| format!("log dir contains non-utf8 chars: {log_dir:?}"))?
        .to_string();

    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("open_path failed: {e:?}"))
}

/// 打开 `app_data_dir/recordings/`（不存在则先创建）。给历史记录页"打开存储
/// 文件夹"按钮用——按日期子目录拆分后，用户从这里翻历史 OGG 最方便。
#[tauri::command]
fn open_recordings_dir(app: tauri::AppHandle) -> Result<(), String> {
    let dir = db::ensure_recordings_dir(&app)?;
    let path = dir
        .to_str()
        .ok_or_else(|| format!("recordings dir contains non-utf8 chars: {dir:?}"))?
        .to_string();

    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("open_path failed: {e:?}"))
}

#[tauri::command]
fn open_network_settings() {
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

// 主窗口可见时把进程切回 Regular（显示 Dock 图标 + 出现在 Cmd+Tab）。
// 与 hide_main_window 切 Accessory 配对：托盘隐藏期间 Dock 图标消失。
#[cfg(target_os = "macos")]
fn apply_dock_icon_policy<R: Runtime>(app: &tauri::AppHandle<R>) {
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

// 从 settings.json (tauri-plugin-store) 读当前选中的麦克风名。
// 空串 / 字段缺失 ⇒ None，代表 "Auto-detect（系统默认设备）"。
fn read_input_device_from_store<R: Runtime>(app: &tauri::AppHandle<R>) -> Option<String> {
    let s = app.store("settings.json").ok()?;
    let root = s.get("root")?;
    let general = root.get("general")?;
    let dev = general.get("inputDevice")?.as_str()?.to_string();
    (!dev.is_empty()).then_some(dev)
}

// 构造托盘右键菜单。每次想刷新（设备插拔 / 用户切换输入设备）都走 rebuild_tray_menu。
// 结构参考 Typeless 托盘：反馈 / 打开主页 / 设置 / 选择麦克风 ▸ / 将词汇添加到词典 /
// 版本 x.y.z（禁用） / 检查更新 / 退出。
fn build_tray_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
    let devices = audio::audio_list_input_devices();
    let current = read_input_device_from_store(app);

    let labels = current_tray_labels();

    let feedback = MenuItemBuilder::with_id("tray::feedback", &labels.feedback).build(app)?;
    let mut home_builder = MenuItemBuilder::with_id("tray::open_home", &labels.open_home);
    if !labels.open_home_accel.is_empty() {
        home_builder = home_builder.accelerator(&labels.open_home_accel);
    }
    let home = home_builder.build(app)?;
    let toolbox =
        MenuItemBuilder::with_id("tray::open_toolbox", &labels.open_toolbox).build(app)?;
    let history =
        MenuItemBuilder::with_id("tray::open_history", &labels.open_history).build(app)?;
    let settings = MenuItemBuilder::with_id("tray::open_settings", &labels.open_settings)
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // Auto-detect 项附系统默认设备名做提示，模板 "Auto-detect ({{name}})" 由前端按当前语言提供。
    let auto_label = match devices
        .iter()
        .find(|d| d.is_default)
        .map(|d| d.name.clone())
    {
        Some(n) => labels.auto_detect_with_name.replace("{{name}}", &n),
        None => labels.auto_detect.clone(),
    };
    let auto_item = CheckMenuItemBuilder::with_id("tray::mic::__auto__", auto_label)
        .checked(current.is_none())
        .build(app)?;

    let mut mic_items: Vec<tauri::menu::CheckMenuItem<R>> = Vec::new();
    for d in &devices {
        let id = format!("tray::mic::{}", d.name);
        let checked = current.as_deref() == Some(d.name.as_str());
        let item = CheckMenuItemBuilder::with_id(id, d.name.clone())
            .checked(checked)
            .build(app)?;
        mic_items.push(item);
    }

    let mut mic_builder = SubmenuBuilder::new(app, &labels.mic_submenu).item(&auto_item);
    if !mic_items.is_empty() {
        mic_builder = mic_builder.item(&PredefinedMenuItem::separator(app)?);
    }
    for it in &mic_items {
        mic_builder = mic_builder.item(it);
    }
    let mic_submenu = mic_builder.build()?;

    let dict =
        MenuItemBuilder::with_id("tray::open_dictionary", &labels.open_dictionary).build(app)?;
    let check_update =
        MenuItemBuilder::with_id("tray::check_update", &labels.check_update).build(app)?;
    let quit = MenuItemBuilder::with_id("tray::quit", &labels.quit)
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    MenuBuilder::new(app)
        .item(&home)
        .item(&toolbox)
        .item(&history)
        .item(&dict)
        .separator()
        .item(&settings)
        .item(&mic_submenu)
        .separator()
        .item(&feedback)
        .item(&check_update)
        .separator()
        .item(&quit)
        .build()
}

fn rebuild_tray_menu<R: Runtime>(app: &tauri::AppHandle<R>) {
    let Some(tray) = app.tray_by_id("main") else {
        return;
    };
    match build_tray_menu(app) {
        Ok(menu) => {
            let _ = tray.set_menu(Some(menu));
        }
        Err(e) => log::warn!("[tray] rebuild menu failed: {e:?}"),
    }
}

// 把进程提到前台并让主窗成为 key window。
// plugin-updater 走 app.restart() 直接 spawn 二进制，不经 LaunchServices/`open`，
// 新进程默认不是 active app，窗口虽然 visible 但落在其他 app 后面，用户感知"最小化"。
#[cfg(target_os = "macos")]
fn activate_macos_app(window: &tauri::WebviewWindow) {
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
#[cfg(target_os = "macos")]
fn disable_macos_fullscreen(window: &tauri::WebviewWindow) {
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    truncate_dev_log_on_start();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Builder::new() 自带默认 targets [Stdout, LogDir]，不清空下面 .target()
                // 会变成追加 → Stdout 出现两次（终端每条日志重复打印）+ LogDir/Folder 同时
                // 落盘到两个目录，open_log_dir 按钮只能看见其中一个。
                .clear_targets()
                // 默认 UseUtc，终端时间会差一个时区，改本地时区。
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                // Debug 整体放开 + 把噪声过大的网络栈拽回 Info；release 维持 Info。
                .level(if cfg!(debug_assertions) {
                    tauri_plugin_log::log::LevelFilter::Debug
                } else {
                    tauri_plugin_log::log::LevelFilter::Info
                })
                .level_for("tungstenite", tauri_plugin_log::log::LevelFilter::Info)
                .level_for(
                    "tokio_tungstenite",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                .level_for("hyper", tauri_plugin_log::log::LevelFilter::Info)
                .level_for("reqwest", tauri_plugin_log::log::LevelFilter::Info)
                .level_for("rustls", tauri_plugin_log::log::LevelFilter::Info)
                .level_for("enigo", tauri_plugin_log::log::LevelFilter::Info)
                // UCKeyTranslate -25340 是非 ASCII 字符落到 Unicode CGEvent fallback，对功能无影响。
                .level_for(
                    "enigo::platform::macos_impl",
                    tauri_plugin_log::log::LevelFilter::Off,
                )
                // symphonia probe 每次 decode WAV 都会刷 "found a possible format marker" /
                // "found the format marker"，跟启动音 / 提示音播放频率成正比。Info 关掉。
                .level_for("symphonia_core", tauri_plugin_log::log::LevelFilter::Info)
                .level_for("symphonia_bundle_mp3", tauri_plugin_log::log::LevelFilter::Info)
                .level_for("symphonia_format_wav", tauri_plugin_log::log::LevelFilter::Info)
                // tao 的 NewEvents/RedrawEventsCleared/MainEventsCleared 在 Windows 下偶发刷屏。
                .level_for("tao", tauri_plugin_log::log::LevelFilter::Info)
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Stdout,
                ))
                // 生产包落盘到 app data 目录下 logs/ 子目录（绝对路径）。
                // 不用 TargetKind::LogDir（macOS = ~/Library/Logs/<id>/）：签名 + Hardened
                // Runtime 的 .app 调 NSWorkspace/`open` 打开此跨容器路径会被 LaunchServices
                // 静默拦掉，"打开日志目录"按钮失效。改写到 ~/Library/Application Support/
                // <id>/logs/，在 app 自己的 data 容器内，打开权限稳定。
                .target(tauri_plugin_log::Target::new(
                    tauri_plugin_log::TargetKind::Folder {
                        path: resolved_log_dir(),
                        // debug 构建固定 "OpenSpeech Dev" 文件名，避免 `pnpm tauri dev`
                        // 走默认 conf 时和正式版日志（OpenSpeech.log）混写。
                        file_name: if cfg!(debug_assertions) {
                            Some(DEV_LOG_FILE_NAME.to_string())
                        } else {
                            None
                        },
                    },
                ))
                .max_file_size(10_000_000)
                .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepAll)
                .build(),
        )
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(
            tauri_plugin_sql::Builder::new()
                .add_migrations(db::DB_URL, db::migrations())
                .build(),
        )
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    hotkey::handler(app, shortcut, event);
                })
                .build(),
        )
        .plugin(tauri_plugin_opener::init());

    // MCP Bridge：dev-only，启 WebSocket :9223 让 Claude Code 等 AI 助手控制 webview。
    #[cfg(debug_assertions)]
    let builder = builder.plugin(
        tauri_plugin_mcp_bridge::Builder::new()
            .bind_address("127.0.0.1")
            .build(),
    );

    // macOS 权限 plugin：暴露 request_microphone_permission /
    // request_accessibility_permission 等命令。crate 本身在 Cargo.toml 是
    // `[target.'cfg(target_os = "macos")'.dependencies]`，Linux / Windows
    // 编译时不存在 → 这里必须用 cfg shadow 重绑，否则 Linux ARM64 等平台报
    // `unresolved module tauri_plugin_macos_permissions`（v0.2.5/0.2.6 CI 即栽于此）。
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_plugin_macos_permissions::init());

    builder
        .manage(hotkey::SharedHotkeyState::default())
        .manage::<openloaf::SharedOpenLoaf>(std::sync::Arc::new(openloaf::OpenLoafState::new()))
        .setup(|app| {
            // ---- 清理超过保留期的滚动日志 ------------------------------------
            purge_old_log_files();

            // ---- 主窗口尺寸自适应屏幕 ----------------------------------------
            // 初始尺寸（tauri.conf.json）是上限值；小屏 / 高 DPI 时按主显示器
            // work area 缩小，留出任务栏和边距。只影响首次启动，用户手动调大小后
            // 由系统记住。
            if let Some(window) = app.get_webview_window("main") {
                // macOS 保留原生 decorations：titleBarStyle:Overlay + hiddenTitle 让红绿灯叠在内容上；
                // Win/Linux 关掉 decorations，由前端 WindowControls 接管。
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.set_decorations(false);
                }
                if let Some(monitor) = window.primary_monitor().ok().flatten() {
                    let scale = monitor.scale_factor();
                    let wa = monitor.work_area();
                    let wa_w = wa.size.width as f64 / scale;
                    let wa_h = wa.size.height as f64 / scale;
                    // 边距：上下左右各留一定空间，避免窗口贴边
                    let pad_x = 80.0;
                    let pad_y = 80.0;
                    let ideal_w = 1060.0_f64.min(wa_w - pad_x);
                    let ideal_h = 740.0_f64.min(wa_h - pad_y);
                    let w = ideal_w.max(800.0);
                    let h = ideal_h.max(600.0);
                    let _ = window.set_size(LogicalSize::new(w, h));
                    let _ = window.center();
                }
            }

            // ---- OpenLoaf 启动自检 + 自动恢复登录 ---------------------------
            // 静态库版本自检 + 若 Keychain 存了 refresh token 则尝试 refresh。
            // 失败（过期/网络）只记日志，不阻断 UI。
            let app_handle_ol = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                openloaf::bootstrap(&app_handle_ol).await;
            });

            // ---- fast_chat_variant 缓存维护 loop -----------------------------
            // 启动后立刻挂上 50min 周期续期；用户登录 / restore 成功的钩子在
            // openloaf 模块内部触发首次 prefetch，配合 1h TTL 保证前台 refine
            // 直接命中缓存，省掉一次串行 RTT。
            ai_refine::spawn_fast_variant_refresh_loop(app.handle().clone());

            // ---- 预创建悬浮录音条窗口（hidden，快捷键触发时 show）-----------
            if let Err(e) = overlay::ensure_overlay(&app.handle()) {
                log::warn!("[overlay] ensure failed: {e:?}");
            }

            // ---- 预热听写提示音子系统 -----------------------------------------
            // spawn cue 线程并打开 cpal 默认输出 stream。冷启动 cpal 设备
            // ~50ms，预热后首次按激活键 mixer.add 就是同步入队，零延迟。
            cue::warm_up();

            // ---- modifier-only state 注册（rdev::listen 暂不启动）----
            // 负责 Fn / Ctrl+Win / Right Alt 等"按住即触发"绑定——
            // tauri-plugin-global-shortcut 不接受这种绑定。依赖 rustdesk-org/rdev
            // fork（见 Cargo.toml）。
            //
            // **启动时机**：setup 阶段只创建空 state，让 apply_bindings 能安全
            // no-op；真正的 rdev::listen 由前端 booted（LoadingScreen 退场、
            // 主窗口完全可见）后通过 `hotkey_init_listener` invoke 触发。
            // 这样 macOS 首次访问全局键盘流触发的「Keystroke Receiving」弹框
            // 不会被随后 show 的主窗口遮挡。
            let mo_state = hotkey::modifier_only::create_state();
            app.manage(mo_state);

            // ---- macOS：启动后保持 Regular（显示 Dock 图标）。
            // 隐藏到托盘时由 hide_main_window 切到 Accessory，show_main_window 切回。
            #[cfg(target_os = "macos")]
            {
                apply_dock_icon_policy(&app.handle());
            }

            // ---- macOS App Menu：接管 Cmd+Q ----------------------------------
            // Tauri 2 在 macOS 下若未自建 App Menu，Cmd+Q 会走 NSApp.terminate:，
            // 实测会绕过 WindowEvent::CloseRequested 与 RunEvent::ExitRequested
            // 直接终止进程。自建菜单把 CmdOrCtrl+Q 绑定到自定义 id="quit_app"，
            // 快捷键就被 menu 系统吃掉，on_menu_event 能稳定收到。
            #[cfg(target_os = "macos")]
            {
                let quit_mi = MenuItemBuilder::with_id("quit_app", "Quit OpenSpeech")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;
                let about_mi = PredefinedMenuItem::about(app, Some("About OpenSpeech"), None)?;
                let hide_mi = PredefinedMenuItem::hide(app, None)?;
                let hide_others_mi = PredefinedMenuItem::hide_others(app, None)?;
                let show_all_mi = PredefinedMenuItem::show_all(app, None)?;
                let sep1 = PredefinedMenuItem::separator(app)?;
                let sep2 = PredefinedMenuItem::separator(app)?;

                let app_submenu = SubmenuBuilder::new(app, "OpenSpeech")
                    .item(&about_mi)
                    .item(&sep1)
                    .item(&hide_mi)
                    .item(&hide_others_mi)
                    .item(&show_all_mi)
                    .item(&sep2)
                    .item(&quit_mi)
                    .build()?;

                // Edit 菜单，让 Cmd+C/V/X/A/Z 正常
                let edit_submenu = SubmenuBuilder::new(app, "Edit")
                    .undo()
                    .redo()
                    .separator()
                    .cut()
                    .copy()
                    .paste()
                    .select_all()
                    .build()?;

                // Window 菜单，Cmd+W 对应标准关闭（会触发 WindowEvent::CloseRequested，我们已拦）
                let window_submenu = SubmenuBuilder::new(app, "Window")
                    .minimize()
                    .close_window()
                    .build()?;

                let menu = MenuBuilder::new(app)
                    .item(&app_submenu)
                    .item(&edit_submenu)
                    .item(&window_submenu)
                    .build()?;

                app.set_menu(menu)?;
                app.on_menu_event(move |app, event| {
                    if event.id().as_ref() == "quit_app" {
                        // Cmd+Q：用户明确退出应用，走独立的 quit-requested 路径，
                        // 与 Cmd+W / 红叉的 close-requested 区分开。
                        let _ = app.emit(QUIT_REQUESTED_EVENT, ());
                    }
                });
            }

            // ---- 系统托盘 ---------------------------------------------------
            // 菜单项详见 build_tray_menu。切换麦克风 / 插拔设备时通过
            // tray_refresh invoke 或 on_menu_event 末尾的重建触发刷新。
            // 托盘图标专用 PNG，独立于 bundle / 窗口图标，便于单独换样。
            let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;
            let initial_menu = build_tray_menu(&app.handle())?;

            TrayIconBuilder::with_id("main")
                .tooltip("OpenSpeech")
                .icon(icon)
                .menu(&initial_menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| {
                    let id = event.id.as_ref();
                    // 麦克风子菜单：id 形如 tray::mic::__auto__ 或 tray::mic::<device-name>。
                    // 前端收到后写 settings.inputDevice，再回调 tray_refresh 刷新 ✓ 标记。
                    if let Some(rest) = id.strip_prefix("tray::mic::") {
                        let device: Option<String> = if rest == "__auto__" {
                            None
                        } else {
                            Some(rest.to_string())
                        };
                        let _ = app.emit(TRAY_SELECT_MIC_EVENT, device);
                        return;
                    }
                    match id {
                        "tray::feedback" => {
                            show_main_window(app);
                            let _ = app.emit(TRAY_OPEN_FEEDBACK_EVENT, ());
                        }
                        "tray::open_home" => {
                            show_main_window(app);
                            let _ = app.emit(TRAY_OPEN_HOME_EVENT, ());
                        }
                        "tray::open_settings" => {
                            show_main_window(app);
                            let _ = app.emit(TRAY_OPEN_SETTINGS_EVENT, ());
                        }
                        "tray::open_dictionary" => {
                            show_main_window(app);
                            let _ = app.emit(TRAY_OPEN_DICTIONARY_EVENT, ());
                        }
                        "tray::open_toolbox" => {
                            show_main_window(app);
                            let _ = app.emit(TRAY_OPEN_TOOLBOX_EVENT, ());
                        }
                        "tray::open_history" => {
                            show_main_window(app);
                            let _ = app.emit(TRAY_OPEN_HISTORY_EVENT, ());
                        }
                        "tray::check_update" => {
                            show_main_window(app);
                            let _ = app.emit(TRAY_CHECK_UPDATE_EVENT, ());
                        }
                        "tray::quit" => {
                            // 托盘明确选"退出"，不走 close-requested 问询流程。
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // ---- 主窗口关闭拦截（包括 Cmd+Q / 红叉 / Alt+F4） ----------------
            // 在 Rust 层 prevent_close 是同步生效的，避免前端 JS 回调的时序竞争。
            // 然后 emit 事件给前端，前端负责弹对话框 / 读取偏好并决定 hide/quit。
            if let Some(window) = app.get_webview_window("main") {
                // macOS：禁用全屏（绿色按钮、双击标题栏、菜单项都失效）。
                #[cfg(target_os = "macos")]
                disable_macos_fullscreen(&window);

                // macOS：plugin-updater app.restart() spawn 出来的新进程默认不是前台
                // app，主窗口会被压在其他窗口之后。setup 末尾 activate 一次让它顶上来。
                #[cfg(target_os = "macos")]
                activate_macos_app(&window);

                let app_handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let WindowEvent::CloseRequested { api, .. } = event {
                        // 红叉 / Cmd+W（Window → Close）走这里；Cmd+Q 走 App Menu 的 quit_app。
                        api.prevent_close();
                        let _ = app_handle.emit(CLOSE_REQUESTED_EVENT, ());
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            get_platform_info,
            exit_app,
            app_emergency_reset,
            relaunch_app,
            hide_to_tray,
            get_active_app_name_cmd,
            show_main_window_cmd,
            tray_refresh,
            update_tray_labels,
            open_network_settings,
            open_log_dir,
            read_recent_log_tail,
            open_recordings_dir,
            hotkey::apply_hotkey_config,
            hotkey::set_hotkey_recording,
            hotkey::hotkey_init_listener,
            hotkey::esc_capture_start,
            hotkey::esc_capture_stop,
            overlay::overlay_show,
            overlay::overlay_hide,
            overlay::overlay_set_height,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            openloaf::openloaf_start_login,
            openloaf::openloaf_cancel_login,
            openloaf::openloaf_logout,
            openloaf::openloaf_current_user,
            openloaf::openloaf_is_authenticated,
            openloaf::openloaf_try_recover,
            openloaf::openloaf_fetch_profile,
            openloaf::openloaf_fetch_realtime_asr_pricing,
            openloaf::openloaf_web_url,
            openloaf::openloaf_health_check,
            openloaf::feedback::openloaf_submit_feedback,
            audio::audio_level_start,
            audio::audio_level_stop,
            audio::audio_list_input_devices,
            audio::audio_recording_start,
            audio::audio_recording_stop,
            audio::audio_recording_cancel,
            audio::audio_recording_load,
            audio::audio_recording_export,
            audio::audio_recording_resolve,
            audio::audio_recording_delete,
            cue::cue_set_enabled,
            cue::cue_set_active,
            cue::cue_play,
            stt::stt_start,
            stt::stt_finalize,
            stt::stt_cancel,
            meetings::meeting_start,
            meetings::meeting_pause,
            meetings::meeting_resume,
            meetings::meeting_stop,
            meetings::meeting_transcript_write,
            meetings::meeting_transcript_load,
            meetings::meeting_transcript_delete,
            meetings::meeting_export_markdown,
            meetings::meeting_summary_write,
            meetings::meeting_summary_load,
            meetings::meeting_summary_delete,
            ai_refine::refine_text_via_chat_stream,
            transcribe::transcribe_recording_file,
            transcribe::transcribe_long_audio_url,
            asr::test_provider::dictation_test_provider,
            inject::inject_paste,
            inject::inject_type,
            permissions::permission_check_microphone,
            permissions::permission_check_accessibility,
            permissions::permission_check_input_monitoring,
            permissions::permission_request_input_monitoring,
            permissions::permission_open_settings,
            permissions::permission_reset_tcc,
            permissions::permission_reset_tcc_one,
            update_channel::get_update_channel,
            update_channel::set_update_channel,
            update_channel::check_for_update,
            idle::system_idle_seconds,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 后备：极端情况下若 Cmd+Q 绕过菜单直达 app 级退出，这里兜住。
            // code.is_none() 代表"用户触发"；code=Some(n) 是我们主动 app.exit(n)，放行。
            match event {
                tauri::RunEvent::ExitRequested { api, code, .. } => {
                    if code.is_none() {
                        api.prevent_exit();
                        let _ = app_handle.emit(CLOSE_REQUESTED_EVENT, ());
                    } else {
                        // 真正放行退出前主动 drop cpal Stream / 关 stt session：
                        // macOS 进程死透时 OS 会回收 audio 资源，但偶发 OS 端 audio
                        // session 还没收到 close 就被强杀，状态栏橙点会卡住。显式
                        // force_stop 走完正常 thread join，让 cpal 把 stream stop
                        // 信号发到 CoreAudio。
                        audio::force_stop();
                        stt::close_if_active();
                    }
                }
                tauri::RunEvent::Exit => {
                    // 真要退出了——再补一刀，覆盖任何绕过 ExitRequested 的退出路径。
                    audio::force_stop();
                    stt::close_if_active();
                }
                _ => {}
            }
        });
}
