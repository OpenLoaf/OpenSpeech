// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/

// objc 0.2.x 的 msg_send! 宏内部仍在用 cfg(feature = "cargo-clippy")，新 rustc 在
// 宏展开点报 unexpected_cfgs lint。函数级 / mod 级 #[allow] 都覆盖不到展开 token，
// 必须 crate 级 inner attribute 才生效。upstream 不再维护，无法通过升级解决。
#![allow(unexpected_cfgs)]

use tauri::{
    Emitter, Manager, WindowEvent,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
// 菜单构建器现仅 macOS App Menu 使用（托盘菜单已搬入 tray.rs）。
#[cfg(target_os = "macos")]
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};

mod active_app;
mod ai_refine;
pub mod asr;
mod audio;
mod commands;
mod cue;
mod db;
mod dictionary_agent;
mod events;
mod focus_check;
mod hotkey;
mod http;
mod idle;
mod ime;
mod inject;
mod logging;
#[cfg(target_os = "macos")]
mod mac_main_thread;
#[cfg(target_os = "macos")]
mod macos_native;
mod meetings;
mod openloaf;
mod overlay;
mod permissions;
mod quick_panel;
pub mod secrets;
mod stt;
mod text_normalize;
mod transcribe;
mod transcribe_refine;
mod tray;
mod update_channel;
mod window;

