// 文件转写：把已落盘的录音（OGG / WAV）通过 V4 工具接口重新转成文字。
//
// 接口分流（按时长自动选择，与前端 history 重试流程对接）：
// - ≤ 5 分钟 ⇒ `OL-TL-003` (asrShort)：同步 HTTP，base64 直传，秒级返回。
// - > 5 分钟 ⇒ `OL-TL-004` (asrLong)：上游只接受公网 URL，本地音频走不通；
//   暂不支持，返回明确错误让 UI 提示用户。后续若加上传服务再接通查询轮询路径。
//
// 路径安全：复用 audio 模块的统一校验——只接受
// `recordings/<yyyy-MM-dd>/<id>.ogg`（新版）或 `recordings/<id>.{ogg,wav}`
// （老库），拒绝绝对路径 / 多级嵌套 / `..`，防任意文件读取。

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use openloaf_saas::v4_tools::{
    AsrLongOlTl004Input, AsrLongOlTl004Params, AsrLongOlTl004Status, AsrShortOlTl003Input,
    AsrShortOlTl003Params,
};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Manager, Runtime};

use crate::audio;
use crate::db;
use crate::openloaf::{SharedOpenLoaf, handle_session_expired};

const ERR_UNAUTHORIZED: &str = "unauthorized";
const ERR_NOT_AUTHENTICATED: &str = "not authenticated";

fn is_unauthorized(msg: &str) -> bool {
    msg.contains("401") || msg.contains("Unauthorized") || msg.contains("unauthorized")
}

const SHORT_AUDIO_LIMIT_MS: u64 = 5 * 60 * 1000;
const LONG_POLL_INTERVAL_MS: u64 = 4_000;
const LONG_POLL_MAX_TRIES: u32 = 360; // 4s × 360 ≈ 24 min；够覆盖大多数场景，超时让前端报错。

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeFileResult {
    pub text: String,
    /// 实际命中的接口（"asrShort" / "asrLong"）。前端可用于显示来源 / 计费提示。
    pub variant: String,
    pub credits_consumed: f64,
}

fn read_recording_bytes<R: Runtime>(
    app: &AppHandle<R>,
    audio_path: &str,
) -> Result<Vec<u8>, String> {
    let sub = audio::validated_recording_subpath(audio_path)?;
    let abs = db::recordings_dir(app)?.join(sub);
    std::fs::read(&abs).map_err(|e| format!("read {}: {e}", abs.display()))
}

/// 根据 audio_path 后缀决定 base64 上传时的 media_type。
fn media_type_for(audio_path: &str) -> &'static str {
    if audio_path.to_ascii_lowercase().ends_with(".ogg") {
        "audio/ogg"
    } else {
        "audio/wav"
    }
}

fn parse_lang(lang: Option<String>) -> Option<String> {
    let s = lang?.trim().to_ascii_lowercase();
    if s.is_empty() || s == "auto" {
        return None;
    }
    Some(match s.as_str() {
        "zh-cn" | "zh-tw" => "zh".into(),
        x if x.starts_with("en-") => "en".into(),
        _ => s,
    })
}

#[tauri::command]
pub async fn transcribe_recording_file<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    duration_ms: u64,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        transcribe_recording_file_impl(app, audio_path, duration_ms, lang)
    })
    .await
    .map_err(|e| format!("transcribe join: {e}"))?
}

fn transcribe_recording_file_impl<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    duration_ms: u64,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    let lang_param = parse_lang(lang);

    if duration_ms <= SHORT_AUDIO_LIMIT_MS {
        let bytes = read_recording_bytes(&app, &audio_path)?;
        let b64 = B64.encode(&bytes);
        let input = AsrShortOlTl003Input::from_base64(b64, media_type_for(&audio_path));
        let params = AsrShortOlTl003Params {
            language: lang_param,
            enable_itn: None,
        };
        let r = client
            .tools_v4()
            .asr_short_ol_tl_003(&input, &params)
            .map_err(|e| {
                let raw = e.to_string();
                if is_unauthorized(&raw) {
                    handle_session_expired(&app, &ol);
                    ERR_UNAUTHORIZED.to_string()
                } else {
                    format!("asr_short failed: {e}")
                }
            })?;
        Ok(TranscribeFileResult {
            text: r.data.text,
            variant: "asrShort".into(),
            credits_consumed: r.credits_consumed,
        })
    } else {
        // 长音频：服务端只接受公网 URL，本地音频没有可访问的 URL。
        // 给出明确错误让 UI 提示，避免用户以为是转写失败。
        Err(
            "long audio retry needs a public URL; local recording cannot be uploaded yet (>5min)"
                .into(),
        )
    }
}

#[tauri::command]
pub async fn transcribe_long_audio_url<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_long_audio_url_impl(app, url, lang))
        .await
        .map_err(|e| format!("transcribe long join: {e}"))?
}

fn transcribe_long_audio_url_impl<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    let input = AsrLongOlTl004Input::from_url(url);
    let params = AsrLongOlTl004Params {
        language: parse_lang(lang),
        enable_words: Some(false),
        ..Default::default()
    };
    let submitted = client
        .tools_v4()
        .asr_long_ol_tl_004(&input, &params)
        .map_err(|e| {
            let raw = e.to_string();
            if is_unauthorized(&raw) {
                handle_session_expired(&app, &ol);
                ERR_UNAUTHORIZED.to_string()
            } else {
                format!("asr_long submit failed: {e}")
            }
        })?;

    for _ in 0..LONG_POLL_MAX_TRIES {
        thread::sleep(Duration::from_millis(LONG_POLL_INTERVAL_MS));
        let r = client
            .tools_v4()
            .asr_long_ol_tl_004_task(&submitted.task_id)
            .map_err(|e| {
                let raw = e.to_string();
                if is_unauthorized(&raw) {
                    handle_session_expired(&app, &ol);
                    ERR_UNAUTHORIZED.to_string()
                } else {
                    format!("asr_long poll failed: {e}")
                }
            })?;
        match r.status {
            AsrLongOlTl004Status::Succeeded => {
                let data = r.data.unwrap_or_default();
                return Ok(TranscribeFileResult {
                    text: data.text,
                    variant: "asrLong".into(),
                    credits_consumed: r.credits_consumed.unwrap_or(0.0),
                });
            }
            AsrLongOlTl004Status::Failed => {
                let msg = r.error.map(|e| e.message).unwrap_or_default();
                return Err(format!("asr_long failed: {msg}"));
            }
            _ => continue,
        }
    }
    Err("asr_long poll timeout".into())
}
