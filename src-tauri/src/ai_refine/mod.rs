// AI 文本改写：基于 OpenAI 兼容 chat 协议，详见 docs/ai-refine.md。
// saas   : POST <saas_base>/api/v1/chat/completions（OpenLoaf 兼容 OpenAI 协议端点），
//          body 仍需带 `variant: <variant.id>`，key = SDK access_token，model = variant.id
// custom : POST <custom_base>/chat/completions（OpenAI 协议惯例），key 走 keyring
//
// 不走 async-openai 的 chat client：它把 path 写死成 `/chat/completions`，跟 SaaS 的
// `/api/ai/v3/text/chat` 完整端点冲突；reqwest 直发 + 自解 SSE 更可控。仍用
// async-openai 的 `CreateChatCompletionStreamResponse` 类型解析 OpenAI 标准帧。
//
// messages 拼装：system → optional context user message（HotWords / ConversationHistory /
// MessageContext 三段，任一非空就拼）→ 实际 user_text。
// body 默认带 `temperature: 0`、`enable_thinking: false`、`stream_options.include_usage: true`。

use async_openai::types::chat::CreateChatCompletionStreamResponse;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::openloaf::{DEFAULT_BASE_URL, SharedOpenLoaf, handle_session_expired};
use crate::secrets;

const EVENT_DELTA: &str = "openspeech://ai-refine:delta";
const EVENT_DONE: &str = "openspeech://ai-refine:done";
const EVENT_ERROR: &str = "openspeech://ai-refine:error";

const ERR_NOT_AUTHENTICATED: &str = "not authenticated";
const ERR_NO_FAST_VARIANT: &str = "no_fast_chat_variant";
const ERR_MISSING_CUSTOM: &str = "missing_custom_provider";
const ERR_MISSING_API_KEY: &str = "missing_api_key";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineChatInput {
    pub mode: String,
    pub system_prompt: String,
    pub user_text: String,
    #[serde(default)]
    pub hotwords: Option<Vec<String>>,
    #[serde(default)]
    pub history_entries: Option<Vec<String>>,
    #[serde(default)]
    pub request_time: Option<String>,
    #[serde(default)]
    pub custom_base_url: Option<String>,
    #[serde(default)]
    pub custom_model: Option<String>,
    #[serde(default)]
    pub custom_keyring_id: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefineChatResult {
    pub refined_text: String,
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DeltaPayload {
    task_id: Option<String>,
    chunk: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct DonePayload {
    task_id: Option<String>,
    refined_text: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ErrorPayload {
    task_id: Option<String>,
    code: String,
    message: String,
}

struct ResolvedEndpoint {
    full_url: String,
    api_key: String,
    model: String,
    variant_id: Option<String>,
}

fn join_base_endpoint(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = endpoint.trim_start_matches('/');
    format!("{base}/{path}")
}

async fn resolve_saas<R: Runtime>(app: &AppHandle<R>) -> Result<ResolvedEndpoint, String> {
    let (client, token) = {
        let ol = app.state::<SharedOpenLoaf>();
        let client = ol.authenticated_client().ok_or_else(|| {
            handle_session_expired(app, &ol);
            ERR_NOT_AUTHENTICATED.to_string()
        })?;
        let token = client.access_token().ok_or_else(|| {
            handle_session_expired(app, &ol);
            ERR_NOT_AUTHENTICATED.to_string()
        })?;
        (client, token)
    };
    let variant = tokio::task::spawn_blocking(move || client.ai().fast_chat_variant())
        .await
        .map_err(|e| format!("join: {e}"))?
        .map_err(|e| format!("fast_chat_variant: {e}"))?
        .ok_or_else(|| ERR_NO_FAST_VARIANT.to_string())?;
    Ok(ResolvedEndpoint {
        full_url: join_base_endpoint(DEFAULT_BASE_URL, "/api/v1/chat/completions"),
        api_key: token,
        model: variant.id.clone(),
        variant_id: Some(variant.id),
    })
}

fn resolve_custom(input: &RefineChatInput) -> Result<ResolvedEndpoint, String> {
    let base = input
        .custom_base_url
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ERR_MISSING_CUSTOM.to_string())?
        .to_string();
    let model = input
        .custom_model
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ERR_MISSING_CUSTOM.to_string())?
        .to_string();
    let keyring_id = input
        .custom_keyring_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ERR_MISSING_CUSTOM.to_string())?
        .to_string();
    let api_key = secrets::secret_get(keyring_id)
        .map_err(|e| format!("keyring read failed: {e}"))?
        .ok_or_else(|| ERR_MISSING_API_KEY.to_string())?;
    let full_url = format!(
        "{}/chat/completions",
        base.trim_end_matches('/').trim_end_matches("/chat/completions")
    );
    Ok(ResolvedEndpoint {
        full_url,
        api_key,
        model,
        variant_id: None,
    })
}

/// 拼第一条 context user message。三段全空时返回 None；任一段非空就拼整条。
pub fn build_context_message(
    hotwords: Option<&[String]>,
    history_entries: Option<&[String]>,
    request_time: Option<&str>,
) -> Option<String> {
    let hot = hotwords
        .map(|hs| {
            hs.iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let hist = history_entries
        .map(|hs| {
            hs.iter()
                .map(|s| s.trim())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let req_time = request_time.map(str::trim).filter(|s| !s.is_empty());
    if hot.is_empty() && hist.is_empty() && req_time.is_none() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if !hot.is_empty() {
        parts.push(format!(
            "<system-tag type=\"HotWords\">\n\t{}\n</system-tag>",
            hot.join("、")
        ));
    }
    if !hist.is_empty() {
        parts.push(format!(
            "<system-tag type=\"ConversationHistory\">\n\t{}\n</system-tag>",
            hist.join("\n\n\t")
        ));
    }
    if let Some(t) = req_time {
        parts.push(format!(
            "<system-tag type=\"MessageContext\">\n\trequestTime: {t}\n</system-tag>"
        ));
    }
    Some(parts.join("\n\n"))
}

fn build_messages(
    system_prompt: &str,
    hotwords: Option<&[String]>,
    history_entries: Option<&[String]>,
    request_time: Option<&str>,
    user_text: &str,
) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    if !system_prompt.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system_prompt }));
    }
    if let Some(ctx) = build_context_message(hotwords, history_entries, request_time) {
        messages.push(json!({ "role": "user", "content": ctx }));
    }
    messages.push(json!({ "role": "user", "content": user_text }));
    messages
}

