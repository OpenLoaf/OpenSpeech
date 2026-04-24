// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// objc 0.2.x 的 msg_send! 宏内部仍在用 cfg(feature = "cargo-clippy")，新 rustc 在
// 宏展开点报 unexpected_cfgs lint。函数级 / mod 级 #[allow] 都覆盖不到展开 token，
// 必须 crate 级 inner attribute 才生效。upstream 不再维护，无法通过升级解决。
#![allow(unexpected_cfgs)]

use tauri::{
    Emitter, Manager, Runtime, WindowEvent,
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

mod audio;
mod db;
mod hotkey;
mod openloaf;
mod overlay;
mod secrets;
mod stt;

// 前端订阅此事件以决定"关闭到后台 / 退出 / 弹对话框"，见 Layout.tsx。
const CLOSE_REQUESTED_EVENT: &str = "openspeech://close-requested";
// 托盘菜单事件：前端在 Layout.tsx 订阅，负责唤出主窗口 + Dialog/Navigate。
const TRAY_OPEN_HOME_EVENT: &str = "openspeech://tray-open-home";
const TRAY_OPEN_SETTINGS_EVENT: &str = "openspeech://tray-open-settings";
const TRAY_OPEN_DICTIONARY_EVENT: &str = "openspeech://tray-open-dictionary";
const TRAY_CHECK_UPDATE_EVENT: &str = "openspeech://tray-check-update";
const TRAY_SELECT_MIC_EVENT: &str = "openspeech://tray-select-mic";
// 反馈入口 MVP 走邮件，未来迁到网站可改常量。
const FEEDBACK_URL: &str = "mailto:feedback@openspeech.app";

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn hide_to_tray(app: tauri::AppHandle) {
    hide_main_window(&app);
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

// 前端在设置页切换"在 Dock 中显示应用"开关后调用，或 bootPromise 启动时调一次。
// Rust 重读 settings.json 的 showDockIcon，立即把 ActivationPolicy 切到相应值。
// 非 macOS 平台上是 no-op（Dock 概念不存在）。
#[tauri::command]
fn sync_dock_icon(_app: tauri::AppHandle) {
    #[cfg(target_os = "macos")]
    {
        apply_dock_icon_policy(&_app);
    }
}

// macOS：启动时读 settings 决定初始 policy；主窗口可见/重新打开时也复用此逻辑。
// 默认 true（显示 Dock 图标）。托盘隐藏路径不经此函数——hide_main_window 始终
// 切 Accessory，隐藏时不需要 Dock 图标。
#[cfg(target_os = "macos")]
fn read_show_dock_icon<R: Runtime>(app: &tauri::AppHandle<R>) -> bool {
    let Some(s) = app.store("settings.json").ok() else {
        return true;
    };
    let Some(root) = s.get("root") else { return true };
    let Some(general) = root.get("general") else {
        return true;
    };
    general
        .get("showDockIcon")
        .and_then(|v| v.as_bool())
        .unwrap_or(true)
}

#[cfg(target_os = "macos")]
fn apply_dock_icon_policy<R: Runtime>(app: &tauri::AppHandle<R>) {
    let policy = if read_show_dock_icon(app) {
        ActivationPolicy::Regular
    } else {
        ActivationPolicy::Accessory
    };
    let _ = app.set_activation_policy(policy);
}

fn hide_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    // macOS：切换到 Accessory 让 Dock 图标消失，应用变为"仅状态栏"。
    #[cfg(target_os = "macos")]
    {
        let _ = app.set_activation_policy(ActivationPolicy::Accessory);
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    // macOS：按用户偏好切换 activation policy——默认 Regular（Dock 显示图标），
    // 若设置里关了 showDockIcon 则切 Accessory（纯菜单栏应用）。前一次隐藏时
    // hide_main_window 已统一切到 Accessory，这里必须再读一次用户设定重新 apply。
    #[cfg(target_os = "macos")]
    {
        apply_dock_icon_policy(app);
    }
    if let Some(window) = app.get_webview_window("main") {
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
    let version = app.package_info().version.to_string();

    let feedback = MenuItemBuilder::with_id("tray::feedback", "反馈意见").build(app)?;
    let home = MenuItemBuilder::with_id("tray::open_home", "打开 OpenSpeech 主页").build(app)?;
    let settings = MenuItemBuilder::with_id("tray::open_settings", "设置...")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    // Auto-detect 项附系统默认设备名做提示（例："Auto-detect (UGREEN CM564 USB Audio)"）。
    let auto_label = match devices.iter().find(|d| d.is_default).map(|d| d.name.clone()) {
        Some(n) => format!("Auto-detect ({})", n),
        None => "Auto-detect".to_string(),
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

    let mut mic_builder = SubmenuBuilder::new(app, "选择麦克风").item(&auto_item);
    if !mic_items.is_empty() {
        mic_builder = mic_builder.item(&PredefinedMenuItem::separator(app)?);
    }
    for it in &mic_items {
        mic_builder = mic_builder.item(it);
    }
    let mic_submenu = mic_builder.build()?;

    let dict = MenuItemBuilder::with_id("tray::open_dictionary", "将词汇添加到词典").build(app)?;
    let version_item = MenuItemBuilder::with_id("tray::version", format!("版本 {version}"))
        .enabled(false)
        .build(app)?;
    let check_update = MenuItemBuilder::with_id("tray::check_update", "检查更新").build(app)?;
    let quit = MenuItemBuilder::with_id("tray::quit", "退出 OpenSpeech")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;

    MenuBuilder::new(app)
        .item(&feedback)
        .item(&home)
        .separator()
        .item(&settings)
        .item(&mic_submenu)
        .item(&dict)
        .separator()
        .item(&version_item)
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
        Err(e) => eprintln!("[tray] rebuild menu failed: {e:?}"),
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
        Err(e) => eprintln!("[window] ns_window() failed: {e:?}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
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
        .plugin(tauri_plugin_opener::init())
        .manage(hotkey::SharedHotkeyState::default())
        .manage::<openloaf::SharedOpenLoaf>(std::sync::Arc::new(openloaf::OpenLoafState::new()))
        .setup(|app| {
            // ---- OpenLoaf 启动自检 + 自动恢复登录 ---------------------------
            // 静态库版本自检 + 若 Keychain 存了 refresh token 则尝试 refresh。
            // 失败（过期/网络）只记日志，不阻断 UI。
            let app_handle_ol = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                openloaf::bootstrap(&app_handle_ol).await;
            });

            // ---- 预创建悬浮录音条窗口（hidden，快捷键触发时 show）-----------
            if let Err(e) = overlay::ensure_overlay(&app.handle()) {
                eprintln!("[overlay] ensure failed: {e:?}");
            }

            // ---- modifier-only 全局键盘订阅（rdev::listen 跑在独立线程）----
            // 负责 Fn / Ctrl+Win / Right Alt 等"按住即触发"绑定——
            // tauri-plugin-global-shortcut 不接受这种绑定。依赖 rustdesk-org/rdev
            // fork（见 Cargo.toml）。首启 macOS 会弹 Accessibility 权限；用户拒绝
            // 时 listen 返回 Err，已在模块内打印并不影响主流程。
            let mo_state = hotkey::modifier_only::init(app.handle().clone());
            app.manage(mo_state);

            // ---- macOS：按 settings.showDockIcon 设置初始 ActivationPolicy ----
            // 默认 true（Regular / 显示 Dock 图标）；用户上次关过则启动后即切 Accessory，
            // 不经过一次 Dock 闪烁。
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
                        // Cmd+Q 被 App Menu 吃住，转成统一的 close-requested 事件。
                        let _ = app.emit(CLOSE_REQUESTED_EVENT, ());
                    }
                });
            }

            // ---- 系统托盘 ---------------------------------------------------
            // 菜单项详见 build_tray_menu。切换麦克风 / 插拔设备时通过
            // tray_refresh invoke 或 on_menu_event 末尾的重建触发刷新。
            let icon = app
                .default_window_icon()
                .expect("missing default window icon")
                .clone();
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
                            let _ = app.opener().open_url(FEEDBACK_URL, None::<&str>);
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
            exit_app,
            hide_to_tray,
            show_main_window_cmd,
            tray_refresh,
            sync_dock_icon,
            hotkey::apply_hotkey_config,
            hotkey::set_hotkey_recording,
            overlay::overlay_show,
            overlay::overlay_hide,
            secrets::secret_set,
            secrets::secret_get,
            secrets::secret_delete,
            openloaf::openloaf_start_login,
            openloaf::openloaf_cancel_login,
            openloaf::openloaf_logout,
            openloaf::openloaf_current_user,
            openloaf::openloaf_is_authenticated,
            openloaf::openloaf_fetch_profile,
            openloaf::openloaf_web_url,
            audio::audio_level_start,
            audio::audio_level_stop,
            audio::audio_list_input_devices,
            audio::audio_recording_start,
            audio::audio_recording_stop,
            audio::audio_recording_cancel,
            audio::audio_recording_load,
            stt::stt_start,
            stt::stt_finalize,
            stt::stt_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 后备：极端情况下若 Cmd+Q 绕过菜单直达 app 级退出，这里兜住。
            // code.is_none() 代表"用户触发"；code=Some(n) 是我们主动 app.exit(n)，放行。
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                    let _ = app_handle.emit(CLOSE_REQUESTED_EVENT, ());
                }
            }
        });
}
