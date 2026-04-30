use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;

const CHANNEL_FILE: &str = "update-channel";
const APP_IDENTIFIER: &str = "com.openspeech.app";

// COS 国内分发（主）+ GitHub 兜底。Tauri updater 按数组顺序逐个尝试，第一个 200 命中即用，
// 所以 COS 全挂时会回退到 GitHub Release，用户至少还能升级。
const STABLE_COS: &str =
    "https://openspeech-1329813561.cos.accelerate.myqcloud.com/latest.json";
const STABLE_GITHUB: &str =
    "https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json";
const BETA_COS: &str =
    "https://openspeech-1329813561.cos.accelerate.myqcloud.com/latest-beta.json";
const BETA_GITHUB: &str =
    "https://github.com/OpenLoaf/OpenSpeech/releases/download/channel-beta/latest-beta.json";

// plugin-updater 注册时不支持动态 endpoints，conf.json 又是 build-time 写死，
// 所以前端不调 plugin 的 check()，改调本文件的 check_for_update —— 命令内按 channel
// 文件构造 endpoints 后调 updater_builder().endpoints(...) 走 runtime override。
// rid 注册到 webview.resources_table()，与 plugin 的 download/install 命令共用同一表。
fn app_config_dir() -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        return std::env::var_os("HOME").map(|h| {
            PathBuf::from(h)
                .join("Library/Application Support")
                .join(APP_IDENTIFIER)
        });
    }
    #[cfg(target_os = "linux")]
    {
        if let Some(v) = std::env::var_os("XDG_CONFIG_HOME") {
            return Some(PathBuf::from(v).join(APP_IDENTIFIER));
        }
        return std::env::var_os("HOME")
            .map(|h| PathBuf::from(h).join(".config").join(APP_IDENTIFIER));
    }
    #[cfg(target_os = "windows")]
    {
        return std::env::var_os("APPDATA").map(|p| PathBuf::from(p).join(APP_IDENTIFIER));
    }
    #[allow(unreachable_code)]
    None
}

fn read_channel() -> &'static str {
    let Some(dir) = app_config_dir() else {
        return "stable";
    };
    match fs::read_to_string(dir.join(CHANNEL_FILE)) {
        Ok(s) if s.trim() == "beta" => "beta",
        _ => "stable",
    }
}

fn write_channel(channel: &str) -> std::io::Result<()> {
    let normalized = if channel == "beta" { "beta" } else { "stable" };
    let dir = app_config_dir().ok_or_else(|| {
        std::io::Error::new(std::io::ErrorKind::NotFound, "config dir not found")
    })?;
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(CHANNEL_FILE), normalized)
}

fn endpoints_for(channel: &str) -> Vec<&'static str> {
    match channel {
        "beta" => vec![BETA_COS, BETA_GITHUB],
        _ => vec![STABLE_COS, STABLE_GITHUB],
    }
}

#[tauri::command]
pub fn get_update_channel() -> String {
    read_channel().to_string()
}

#[tauri::command]
pub fn set_update_channel(channel: String) -> Result<(), String> {
    write_channel(&channel).map_err(|e| e.to_string())
}

// 与 plugin-updater commands.rs 的 Metadata 字段保持一致——前端 new Update(metadata)
// 需要这套字段（rid + currentVersion / version / date / body / rawJson）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateMetadata {
    rid: ResourceId,
    current_version: String,
    version: String,
    date: Option<String>,
    body: Option<String>,
    raw_json: serde_json::Value,
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<UpdateMetadata>, String> {
    let channel = read_channel();
    let endpoints: Vec<url::Url> = endpoints_for(channel)
        .into_iter()
        .filter_map(|s| url::Url::parse(s).ok())
        .collect();

    let mut builder = webview.updater_builder();
    if !endpoints.is_empty() {
        builder = builder.endpoints(endpoints).map_err(|e| e.to_string())?;
    }

    let updater = builder.build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| e.to_string())?;

    let Some(update) = update else {
        return Ok(None);
    };

    // 前端 Update.date 仅展示用、且我们目前 toast 里没用到。OffsetDateTime 的 RFC3339
    // 格式化要拉 `time` crate，没必要——直接置 None。
    let metadata = UpdateMetadata {
        current_version: update.current_version.clone(),
        version: update.version.clone(),
        date: None,
        body: update.body.clone(),
        raw_json: update.raw_json.clone(),
        rid: webview.resources_table().add(update),
    };
    Ok(Some(metadata))
}
