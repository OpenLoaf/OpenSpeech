use std::fs;

use serde::Serialize;
use tauri::{AppHandle, Manager, ResourceId, Runtime, Webview};
use tauri_plugin_updater::UpdaterExt;

const CHANNEL_FILE: &str = "update-channel";

// 分发链路：上传单写 Cloudflare R2 一份；国内访问由腾讯云 CDN 回源 R2 加速。
// 客户端按运行时 locale 在 CDN / R2 host 之间分流；任一域名挂掉都能回退另一个，最后兜底 GitHub。
// Tauri updater 按数组顺序逐个尝试，第一个 200 命中即用。
const STABLE_R2: &str = "https://openspeech-r2.hexems.com/latest.json";
const STABLE_CDN: &str = "https://openspeech-cdn.hexems.com/latest.json";
const STABLE_GITHUB: &str =
    "https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json";
const BETA_R2: &str = "https://openspeech-r2.hexems.com/latest-beta.json";
const BETA_CDN: &str = "https://openspeech-cdn.hexems.com/latest-beta.json";
const BETA_GITHUB: &str =
    "https://github.com/OpenLoaf/OpenSpeech/releases/download/channel-beta/latest-beta.json";

// plugin-updater 注册时不支持动态 endpoints，conf.json 又是 build-time 写死，
// 所以前端不调 plugin 的 check()，改调本文件的 check_for_update —— 命令内按 channel
// 文件构造 endpoints 后调 updater_builder().endpoints(...) 走 runtime override。
// rid 注册到 webview.resources_table()，与 plugin 的 download/install 命令共用同一表。
//
// 路径走 app.path().app_config_dir() —— 跟随当前 identifier。dev overlay 把
// identifier 改成 com.openspeech.app.dev，update-channel 文件就自然落到 dev 目录，
// 不会污染生产数据。
fn read_channel<R: Runtime>(app: &AppHandle<R>) -> &'static str {
    let Ok(dir) = app.path().app_config_dir() else {
        return "stable";
    };
    match fs::read_to_string(dir.join(CHANNEL_FILE)) {
        Ok(s) if s.trim() == "beta" => "beta",
        _ => "stable",
    }
}

fn write_channel<R: Runtime>(app: &AppHandle<R>, channel: &str) -> std::io::Result<()> {
    let normalized = if channel == "beta" { "beta" } else { "stable" };
    let dir = app.path().app_config_dir().map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::NotFound, format!("config dir: {e}"))
    })?;
    fs::create_dir_all(&dir)?;
    fs::write(dir.join(CHANNEL_FILE), normalized)
}

// 简单按进程 locale 信号判定是否为简体中文用户。
// 不准代价 = 走慢一档（海外用 CDN 也能 hit / CN 用 R2 也能 hit），不会"拿不到"。
// 不引入时区/GeoIP 依赖：updater 这种轻量场景不值当。
fn is_cn_runtime() -> bool {
    for var in ["LC_ALL", "LC_MESSAGES", "LANG", "LANGUAGE"] {
        if let Ok(v) = std::env::var(var) {
            let lc = v.to_ascii_lowercase();
            if lc.starts_with("zh_cn") || lc.starts_with("zh-cn") || lc.contains("hans") {
                return true;
            }
            if lc.starts_with("zh_tw")
                || lc.starts_with("zh-tw")
                || lc.starts_with("zh_hk")
                || lc.starts_with("zh-hk")
                || lc.contains("hant")
            {
                return false;
            }
        }
    }
    false
}

fn endpoints_for(channel: &str) -> Vec<&'static str> {
    let cn = is_cn_runtime();
    match (channel, cn) {
        ("beta", true) => vec![BETA_CDN, BETA_R2, BETA_GITHUB],
        ("beta", false) => vec![BETA_R2, BETA_CDN, BETA_GITHUB],
        (_, true) => vec![STABLE_CDN, STABLE_R2, STABLE_GITHUB],
        (_, false) => vec![STABLE_R2, STABLE_CDN, STABLE_GITHUB],
    }
}

#[tauri::command]
pub fn get_update_channel<R: Runtime>(app: AppHandle<R>) -> String {
    read_channel(&app).to_string()
}

#[tauri::command]
pub fn set_update_channel<R: Runtime>(app: AppHandle<R>, channel: String) -> Result<(), String> {
    write_channel(&app, &channel).map_err(|e| e.to_string())
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

// 当前进程 OS+ARCH 对应的 manifest platforms key（与 release.yml jq 那边的 case 对齐）。
fn current_platform_key() -> &'static str {
    match (std::env::consts::OS, std::env::consts::ARCH) {
        ("macos", "aarch64") => "darwin-aarch64",
        ("macos", "x86_64") => "darwin-x86_64",
        ("linux", "aarch64") => "linux-aarch64",
        ("linux", "x86_64") => "linux-x86_64",
        ("windows", "aarch64") => "windows-aarch64",
        ("windows", "x86_64") => "windows-x86_64",
        _ => "unknown",
    }
}

#[tauri::command]
pub async fn check_for_update<R: Runtime>(
    webview: Webview<R>,
) -> Result<Option<UpdateMetadata>, String> {
    let channel = read_channel(webview.app_handle());
    let endpoint_strs = endpoints_for(channel);
    log::info!(
        target: "openspeech::updater",
        "check_for_update channel={} endpoints={:?}",
        channel, endpoint_strs
    );

    let endpoints: Vec<url::Url> = endpoint_strs
        .into_iter()
        .filter_map(|s| url::Url::parse(s).ok())
        .collect();

    let mut builder = webview.updater_builder();
    if !endpoints.is_empty() {
        builder = builder.endpoints(endpoints).map_err(|e| e.to_string())?;
    }

    let updater = builder.build().map_err(|e| e.to_string())?;
    let update = updater.check().await.map_err(|e| {
        log::warn!(target: "openspeech::updater", "updater.check() failed: {e}");
        e.to_string()
    })?;

    let Some(update) = update else {
        log::info!(target: "openspeech::updater", "no update available");
        return Ok(None);
    };

    let platform_key = current_platform_key();
    let manifest_url = update
        .raw_json
        .get("platforms")
        .and_then(|p| p.get(platform_key))
        .and_then(|p| p.get("url"))
        .and_then(|u| u.as_str())
        .unwrap_or("<missing>");
    log::info!(
        target: "openspeech::updater",
        "update found {} -> {} platform={} install_url={}",
        update.current_version, update.version, platform_key, manifest_url
    );

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