use events::*;
use logging::{
    DEV_LOG_FILE_NAME, archive_log_on_version_change, beta_channel_opted_in, is_debug_log_build,
    purge_old_log_files, resolved_log_dir, truncate_dev_log_on_start,
};
#[cfg(target_os = "macos")]
use macos_native::{activate_macos_app, disable_app_nap, disable_macos_fullscreen};
// show_main_window / toggle_main_window 经此 re-export 保持 crate::show_main_window
// 与 crate::toggle_main_window 路径不变（openloaf/callback、hotkey 跨模块引用）。
use tray::build_tray_menu;
#[cfg(target_os = "macos")]
use window::apply_dock_icon_policy;
pub(crate) use window::{show_main_window, toggle_main_window};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    truncate_dev_log_on_start();
    archive_log_on_version_change();

    let builder = tauri::Builder::default()
        // 单实例守卫：必须第一个注册才能在窗口创建前拦截。第二个实例启动会被掐掉，
        // 其入参通过此回调转发给已运行实例，这里把主窗拉到前台让用户感知到。
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            show_main_window(app);
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                // Builder::new() 自带默认 targets [Stdout, LogDir]，不清空下面 .target()
                // 会变成追加 → Stdout 出现两次（终端每条日志重复打印）+ LogDir/Folder 同时
                // 落盘到两个目录，open_log_dir 按钮只能看见其中一个。
                .clear_targets()
                // 默认 UseUtc，终端时间会差一个时区，改本地时区。
                .timezone_strategy(tauri_plugin_log::TimezoneStrategy::UseLocal)
                // Debug 整体放开 + 把噪声过大的网络栈拽回 Info；正式版维持 Info。
                // beta 包 + 开了 beta 渠道开关的正式版用户都走 Debug，方便回收用户日志。
                .level(if is_debug_log_build() || beta_channel_opted_in() {
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
                .level_for(
                    "symphonia_bundle_mp3",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
                .level_for(
                    "symphonia_format_wav",
                    tauri_plugin_log::log::LevelFilter::Info,
                )
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
        // modifier-only state 必须在 setup 之前 manage：apply_hotkey_config 是 async invoke，
        // webview 一加载完就被 Tokio 调度执行，会和 setup 同步代码并发。如果延后到 setup 内部
        // 再 manage，前端首次 apply_bindings 时 try_state 拿不到 → 整个会话 PTT / 翻译键全失活，
        // 用户必须退出重进才能恢复（实测 0.2.47 一次启动复现）。
        .manage(hotkey::modifier_only::create_state())
        .manage::<openloaf::SharedOpenLoaf>(std::sync::Arc::new(openloaf::OpenLoafState::new()))
        .setup(|app| {
            // ---- 禁用 macOS App Nap（必须尽早）-------------------------------
            #[cfg(target_os = "macos")]
            disable_app_nap();

            // ---- 清理超过保留期的滚动日志 ------------------------------------
            purge_old_log_files();

            // ---- 主窗口尺寸自适应屏幕 ----------------------------------------
            // 初始尺寸（tauri.conf.json）是上限值；小屏 / 高 DPI 时按主显示器
            // work area 缩小，留出任务栏和边距。每次创建主窗口时只设置一次，
            // 之后不干预用户手动调整。
            if let Some(window) = app.get_webview_window("main") {
                // macOS 保留原生 decorations：titleBarStyle:Overlay + hiddenTitle 让红绿灯叠在内容上；
                // Win/Linux 关掉 decorations，由前端 WindowControls 接管。
                #[cfg(not(target_os = "macos"))]
                {
                    let _ = window.set_decorations(false);
                }
                window::fit_main_window_to_primary_monitor(&window);
            }

            // ---- 输入设备列表 warmup ----------------------------------------
            // cpal::input_devices() 在 macOS 上偶发卡 3-10s（蓝牙休眠 / coreaudiod
            // 抖动 / 虚拟声卡）。挂在前端 preflight 的关键路径上会让 PTT 卡死后
            // 触发 race。启动期间后台预热一次，之后前端 preflight 永远走 cache
            // （微秒级）。
            std::thread::Builder::new()
                .name("openspeech-device-warmup".into())
                .spawn(|| {
                    audio::warmup_input_device_cache();
                })
                .ok();

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

            // ---- 预创建 quick panel 窗口（hidden）---------------------------
            // 通用快速操作面板：编辑上一条 / 后续翻译 / 问答 等都共用此窗，按 mode 切换内部视图。
            if let Err(e) = quick_panel::ensure(&app.handle()) {
                log::warn!("[quick-panel] ensure failed: {e:?}");
            }

            // ---- 预热听写提示音子系统 -----------------------------------------
            // spawn cue 线程并打开 cpal 默认输出 stream。冷启动 cpal 设备
            // ~50ms，预热后首次按激活键 mixer.add 就是同步入队，零延迟。
            cue::warm_up();

            // ---- modifier-only：rdev::listen 真正启动由前端 booted 后通过
            // `hotkey_init_listener` invoke 触发——macOS 首次访问全局键盘流会弹
            // 「Keystroke Receiving」授权框，这样能叠在主窗口之上而不被遮挡。
            // 空 state 已经在 builder.manage 阶段注册（见上方 .manage(create_state())
            // 调用）：apply_hotkey_config 是 async invoke 会和 setup 并发，延后到这里
            // manage 来不及。

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
                        "tray::stop_recording" => {
                            // 兜底退路：不唤出主窗、不依赖听写热键，直接让前端 FSM 结束录音。
                            let _ = app.emit(TRAY_STOP_RECORDING_EVENT, ());
                        }
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
            commands::greet,
            commands::get_platform_info,
            commands::get_saas_sdk_version,
            commands::exit_app,
            commands::app_emergency_reset,
            commands::relaunch_app,
            window::hide_to_tray,
            commands::get_active_window_info_cmd,
            focus_check::focus_is_editable_cmd,
            ime::active_ime_id_cmd,
            window::show_main_window_cmd,
            tray::tray_refresh,
            tray::update_tray_labels,
            tray::tray_set_recording,
            commands::fn_usage_type,
            commands::open_network_settings,
            logging::open_log_dir,
            logging::read_recent_log_tail,
            commands::open_recordings_dir,
            hotkey::apply_hotkey_config,
            hotkey::set_hotkey_recording,
            hotkey::hotkey_init_listener,
            hotkey::esc_capture_start,
            hotkey::esc_capture_stop,
            overlay::overlay_show,
            overlay::overlay_hide,
            overlay::overlay_set_height,
            quick_panel::quick_panel_show,
            quick_panel::quick_panel_hide,
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
            openloaf::feedback::openloaf_submit_history_feedback,
            audio::audio_level_start,
            audio::audio_level_stop,
            audio::audio_list_input_devices,
            audio::adopt_dictation_capture,
            audio::release_dictation_capture,
            audio::set_dictation_capture_enabled,
            audio::audio_recording_start,
            audio::audio_recording_stop,
            audio::audio_recording_cancel,
            audio::audio_recording_load,
            audio::audio_recording_export,
            audio::audio_recording_resolve,
            audio::audio_recording_delete,
            cue::cue_set_enabled,
            cue::cue_set_active,
            cue::cue_reset_active,
            cue::cue_diagnose_and_test,
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
            meetings::meeting_translation_append,
            meetings::meeting_export_markdown,
            meetings::meeting_summary_write,
            meetings::meeting_summary_load,
            meetings::meeting_summary_delete,
            meetings::meeting_scan_orphans,
            ai_refine::refine_text_via_chat_stream,
            dictionary_agent::analyze_dictionary_correction,
            dictionary_agent::extract_dictionary_terms,
            transcribe::transcribe_recording_file,
            transcribe::transcribe_long_audio_url,
            transcribe_refine::transcribe_and_refine,
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