#[tauri::command]
pub async fn refine_text_via_chat_stream<R: Runtime>(
    app: AppHandle<R>,
    input: RefineChatInput,
) -> Result<RefineChatResult, String> {
    let task_id = input.task_id.clone();
    log::info!(
        "[ai_refine] enter command mode={} text_len={} hotwords={} history={} task_id={:?}",
        input.mode,
        input.user_text.chars().count(),
        input.hotwords.as_ref().map(|v| v.len()).unwrap_or(0),
        input.history_entries.as_ref().map(|v| v.len()).unwrap_or(0),
        task_id,
    );
    let resolved = match input.mode.as_str() {
        "saas" => match resolve_saas(&app).await {
            Ok(r) => r,
            Err(code) => {
                emit_error(&app, task_id.as_deref(), &code, &code);
                return Err(code);
            }
        },
        "custom" => match resolve_custom(&input) {
            Ok(r) => r,
            Err(code) => {
                emit_error(&app, task_id.as_deref(), &code, &code);
                return Err(code);
            }
        },
        other => {
            let msg = format!("unknown mode: {other}");
            emit_error(&app, task_id.as_deref(), "unknown_mode", &msg);
            return Err(msg);
        }
    };

    let messages = build_messages(
        &input.system_prompt,
        input.hotwords.as_deref(),
        input.history_entries.as_deref(),
        input.request_time.as_deref(),
        &input.user_text,
    );

    let mut body = json!({
        "model": resolved.model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
        "temperature": 0,
        "enable_thinking": false,
    });
    if let Some(vid) = resolved.variant_id.as_ref() {
        body["variant"] = Value::String(vid.clone());
    }

    #[cfg(debug_assertions)]
    {
        let pretty = serde_json::to_string_pretty(&body)
            .unwrap_or_else(|_| body.to_string());
        log::info!(
            "[ai_refine] dispatch mode={} url={} model={}{} task_id={:?}\n[ai_refine] request body:\n{}",
            input.mode,
            resolved.full_url,
            resolved.model,
            resolved
                .variant_id
                .as_ref()
                .map(|v| format!(" variant={v}"))
                .unwrap_or_default(),
            task_id,
            pretty,
        );
    }

    let http = match reqwest::Client::builder().build() {
        Ok(c) => c,
        Err(e) => {
            let msg = format!("reqwest build: {e}");
            emit_error(&app, task_id.as_deref(), "network", &msg);
            return Err(msg);
        }
    };

    let resp = match http
        .post(&resolved.full_url)
        .bearer_auth(&resolved.api_key)
        .json(&body)
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            let raw = e.to_string();
            let code = classify_reqwest_error(&raw);
            emit_error(&app, task_id.as_deref(), code, &raw);
            return Err(format!("ai_refine_send: {raw}"));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        let raw = format!("HTTP {status}: {txt}");
        let code = classify_status(status.as_u16());
        emit_error(&app, task_id.as_deref(), code, &raw);
        return Err(raw);
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                let raw = e.to_string();
                let code = classify_reqwest_error(&raw);
                emit_error(&app, task_id.as_deref(), code, &raw);
                return Err(format!("ai_refine_stream: {raw}"));
            }
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        loop {
            let Some(nl) = buf.find('\n') else { break };
            let line = buf[..nl].trim_end_matches('\r').to_string();
            buf.drain(..=nl);
            let Some(rest) = line.strip_prefix("data:") else {
                continue;
            };
            let payload = rest.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            // SaaS 末尾会发非标元数据帧（如 {"x_credits_consumed":0.04}），无 "choices"
            // 字段；按 OpenAI 协议丢弃，不告警。
            let v: Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if !v.is_object() || !v.as_object().unwrap().contains_key("choices") {
                continue;
            }
            let parsed: CreateChatCompletionStreamResponse = match serde_json::from_value(v) {
                Ok(r) => r,
                Err(_) => continue,
            };
            for choice in parsed.choices {
                if let Some(content) = choice.delta.content {
                    if !content.is_empty() {
                        full.push_str(&content);
                        let _ = app.emit(
                            EVENT_DELTA,
                            DeltaPayload {
                                task_id: task_id.clone(),
                                chunk: content,
                            },
                        );
                    }
                }
            }
        }
    }

    log::info!(
        "[ai_refine] done mode={} chars={} task_id={:?} text={:?}",
        input.mode,
        full.chars().count(),
        task_id,
        full,
    );

    let _ = app.emit(
        EVENT_DONE,
        DonePayload {
            task_id: task_id.clone(),
            refined_text: full.clone(),
        },
    );

    Ok(RefineChatResult {
        refined_text: full,
        task_id,
    })
}

