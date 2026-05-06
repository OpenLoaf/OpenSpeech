// 反馈意见提交。镜像 OpenLoaf-saas Node SDK feedback.submit / Rust SDK feedback 模块的协议
// 直连 `POST /api/public/feedback`（公开端点，匿名/登录都能发）。
//
// 没走 SDK 调用是因为 crates.io 的 openloaf-saas 0.3.2 还没暴露 feedback 模块——
// monorepo 里 sdk-rust 已经有源码（packages/sdk-rust/src/feedback.rs），等下一个
// 版本发布到 crates.io 后把这里换成 `client.feedback().submit(...)` 一行就行。

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::{DEFAULT_BASE_URL, SharedOpenLoaf, handle_session_expired};

const APP_CLIENT_CODE: &str = "openspeech";
// SaaS feedback `source` 字段是 z.enum(["tenas","openloaf","openloaf-saas"])，
// "openspeech" 走 client 字段而不是 source；source 反映所属生态。
const FEEDBACK_SOURCE: &str = "openloaf-saas";

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

    if let Some(email) = payload.email.as_deref() {
        let trimmed = email.trim();
        if !trimmed.is_empty() && !trimmed.contains('@') {
            return Err("FEEDBACK_INVALID_EMAIL".into());
        }
    }

    let ol = state.inner().clone();
    let url = format!("{DEFAULT_BASE_URL}/api/public/feedback");
    let app_version = env!("CARGO_PKG_VERSION");
    let context = payload.context.unwrap_or_else(|| {
        serde_json::json!({
            "platform": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        })
    });

    let email_owned = payload.email.as_ref().map(|s| s.trim().to_string());
    let body = SubmitFeedbackBody {
        source: FEEDBACK_SOURCE,
        r#type: payload.r#type,
        content: &content,
        context,
        email: email_owned.as_deref().filter(|s| !s.is_empty()),
        client: APP_CLIENT_CODE,
        client_version: app_version,
    };

    let send = |token: Option<String>| {
        let mut req = crate::http::client()
            .post(&url)
            .timeout(Duration::from_secs(15))
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
        if ol.ensure_access_token_fresh().await {
            let retry = send(ol.client.access_token())
                .await
                .map_err(network_err)?;
            if retry.status().is_success() {
                return Ok(());
            }
            return Err(format_http_err(retry).await);
        }
        handle_session_expired(&app, &ol);
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
