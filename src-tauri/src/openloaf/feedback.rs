// 反馈意见提交。镜像 OpenLoaf-saas Node SDK feedback.submit / Rust SDK feedback 模块的协议
// 直连 `POST /api/public/feedback`（公开端点，匿名/登录都能发）。
//
// 没走 SDK 调用是因为 crates.io 的 openloaf-saas 0.3.2 还没暴露 feedback 模块——
// monorepo 里 sdk-rust 已经有源码（packages/sdk-rust/src/feedback.rs），等下一个
// 版本发布到 crates.io 后把这里换成 `client.feedback().submit(...)` 一行就行。

use std::time::Duration;

use reqwest::multipart::{Form, Part};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Runtime, State};

use super::{DEFAULT_BASE_URL, SharedOpenLoaf, handle_session_expired};

const APP_CLIENT_CODE: &str = "openspeech";
// SaaS feedback `source` 字段是 z.enum(["tenas","openloaf","openloaf-saas"])，
// "openspeech" 走 client 字段而不是 source；source 反映所属生态。
const FEEDBACK_SOURCE: &str = "openloaf-saas";

// 与 SaaS `/api/feedback/upload` 的 MAX_ATTACHMENT_BYTES 对齐——超过这里也没必要发到对端再被 413。
const MAX_AUDIO_BYTES: u64 = 10 * 1024 * 1024;

#[derive(Debug, Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackType {
    Ui,
    Performance,
    Bug,
    Feature,
    Chat,
    Other,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitFeedbackInput {
    pub r#type: FeedbackType,
    pub content: String,
    #[serde(default)]
    pub email: Option<String>,
    /// 前端可附带 OS / 屏幕 / 配置等额外信息。后端只透传到 context 字段。
    #[serde(default)]
    pub context: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitHistoryFeedbackInput {
    pub r#type: FeedbackType,
    pub content: String,
    #[serde(default)]
    pub email: Option<String>,
    /// 必填。前端拼好的 history snapshot / 提示词 / 平台信息 JSON 对象，会与
    /// audio 字段合并写入 feedback.context。
    pub context_extra: serde_json::Value,
    /// 关联的本地 history id。仅落入 context.historyId 作分析定位用。
    pub history_id: String,
    /// 该条 history 的相对录音路径（"recordings/<yyyy-MM-dd>/<id>.{ogg,wav}"）。null = 无录音。
    #[serde(default)]
    pub audio_path: Option<String>,
    /// 用户是否勾选"附带原始录音"。
    #[serde(default)]
    pub include_audio: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SubmitFeedbackBody<'a> {
    source: &'a str,
    r#type: FeedbackType,
    content: &'a str,
    context: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<&'a str>,
    client: &'a str,
    client_version: &'a str,
}

#[tauri::command]
pub async fn openloaf_submit_feedback(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
    payload: SubmitFeedbackInput,
) -> Result<(), String> {
    let content = payload.content.trim().to_string();
    if content.is_empty() {
        return Err("FEEDBACK_EMPTY".into());
    }
    validate_email(payload.email.as_deref())?;

    let context = payload.context.unwrap_or_else(default_context);
    let ol = state.inner().clone();
    submit(
        &app,
        &ol,
        payload.r#type,
        &content,
        payload.email.as_deref(),
        context,
    )
    .await
}

#[derive(Debug, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct SubmitHistoryFeedbackOutput {
    /// 实际是否把音频塞进了 context.audio。前端用来决定 toast 文案。
    audio_included: bool,
    /// 跳过音频时的原因（missing_path / too_large:<bytes> / read:... / stat:...）。
    /// 提交成功但音频被丢的"半成功"情况会带值；不需要时为 None。
    audio_skipped_reason: Option<String>,
}