fn classify_reqwest_error(raw: &str) -> &'static str {
    let lower = raw.to_lowercase();
    if lower.contains("401") || lower.contains("unauthorized") {
        "unauthorized"
    } else if lower.contains("403") || lower.contains("forbidden") {
        "forbidden"
    } else if lower.contains("404") {
        "model_not_found"
    } else if lower.contains("429") || lower.contains("quota") || lower.contains("rate limit") {
        "quota_exceeded"
    } else if lower.contains("timeout") || lower.contains("timed out") {
        "timeout"
    } else {
        "network"
    }
}

fn classify_status(status: u16) -> &'static str {
    match status {
        401 => "unauthorized",
        403 => "forbidden",
        404 => "model_not_found",
        429 => "quota_exceeded",
        408 | 504 => "timeout",
        _ => "network",
    }
}

fn emit_error<R: Runtime>(
    app: &AppHandle<R>,
    task_id: Option<&str>,
    code: &str,
    message: &str,
) {
    let _ = app.emit(
        EVENT_ERROR,
        ErrorPayload {
            task_id: task_id.map(|s| s.to_string()),
            code: code.to_string(),
            message: message.to_string(),
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn context_none_when_all_empty() {
        assert_eq!(build_context_message(None, None, None), None);
        assert_eq!(
            build_context_message(Some(&[]), Some(&[]), Some("")),
            None
        );
    }

    #[test]
    fn context_hotwords_only() {
        let hw = vec!["OpenSpeech".to_string(), "OpenLoaf".to_string()];
        let got = build_context_message(Some(&hw), None, None).unwrap();
        let want = "<system-tag type=\"HotWords\">\n\tOpenSpeech、OpenLoaf\n</system-tag>";
        assert_eq!(got, want);
    }

    #[test]
    fn context_full_three_sections() {
        let hw = vec!["OpenSpeech".to_string(), "OpenLoaf".to_string()];
        let hist = vec![
            "[8 分钟前] 首页有个布局的 bug 修复一下。".to_string(),
            "[7 分钟前] 我需要 Markdown 格式，我在哪里可以直接复制？或者你给我一个文件的路径，我直接从文件里面复制。".to_string(),
            "[2 分钟前] 这个 dialog 打开的时候应该是 diff 的那种形式，每一行有什么不一样。".to_string(),
        ];
        let req = "2026-05-01T08:08:28.551Z (UTC)";
        let got = build_context_message(Some(&hw), Some(&hist), Some(req)).unwrap();
        let want = "<system-tag type=\"HotWords\">\n\tOpenSpeech、OpenLoaf\n</system-tag>\n\n<system-tag type=\"ConversationHistory\">\n\t[8 分钟前] 首页有个布局的 bug 修复一下。\n\n\t[7 分钟前] 我需要 Markdown 格式，我在哪里可以直接复制？或者你给我一个文件的路径，我直接从文件里面复制。\n\n\t[2 分钟前] 这个 dialog 打开的时候应该是 diff 的那种形式，每一行有什么不一样。\n</system-tag>\n\n<system-tag type=\"MessageContext\">\n\trequestTime: 2026-05-01T08:08:28.551Z (UTC)\n</system-tag>";
        assert_eq!(got, want);
    }

    #[test]
    fn build_messages_two_user_messages() {
        let hw = vec!["OpenSpeech".to_string()];
        let msgs = build_messages(
            "you are a polish bot",
            Some(&hw),
            None,
            None,
            "现成的组件呢？找一下现成组件，尽量不要自己写。",
        );
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert!(msgs[1]["content"]
            .as_str()
            .unwrap()
            .contains("HotWords"));
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(
            msgs[2]["content"].as_str().unwrap(),
            "现成的组件呢？找一下现成组件，尽量不要自己写。"
        );
    }

    #[test]
    fn build_messages_skips_system_when_empty() {
        let msgs = build_messages("", None, None, None, "hi");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }
}
