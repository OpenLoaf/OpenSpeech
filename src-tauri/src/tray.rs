// 系统托盘菜单：标签 i18n 状态（文案由前端按当前语言推过来）+ 菜单构建 / 重建。
// run() setup 里的 TrayIconBuilder 与 on_menu_event/on_tray_icon_event 闭包属装配，
// 留在 lib.rs；这里只提供它依赖的标签状态与 build_tray_menu。

use crate::audio;
use std::sync::Mutex;
use tauri::{
    Runtime,
    menu::{
        CheckMenuItemBuilder, Menu, MenuBuilder, MenuItemBuilder, PredefinedMenuItem,
        SubmenuBuilder,
    },
};
use tauri_plugin_store::StoreExt;

// 托盘菜单文案：Rust 不嵌 i18n，文案完全由前端按当前语言推过来。bootPromise 完成后
// 前端 syncI18nFromSettings 会调用 update_tray_labels 一次；之后切语言再推。空槽位
// 用英文兜底（首次启动 / 前端未来得及推）。
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct TrayLabels {
    pub feedback: String,
    pub open_home: String,
    /// `show_main_window` 当前 binding 的 muda accelerator 字符串（如 "CmdOrCtrl+Shift+O"）。
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
    // 录音中才显示的「停止录音」项；空串 = 用英文兜底。
    #[serde(default)]
    pub stop_recording: String,
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
            stop_recording: "Stop recording".into(),
        }
    }
}

static TRAY_LABELS: Mutex<Option<TrayLabels>> = Mutex::new(None);

// 当前是否正在录音 / 转写：true 时托盘顶部插入「停止录音」项。这是不依赖听写热键
// 的兜底退路——当用户的 Fn 等绑定键被 macOS 系统层吞掉（按 🌐 切输入法 / Emoji /
// Dictation）时，toggle 模式下没有第二次按下就永远停不下来，托盘是唯一保底出口。
static TRAY_RECORDING: Mutex<bool> = Mutex::new(false);

fn tray_recording_active() -> bool {
    TRAY_RECORDING.lock().map(|g| *g).unwrap_or(false)
}

// 前端录音状态机进入 / 离开「正在录音」时各调一次，使「停止录音」项随录音出现 / 消失。
#[tauri::command]
pub(crate) fn tray_set_recording(app: tauri::AppHandle, active: bool) {
    let changed = TRAY_RECORDING
        .lock()
        .map(|mut g| {
            let prev = *g;
            *g = active;
            prev != active
        })
        .unwrap_or(false);
    if changed {
        rebuild_tray_menu(&app);
    }
}

fn current_tray_labels() -> TrayLabels {
    TRAY_LABELS
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub(crate) fn update_tray_labels(app: tauri::AppHandle, labels: TrayLabels) {
    if let Ok(mut g) = TRAY_LABELS.lock() {
        *g = Some(labels);
    }
    rebuild_tray_menu(&app);
}

// 前端改了 inputDevice（或其他需要体现在托盘菜单的设置）后调用一次，
// Rust 重读 settings.json 并重建菜单，使"选择麦克风"子菜单的 ✓ 实时跟手。
#[tauri::command]
pub(crate) fn tray_refresh(app: tauri::AppHandle) {
    rebuild_tray_menu(&app);
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
pub(crate) fn build_tray_menu<R: Runtime>(app: &tauri::AppHandle<R>) -> tauri::Result<Menu<R>> {
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

    let mut builder = MenuBuilder::new(app);
    // 录音中：顶部插入「停止录音」+ 分隔线，让兜底退路第一眼可见。
    if tray_recording_active() {
        let stop = MenuItemBuilder::with_id("tray::stop_recording", &labels.stop_recording)
            .build(app)?;
        builder = builder.item(&stop).separator();
    }
    builder
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

// ---- 托盘图标 ------------------------------------------------------------
// 彩色图（黑描边 + 黄三角）在浅色菜单栏 / 任务栏上很突兀，在深色任务栏上黑描边又几乎看不见。
// 改用单色图：macOS 用模板图交给系统按菜单栏深浅着色；Windows 按任务栏主题选黑 / 白，
// 切主题时后台跟随；Linux 面板多为深色，固定白色。

#[cfg(any(target_os = "macos", target_os = "windows"))]
const TRAY_ICON_BLACK: &[u8] = include_bytes!("../icons/tray-icon-black.png");
#[cfg(not(target_os = "macos"))]
const TRAY_ICON_WHITE: &[u8] = include_bytes!("../icons/tray-icon-white.png");

/// macOS 返回黑色模板图（需配合 `icon_as_template(true)`）；其它平台按当前任务栏主题选。
pub(crate) fn tray_icon_image() -> tauri::Result<tauri::image::Image<'static>> {
    #[cfg(target_os = "macos")]
    let bytes = TRAY_ICON_BLACK;
    #[cfg(target_os = "windows")]
    let bytes = icon_bytes_for_taskbar(windows_taskbar_is_light());
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let bytes = TRAY_ICON_WHITE;
    tauri::image::Image::from_bytes(bytes)
}

#[cfg(target_os = "windows")]
fn icon_bytes_for_taskbar(light: bool) -> &'static [u8] {
    if light {
        TRAY_ICON_BLACK
    } else {
        TRAY_ICON_WHITE
    }
}

/// 读 `SystemUsesLightTheme`（任务栏 / 开始菜单的深浅，区别于应用的 AppsUseLightTheme）。
/// 读不到按深色处理——Win10 / Win11 默认任务栏都是深色。
#[cfg(target_os = "windows")]
fn windows_taskbar_is_light() -> bool {
    use windows_sys::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
    let wide = |s: &str| s.encode_utf16().chain(Some(0)).collect::<Vec<u16>>();
    let key = wide(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize");
    let name = wide("SystemUsesLightTheme");
    let mut value: u32 = 0;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: 所有指针都指向本函数内存活的缓冲区，size 与 value 的大小一致。
    let status = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            key.as_ptr(),
            name.as_ptr(),
            RRF_RT_REG_DWORD,
            std::ptr::null_mut(),
            (&mut value as *mut u32).cast(),
            &mut size,
        )
    };
    status == 0 && value == 1
}

/// Windows：后台每隔几秒读一次任务栏主题，变了就换图标。主题切换没有可靠的
/// 任务栏专属事件（tao 的 ThemeChanged 只看应用主题），读一个注册表 DWORD 的开销可忽略。
#[cfg(target_os = "windows")]
pub(crate) fn spawn_taskbar_theme_watcher<R: Runtime>(app: tauri::AppHandle<R>) {
    const POLL: std::time::Duration = std::time::Duration::from_secs(3);
    std::thread::spawn(move || {
        let mut light = windows_taskbar_is_light();
        loop {
            std::thread::sleep(POLL);
            let now = windows_taskbar_is_light();
            if now == light {
                continue;
            }
            light = now;
            let Some(tray) = app.tray_by_id("main") else {
                continue;
            };
            match tauri::image::Image::from_bytes(icon_bytes_for_taskbar(light)) {
                Ok(icon) => {
                    if let Err(e) = tray.set_icon(Some(icon)) {
                        log::warn!("[tray] set_icon failed: {e}");
                    }
                }
                Err(e) => log::warn!("[tray] decode icon failed: {e}"),
            }
        }
    });
}