/// 给"历史记录的某一条"提交反馈：除用户写的意见外，把 history snapshot、提示词、
/// 原始录音（base64）一起打包进 feedback.context，后续可在 SaaS 后台分析模型 / prompt
/// 表现。仅文本类信息走 context_extra（由前端组织），录音由本命令在 Rust 侧 base64
/// 后合并进去，避免 IPC 来回拷一份大数据。
#[tauri::command]
pub async fn openloaf_submit_history_feedback<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, SharedOpenLoaf>,
    payload: SubmitHistoryFeedbackInput,
) -> Result<SubmitHistoryFeedbackOutput, String> {
    let content = payload.content.trim().to_string();
    if content.is_empty() {
        return Err("FEEDBACK_EMPTY".into());
    }
    validate_email(payload.email.as_deref())?;

    let mut context = match payload.context_extra {
        serde_json::Value::Object(_) | serde_json::Value::Null => payload.context_extra,
        _ => return Err("FEEDBACK_INVALID_CONTEXT".into()),
    };
    if context.is_null() {
        context = serde_json::Value::Object(Default::default());
    }

    let obj = context
        .as_object_mut()
        .expect("context normalized to object above");
    obj.insert(
        "historyId".into(),
        serde_json::Value::String(payload.history_id.clone()),
    );
    obj.entry("platform")
        .or_insert_with(|| serde_json::Value::String(std::env::consts::OS.into()));
    obj.entry("arch")
        .or_insert_with(|| serde_json::Value::String(std::env::consts::ARCH.into()));

    let mut out = SubmitHistoryFeedbackOutput::default();
    let ol = state.inner().clone();
    if payload.include_audio {
        match upload_audio_attachment(&app, &ol, payload.audio_path.as_deref()).await {
            Ok(Some(attachment_value)) => {
                obj.insert("audioAttachment".into(), attachment_value);
                out.audio_included = true;
            }
            Ok(None) => {
                let reason = "missing_path".to_string();
                obj.insert(
                    "audioSkipped".into(),
                    serde_json::json!({ "reason": &reason }),
                );
                out.audio_skipped_reason = Some(reason);
            }
            Err(reason) => {
                obj.insert(
                    "audioSkipped".into(),
                    serde_json::json!({ "reason": &reason }),
                );
                out.audio_skipped_reason = Some(reason);
            }
        }
    }

    submit(
        &app,
        &ol,
        payload.r#type,
        &content,
        payload.email.as_deref(),
        context,
    )
    .await?;
    Ok(out)
}

fn validate_email(email: Option<&str>) -> Result<(), String> {
    if let Some(raw) = email {
        let trimmed = raw.trim();
        if !trimmed.is_empty() && !trimmed.contains('@') {
            return Err("FEEDBACK_INVALID_EMAIL".into());
        }
    }
    Ok(())
}

fn default_context() -> serde_json::Value {
    serde_json::json!({
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
    })
}

