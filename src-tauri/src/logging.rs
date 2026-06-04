// 日志文件生命周期：落盘目录解析、dev 覆盖式写入、版本归档、7 天清理，以及
// 反馈附带日志读尾 / 打开日志目录两个命令。tauri_plugin_log 的注册在 lib.rs run()，
// 这里只提供它依赖的纯函数与路径常量。

// 日志目录：~/Library/Application Support/com.openspeech.app/logs（macOS）
// Windows: %LOCALAPPDATA%\com.openspeech.app\logs；Linux: $XDG_DATA_HOME/com.openspeech.app/logs
// 必须与 tauri_plugin_log 的 Folder target 保持同源，否则"打开日志目录"按钮看不到日志。
pub(crate) fn resolved_log_dir() -> std::path::PathBuf {
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
pub(crate) const DEV_LOG_FILE_NAME: &str = "OpenSpeech_dev";

// 是否走"调试日志"档位：debug 构建本身，或 release 构建里的 prerelease
// （语义版本带连字符：0.2.37-beta.1 / -rc.x / -alpha.x）。
// beta 包发给早期用户，出问题需要 Debug 级日志+落盘归档辅助排查，所以和 dev 同档。
// 正式版（不带 -）仍走 Info，避免普通用户机器堆几百 MB 噪声日志。
pub(crate) fn is_debug_log_build() -> bool {
    cfg!(debug_assertions) || env!("CARGO_PKG_VERSION").contains('-')
}

// 用户在设置里开了 beta 渠道（即便当前还装着正式版）即视为愿意回收诊断日志 → 开 Debug。
// 真源 = update_channel.rs 经 app_config_dir 写的 update-channel；log 插件注册时 app handle
// 尚不可用，只能裸读。路径须用 config 语义（非 resolved_log_dir 的 data 语义：Win=Roaming
// APPDATA 而非 LOCALAPPDATA、Linux=.config 而非 .local/share），否则读不到 beta 用户的文件。
pub(crate) fn beta_channel_opted_in() -> bool {
    const IDENTIFIER: &str = "com.openspeech.app";

    #[cfg(target_os = "macos")]
    let base = std::env::var("HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_default()
        .join("Library/Application Support");

    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA")
        .map(std::path::PathBuf::from)
        .unwrap_or_default();

    #[cfg(target_os = "linux")]
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            std::env::var("HOME")
                .map(|h| std::path::PathBuf::from(h).join(".config"))
                .unwrap_or_default()
        });

    matches!(
        std::fs::read_to_string(base.join(IDENTIFIER).join("update-channel")),
        Ok(s) if s.trim() == "beta"
    )
}

// debug 构建启动时把上一轮 dev 日志删掉，实现"每次启动覆盖"。
// 必须在 tauri_plugin_log 注册之前调用——plugin 注册即打开文件句柄，
// 之后再 remove，macOS 下 fd 仍可写入幽灵 inode。
pub(crate) fn truncate_dev_log_on_start() {
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

// 记录上次启动写入日志时的版本号，用来判断是否需要按版本切档。
const LOG_VERSION_MARKER: &str = ".log_version";

// release 包启动时若发现版本号变了，把当前 OpenSpeech.log 归档为
// OpenSpeech_<epoch>_v<old_version>.log，新版本从空文件开始写。
// 这样升级 / 回滚 / beta 互切都能在日志里一眼分段，排查不会被混在一条文件里。
// 归档名首字符是 epoch 数字，会被 purge_old_log_files 7 天后自动清理，无需另写淘汰逻辑。
// dev 构建走 truncate_dev_log_on_start，不参与本流程。
// 必须在 tauri_plugin_log 注册之前调用——plugin 一旦持有 fd，rename 后 macOS 下仍会写幽灵 inode。
pub(crate) fn archive_log_on_version_change() {
    if cfg!(debug_assertions) {
        return;
    }
    let dir = resolved_log_dir();
    let marker = dir.join(LOG_VERSION_MARKER);
    let current = env!("CARGO_PKG_VERSION");
    let previous = std::fs::read_to_string(&marker)
        .ok()
        .map(|s| s.trim().to_string());

    if previous.as_deref() == Some(current) {
        return;
    }

    let active = dir.join("OpenSpeech.log");
    if active.exists() {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let old_tag = previous.as_deref().unwrap_or("unknown");
        let archived = dir.join(format!("OpenSpeech_{secs}_v{old_tag}.log"));
        if let Err(e) = std::fs::rename(&active, &archived) {
            eprintln!("[log] archive on version change failed: {e:?}");
            return;
        }
    }

    if let Err(e) = std::fs::write(&marker, current) {
        eprintln!("[log] write {LOG_VERSION_MARKER} failed: {e:?}");
    }
}

// RotationStrategy::KeepAll 不会自删历史，配合 max_file_size=10MB 长期会无限堆。
// 启动时清掉 mtime 超过 7 天的归档（tauri 滚动归档 OpenSpeech_<timestamp>.log
// 与 archive_log_on_version_change 写出的 OpenSpeech_<epoch>_v<ver>.log 都覆盖）。
// 当前正在写的 OpenSpeech.log 文件名不带下划线时间戳，不会被命中。
pub(crate) fn purge_old_log_files() {
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
pub(crate) fn read_recent_log_tail() -> Result<String, String> {
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
pub(crate) fn open_log_dir(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    let log_dir = resolved_log_dir();
    let path = log_dir
        .to_str()
        .ok_or_else(|| format!("log dir contains non-utf8 chars: {log_dir:?}"))?
        .to_string();

    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| format!("open_path failed: {e:?}"))
}