/// 把一条 history 的录音通过 SaaS `/api/feedback/upload` multipart 上传，返回准备塞
/// 进 feedback.context.audioAttachment 的 JSON。错误 / 文件不存在等都吞回
/// `Err(String)`（reason 落到 context.audioSkipped），不挂掉整次反馈提交。
///
/// 上传需要登录态——未登录时 SaaS 返回 401，这里换成 reason="unauthenticated"。
async fn upload_audio_attachment<R: Runtime>(
    app: &AppHandle<R>,
    ol: &SharedOpenLoaf,
    audio_path: Option<&str>,
) -> Result<Option<serde_json::Value>, String> {
    let Some(rel) = audio_path else {
        return Ok(None);
    };
    let trimmed = rel.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    let sub =
        crate::audio::validated_recording_subpath(trimmed).map_err(|e| format!("invalid:{e}"))?;
    let dir = crate::db::recordings_dir(app).map_err(|e| format!("recordings_dir:{e}"))?;
    let abs = dir.join(sub);
    let meta = std::fs::metadata(&abs).map_err(|e| format!("stat:{e}"))?;
    let size = meta.len();
    if size == 0 {
        return Err("empty_file".into());
    }
    if size > MAX_AUDIO_BYTES {
        return Err(format!("too_large:{size}"));
    }
    let bytes = std::fs::read(&abs).map_err(|e| format!("read:{e}"))?;
    let lower = trimmed.to_ascii_lowercase();
    let (mime, file_name) = if lower.ends_with(".wav") {
        ("audio/wav", "recording.wav")
    } else {
        ("audio/ogg", "recording.ogg")
    };

    let url = format!("{DEFAULT_BASE_URL}/api/feedback/upload");
    let token = ol.client.access_token();
    if token.is_none() {
        return Err("unauthenticated".into());
    }

    let send = |token: Option<String>, bytes: Vec<u8>| -> _ {
        let part = Part::bytes(bytes)
            .file_name(file_name.to_string())
            .mime_str(mime)
            .map_err(|e| format!("mime:{e}"));
        let url = url.clone();
        async move {
            let part = part?;
            let form = Form::new().part("file", part);
            let mut req = crate::http::client()
                .post(&url)
                .timeout(Duration::from_secs(60))
                .multipart(form);
            if let Some(t) = token {
                req = req.bearer_auth(t);
            }
            req.send().await.map_err(network_err)
        }
    };

    let resp = send(token.clone(), bytes.clone()).await?;
    let status = resp.status();
    let resp = if status.as_u16() == 401 {
        if ol.ensure_access_token_fresh().await.is_refreshed() {
            send(ol.client.access_token(), bytes).await?
        } else {
            handle_session_expired(app, ol);
            return Err("unauthenticated".into());
        }
    } else {
        resp
    };

    let status = resp.status();
    if !status.is_success() {
        return Err(format!("upload_http_{}", status.as_u16()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("upload_decode:{e}"))?;
    let attachment_url = body
        .get("url")
        .and_then(|v| v.as_str())
        .ok_or_else(|| "upload_missing_url".to_string())?;
    let key = body.get("key").and_then(|v| v.as_str()).unwrap_or("");

    Ok(Some(serde_json::json!({
        "url": attachment_url,
        "key": key,
        "mime": mime,
        "sizeBytes": size,
        "relativePath": trimmed,
    })))
}

async fn submit<R: Runtime>(
    app: &AppHandle<R>,
    ol: &SharedOpenLoaf,
    r#type: FeedbackType,
    content: &str,
    email: Option<&str>,
    context: serde_json::Value,
) -> Result<(), String> {
    let email_owned = email.map(|s| s.trim().to_string());
    let url = format!("{DEFAULT_BASE_URL}/api/public/feedback");
    let app_version = env!("CARGO_PKG_VERSION");
    let body = SubmitFeedbackBody {
        source: FEEDBACK_SOURCE,
        r#type,
        content,
        context,
        email: email_owned.as_deref().filter(|s| !s.is_empty()),
        client: APP_CLIENT_CODE,
        client_version: app_version,
    };

    let send = |token: Option<String>| {
        let mut req = crate::http::client()
            .post(&url)
            .timeout(Duration::from_secs(30))
            .json(&body);
        if let Some(t) = token {
            req = req.bearer_auth(t);
        }
        req.send()
    };

    let token = ol.client.access_token();
    let resp = send(token.clone()).await.map_err(network_err)?;

    let status = resp.status();
    if status.is_success() {
        return Ok(());
    }

    if status.as_u16() == 401 && token.is_some() {
        if ol.ensure_access_token_fresh().await.is_refreshed() {
            let retry = send(ol.client.access_token()).await.map_err(network_err)?;
            if retry.status().is_success() {
                return Ok(());
            }
            return Err(format_http_err(retry).await);
        }
        handle_session_expired(app, ol);
        return Err("FEEDBACK_AUTH_LOST".into());
    }

    Err(format_http_err(resp).await)
}

fn network_err(e: reqwest::Error) -> String {
    if e.is_timeout() {
        "FEEDBACK_TIMEOUT".into()
    } else if e.is_connect() {
        "FEEDBACK_NETWORK".into()
    } else {
        format!("FEEDBACK_HTTP: {e}")
    }
}

async fn format_http_err(resp: reqwest::Response) -> String {
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    let parsed: Option<serde_json::Value> = serde_json::from_str(&text).ok();
    let message = parsed
        .as_ref()
        .and_then(|v| v.get("message").and_then(|m| m.as_str()))
        .unwrap_or(text.as_str());
    format!("FEEDBACK_HTTP_{status}: {message}")
}
