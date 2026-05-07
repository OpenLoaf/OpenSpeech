// AI 文本改写：基于 OpenAI 兼容 chat 协议，详见 docs/ai-refine.md。
// saas   : POST <saas_base>/api/v1/chat/completions（OpenLoaf 兼容 OpenAI 协议端点），
//          body 仍需带 `variant: <variant.id>`，key = SDK access_token，model = variant.id
// custom : POST <custom_base>/chat/completions（OpenAI 协议惯例），key 走 keyring
//
// 不走 async-openai 的 chat client：它把 path 写死成 `/chat/completions`，跟 SaaS 的
// `/api/ai/v3/text/chat` 完整端点冲突；reqwest 直发 + 自解 SSE 更可控。仍用
// async-openai 的 `CreateChatCompletionStreamResponse` 类型解析 OpenAI 标准帧。
//
// messages 拼装：system → optional context user message（Domains / HotWords / ConversationHistory /
// MessageContext / TargetApp 五段，任一非空就拼）→ 实际 user_text。
// Domains 是用户在词典页"常见领域"勾选的领域显示名（最多 3 个），让模型按这些专业领域
// 调术语和措辞密度。TargetApp 是当前键盘注入的目标程序名（如 "微信" / "iTerm2"），让模型
// 按目标场景调风格（聊天 / 命令行 / 邮件…）；OpenSpeech 自身和空名在 Rust 侧过滤掉。
// body 默认带 `temperature: 0`、`enable_thinking: false`、`stream_options.include_usage: true`。

use async_openai::types::chat::CreateChatCompletionStreamResponse;
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::openloaf::{
    DEFAULT_BASE_URL, RefreshOutcome, SharedOpenLoaf, handle_session_expired,
};
use crate::secrets;

const EVENT_DELTA: &str = "openspeech://ai-refine:delta";
const EVENT_DONE: &str = "openspeech://ai-refine:done";
const EVENT_ERROR: &str = "openspeech://ai-refine:error";

const ERR_NOT_AUTHENTICATED: &str = "not authenticated";
/// SaaS 不可达（网络断开 / 服务器宕机 / 5xx）。**保留登录态**，前端只展示网络错误提示。
const ERR_NETWORK_UNAVAILABLE: &str = "network_unavailable";
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
    pub target_app: Option<String>,
    #[serde(default)]
    pub domains: Option<Vec<String>>,
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
    /// 实际发送给 LLM 的请求快照（URL / model / body）pretty JSON。
    /// 给 dev / 调试用，前端按 env 决定是否落到 history.debug_payload。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_envelope: Option<String>,
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

pub(crate) struct ResolvedEndpoint {
    pub(crate) full_url: String,
    pub(crate) api_key: String,
    pub(crate) model: String,
    pub(crate) variant_id: Option<String>,
}

fn join_base_endpoint(base_url: &str, endpoint: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let path = endpoint.trim_start_matches('/');
    format!("{base}/{path}")
}

// fast_chat_variant 是服务端配置的"全局唯一快速 chat 模型"，长期稳定。
// 进程内 TTL 缓存避免每次 refine 都额外打一次 GET。clear_session（logout / 401 / refresh
// 失败兜底）会调 invalidate 把缓存清掉，避免跨账号 / 跨 membership tier 串。
// 只缓存 variant.id —— SDK 没把 V3Variant 类型 re-export 出来，且当前路径只用到 id。
// TTL 1h 兜底；refresh loop 每 50 min 主动续，留 10 min 安全垫，让前台始终命中。
const FAST_VARIANT_TTL: Duration = Duration::from_secs(60 * 60);
const FAST_VARIANT_REFRESH_INTERVAL: Duration = Duration::from_secs(50 * 60);

fn fast_variant_cache() -> &'static Mutex<Option<(String, Instant)>> {
    static CACHE: OnceLock<Mutex<Option<(String, Instant)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn cached_fast_variant_id() -> Option<String> {
    let guard = fast_variant_cache().lock().ok()?;
    guard
        .as_ref()
        .filter(|(_, fetched)| fetched.elapsed() < FAST_VARIANT_TTL)
        .map(|(id, _)| id.clone())
}

fn store_fast_variant_id(id: &str) {
    if let Ok(mut guard) = fast_variant_cache().lock() {
        *guard = Some((id.to_string(), Instant::now()));
    }
}

pub fn invalidate_fast_variant_cache() {
    if let Ok(mut guard) = fast_variant_cache().lock() {
        *guard = None;
    }
}

/// 主动拉一次 fast_chat_variant 写缓存。失败只 warn，不抛错——给三类调用方共用：
/// 登录 / restore 成功后、refresh loop tick、chat 失败后台续。
pub async fn prefetch_fast_variant<R: Runtime>(app: &AppHandle<R>) {
    let ol: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();
    if !ol.ensure_access_token_fresh().await.is_refreshed() {
        log::debug!("[ai_refine] prefetch skipped: token not fresh / not authenticated");
        return;
    }
    let Some(client) = ol.authenticated_client() else {
        log::debug!("[ai_refine] prefetch skipped: no authenticated client");
        return;
    };
    match tokio::task::spawn_blocking(move || client.ai().fast_chat_variant()).await {
        Ok(Ok(Some(v))) => {
            log::info!("[ai_refine] prefetched fast_chat_variant id={}", v.id);
            store_fast_variant_id(&v.id);
        }
        Ok(Ok(None)) => {
            log::warn!("[ai_refine] prefetch: server returned no fast variant");
        }
        Ok(Err(e)) => {
            log::warn!("[ai_refine] prefetch fast_chat_variant failed: {e}");
        }
        Err(e) => {
            log::warn!("[ai_refine] prefetch join error: {e}");
        }
    }
}

/// lib.rs setup 调一次，每 50 min 主动续一次缓存。
/// 未登录跳过本轮，等下次 tick 再试——不需要监听登录事件。
pub fn spawn_fast_variant_refresh_loop<R: Runtime + 'static>(app: AppHandle<R>) {
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(FAST_VARIANT_REFRESH_INTERVAL).await;
            let logged_in = app
                .try_state::<SharedOpenLoaf>()
                .and_then(|s| s.inner().authenticated_client())
                .is_some();
            if !logged_in {
                log::debug!("[ai_refine] refresh tick skipped: not authenticated");
                continue;
            }
            prefetch_fast_variant(&app).await;
        }
    });
}

/// chat 失败兜底：清缓存 + 后台拉一次新 variant，不阻塞错误返回路径。
/// 后续服务端会返回多个 variant 做服务降级，先把刷新链路打通。
fn refresh_fast_variant_in_background<R: Runtime + 'static>(app: AppHandle<R>) {
    invalidate_fast_variant_cache();
    tauri::async_runtime::spawn(async move {
        prefetch_fast_variant(&app).await;
    });
}

pub(crate) async fn resolve_saas<R: Runtime>(
    app: &AppHandle<R>,
) -> Result<ResolvedEndpoint, String> {
    let ol: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();
    // 请求前预检：JWT 距离过期 ≤ 30s 时主动 refresh，避免拿过期 token 起飞导致 401。
    // 唤醒场景特别关键：电脑睡眠期间 refresh 定时器没机会跑，醒来第一次调用如果不预检
    // 就一定 401，前端会把它当登录失效踢用户。
    match ol.ensure_access_token_fresh().await {
        RefreshOutcome::Refreshed => {}
        RefreshOutcome::AuthLost => {
            log::warn!("[ai_refine] saas preflight rejected by server; signaling auth-lost");
            handle_session_expired(app, &ol);
            return Err(ERR_NOT_AUTHENTICATED.to_string());
        }
        RefreshOutcome::Network => {
            log::warn!(
                "[ai_refine] saas preflight network/5xx; keeping session, returning network error"
            );
            return Err(ERR_NETWORK_UNAVAILABLE.to_string());
        }
    }
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;
    let token = client.access_token().ok_or_else(|| {
        handle_session_expired(app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;
    let variant_id = if let Some(id) = cached_fast_variant_id() {
        log::debug!("[ai_refine] fast_chat_variant cache hit id={id}");
        id
    } else {
        let v = tokio::task::spawn_blocking(move || client.ai().fast_chat_variant())
            .await
            .map_err(|e| format!("join: {e}"))?
            .map_err(|e| format!("fast_chat_variant: {e}"))?
            .ok_or_else(|| ERR_NO_FAST_VARIANT.to_string())?;
        store_fast_variant_id(&v.id);
        v.id
    };
    Ok(ResolvedEndpoint {
        full_url: join_base_endpoint(DEFAULT_BASE_URL, "/api/v1/chat/completions"),
        api_key: token,
        model: variant_id.clone(),
        variant_id: Some(variant_id),
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

/// OpenSpeech 自身被识别为前台时不该把它当成 TargetApp（用户实际是在自己的 app 里
/// 复述给主面板看，无目标场景），统一返回 None。
fn sanitize_target_app(raw: Option<&str>) -> Option<String> {
    let s = raw?.trim();
    if s.is_empty() {
        return None;
    }
    let lower = s.to_lowercase();
    if lower == "openspeech" || lower == "open speech" {
        return None;
    }
    Some(s.to_string())
}

/// 用户勾选的领域：去空、去重，截到上限 3 个。同 UI 侧 DOMAIN_LIMIT 保持一致。
const DOMAINS_PROMPT_LIMIT: usize = 3;
fn sanitize_domains(raw: Option<&[String]>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    if let Some(list) = raw {
        for s in list {
            let t = s.trim();
            if t.is_empty() {
                continue;
            }
            if seen.iter().any(|x| x == t) {
                continue;
            }
            seen.push(t.to_string());
            if seen.len() >= DOMAINS_PROMPT_LIMIT {
                break;
            }
        }
    }
    seen
}

/// 拼第一条 context user message。五段全空时返回 None；任一段非空就拼整条。
/// 顺序：Domains（最前，给后续段提供领域偏向）→ HotWords → ConversationHistory →
/// MessageContext → TargetApp。
pub fn build_context_message(
    domains: Option<&[String]>,
    hotwords: Option<&[String]>,
    history_entries: Option<&[String]>,
    request_time: Option<&str>,
    target_app: Option<&str>,
) -> Option<String> {
    let dom = sanitize_domains(domains);
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
    let app = sanitize_target_app(target_app);
    if dom.is_empty() && hot.is_empty() && hist.is_empty() && req_time.is_none() && app.is_none() {
        return None;
    }
    let mut parts: Vec<String> = Vec::new();
    if !dom.is_empty() {
        parts.push(format!(
            "<system-tag type=\"Domains\">\n\t{}\n</system-tag>",
            dom.join("、")
        ));
    }
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
    if let Some(name) = app {
        parts.push(format!(
            "<system-tag type=\"TargetApp\">\n\tname: {name}\n</system-tag>"
        ));
    }
    Some(parts.join("\n\n"))
}

fn build_messages(
    system_prompt: &str,
    domains: Option<&[String]>,
    hotwords: Option<&[String]>,
    history_entries: Option<&[String]>,
    request_time: Option<&str>,
    target_app: Option<&str>,
    user_text: &str,
) -> Vec<Value> {
    let mut messages: Vec<Value> = Vec::new();
    if !system_prompt.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system_prompt }));
    }
    if let Some(ctx) =
        build_context_message(domains, hotwords, history_entries, request_time, target_app)
    {
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
        input.domains.as_deref(),
        input.hotwords.as_deref(),
        input.history_entries.as_deref(),
        input.request_time.as_deref(),
        input.target_app.as_deref(),
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

    log::info!(
        "[ai_refine] dispatch mode={} url={} model={}{} task_id={:?}",
        input.mode,
        resolved.full_url,
        resolved.model,
        resolved
            .variant_id
            .as_ref()
            .map(|v| format!(" variant={v}"))
            .unwrap_or_default(),
        task_id,
    );
    let envelope = json!({
        "mode": input.mode,
        "url": resolved.full_url,
        "model": resolved.model,
        "variantId": resolved.variant_id,
        "body": body,
    });
    let request_envelope = serde_json::to_string_pretty(&envelope).ok();
    if log::log_enabled!(log::Level::Trace) {
        if let Some(ref s) = request_envelope {
            log::trace!("[ai_refine] request body:\n{}", s);
        }
    }

    let mut current_key = resolved.api_key.clone();
    let mut attempt: u32 = 0;
    let resp = loop {
        attempt += 1;
        let send_result = crate::http::client()
            .post(&resolved.full_url)
            .bearer_auth(&current_key)
            .json(&body)
            .send()
            .await;
        let resp = match send_result {
            Ok(r) => r,
            Err(e) => {
                let raw = e.to_string();
                let code = classify_reqwest_error(&raw);
                emit_error(&app, task_id.as_deref(), code, &raw);
                if input.mode == "saas" {
                    refresh_fast_variant_in_background(app.clone());
                }
                return Err(format!("ai_refine_send: {raw}"));
            }
        };

        let status = resp.status();
        if status.is_success() {
            break resp;
        }

        let txt = resp.text().await.unwrap_or_default();
        let raw = format!("HTTP {status}: {txt}");
        let code = classify_status(status.as_u16());

        // SaaS 路径 401：先尝试 refresh + retry 一次；refresh 失败 / retry 仍 401 才清场。
        // BYOK custom 路径 401：是用户自己的 provider key 错，与 OpenLoaf 登录无关，不清场。
        // 错误返回值用稳定串前缀 `unauthorized:`/`saas_unauthorized:`，前端按 mode 路由。
        if status.as_u16() == 401 && input.mode == "saas" && attempt == 1 {
            log::warn!(
                "[ai_refine] saas chat got 401 on attempt 1, attempting refresh + retry. raw={raw}"
            );
            let ol = app.state::<SharedOpenLoaf>().inner().clone();
            match ol.ensure_fresh_token().await {
                RefreshOutcome::Refreshed => {
                    if let Some(new_token) = ol.client_clone().access_token() {
                        current_key = new_token;
                        log::info!("[ai_refine] refresh succeeded, retrying chat completion once");
                        continue;
                    }
                    log::warn!(
                        "[ai_refine] refresh succeeded but access_token gone; clearing session"
                    );
                    handle_session_expired(&app, &ol);
                    emit_error(&app, task_id.as_deref(), code, &raw);
                    return Err(format!("saas_unauthorized: {raw}"));
                }
                RefreshOutcome::AuthLost => {
                    log::warn!("[ai_refine] refresh rejected; clearing session");
                    handle_session_expired(&app, &ol);
                    emit_error(&app, task_id.as_deref(), code, &raw);
                    return Err(format!("saas_unauthorized: {raw}"));
                }
                RefreshOutcome::Network => {
                    log::warn!(
                        "[ai_refine] refresh network/5xx; keeping session, returning network error"
                    );
                    emit_error(&app, task_id.as_deref(), code, &raw);
                    return Err(ERR_NETWORK_UNAVAILABLE.to_string());
                }
            }
        }

        emit_error(&app, task_id.as_deref(), code, &raw);
        if status.as_u16() == 401 {
            return if input.mode == "saas" {
                let ol = app.state::<SharedOpenLoaf>().inner().clone();
                log::warn!(
                    "[ai_refine] saas chat retry still 401 after refresh; clearing session. raw={raw}"
                );
                handle_session_expired(&app, &ol);
                Err(format!("saas_unauthorized: {raw}"))
            } else {
                Err(format!("custom_unauthorized: {raw}"))
            };
        }
        if input.mode == "saas" {
            refresh_fast_variant_in_background(app.clone());
        }
        return Err(raw);
    };

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
                if input.mode == "saas" {
                    refresh_fast_variant_in_background(app.clone());
                }
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
        request_envelope,
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
        assert_eq!(build_context_message(None, None, None, None, None), None);
        assert_eq!(
            build_context_message(Some(&[]), Some(&[]), Some(&[]), Some(""), Some("")),
            None
        );
    }

    #[test]
    fn context_hotwords_only() {
        let hw = vec!["OpenSpeech".to_string(), "OpenLoaf".to_string()];
        let got = build_context_message(None, Some(&hw), None, None, None).unwrap();
        let want = "<system-tag type=\"HotWords\">\n\tOpenSpeech、OpenLoaf\n</system-tag>";
        assert_eq!(got, want);
    }

    #[test]
    fn context_target_app_only() {
        let got = build_context_message(None, None, None, None, Some("微信")).unwrap();
        let want = "<system-tag type=\"TargetApp\">\n\tname: 微信\n</system-tag>";
        assert_eq!(got, want);
    }

    #[test]
    fn context_target_app_filters_self_and_blank() {
        assert_eq!(
            build_context_message(None, None, None, None, Some("OpenSpeech")),
            None
        );
        assert_eq!(
            build_context_message(None, None, None, None, Some("openspeech")),
            None
        );
        assert_eq!(
            build_context_message(None, None, None, None, Some("Open Speech")),
            None
        );
        assert_eq!(
            build_context_message(None, None, None, None, Some("   ")),
            None
        );
    }

    #[test]
    fn context_domains_only() {
        let dom = vec!["软件开发".to_string(), "AI / 机器学习".to_string()];
        let got = build_context_message(Some(&dom), None, None, None, None).unwrap();
        let want = "<system-tag type=\"Domains\">\n\t软件开发、AI / 机器学习\n</system-tag>";
        assert_eq!(got, want);
    }

    #[test]
    fn context_domains_dedup_trim_and_cap() {
        // 重复、首尾空白、超过上限 3 个 → 去重 + trim + 截断
        let dom = vec![
            "  软件开发 ".to_string(),
            "软件开发".to_string(),
            "".to_string(),
            "医学健康".to_string(),
            "金融投资".to_string(),
            "心理学".to_string(), // 第 4 个，应被丢
        ];
        let got = build_context_message(Some(&dom), None, None, None, None).unwrap();
        let want = "<system-tag type=\"Domains\">\n\t软件开发、医学健康、金融投资\n</system-tag>";
        assert_eq!(got, want);
    }

    #[test]
    fn context_full_five_sections_domains_first() {
        let dom = vec!["软件开发".to_string()];
        let hw = vec!["OpenSpeech".to_string(), "OpenLoaf".to_string()];
        let hist = vec![
            "[8 分钟前] 首页有个布局的 bug 修复一下。".to_string(),
            "[7 分钟前] 我需要 Markdown 格式，我在哪里可以直接复制？或者你给我一个文件的路径，我直接从文件里面复制。".to_string(),
            "[2 分钟前] 这个 dialog 打开的时候应该是 diff 的那种形式，每一行有什么不一样。".to_string(),
        ];
        let req = "2026-05-01T08:08:28.551Z (UTC)";
        let got = build_context_message(Some(&dom), Some(&hw), Some(&hist), Some(req), Some("微信"))
            .unwrap();
        let want = "<system-tag type=\"Domains\">\n\t软件开发\n</system-tag>\n\n<system-tag type=\"HotWords\">\n\tOpenSpeech、OpenLoaf\n</system-tag>\n\n<system-tag type=\"ConversationHistory\">\n\t[8 分钟前] 首页有个布局的 bug 修复一下。\n\n\t[7 分钟前] 我需要 Markdown 格式，我在哪里可以直接复制？或者你给我一个文件的路径，我直接从文件里面复制。\n\n\t[2 分钟前] 这个 dialog 打开的时候应该是 diff 的那种形式，每一行有什么不一样。\n</system-tag>\n\n<system-tag type=\"MessageContext\">\n\trequestTime: 2026-05-01T08:08:28.551Z (UTC)\n</system-tag>\n\n<system-tag type=\"TargetApp\">\n\tname: 微信\n</system-tag>";
        assert_eq!(got, want);
    }

    #[test]
    fn build_messages_two_user_messages() {
        let hw = vec!["OpenSpeech".to_string()];
        let msgs = build_messages(
            "you are a polish bot",
            None,
            Some(&hw),
            None,
            None,
            None,
            "现成的组件呢？找一下现成组件，尽量不要自己写。",
        );
        assert_eq!(msgs.len(), 3);
        assert_eq!(msgs[0]["role"], "system");
        assert_eq!(msgs[1]["role"], "user");
        assert!(msgs[1]["content"].as_str().unwrap().contains("HotWords"));
        assert_eq!(msgs[2]["role"], "user");
        assert_eq!(
            msgs[2]["content"].as_str().unwrap(),
            "现成的组件呢？找一下现成组件，尽量不要自己写。"
        );
    }

    #[test]
    fn build_messages_with_target_app() {
        let msgs = build_messages(
            "polish",
            None,
            None,
            None,
            None,
            Some("iTerm2"),
            "删 src 斜杠 utils 目录",
        );
        assert_eq!(msgs.len(), 3);
        let ctx = msgs[1]["content"].as_str().unwrap();
        assert!(ctx.contains("TargetApp"));
        assert!(ctx.contains("name: iTerm2"));
    }

    #[test]
    fn build_messages_with_domains() {
        let dom = vec!["软件开发".to_string(), "AI / 机器学习".to_string()];
        let msgs = build_messages(
            "polish",
            Some(&dom),
            None,
            None,
            None,
            None,
            "在做 RAG 检索召回",
        );
        assert_eq!(msgs.len(), 3);
        let ctx = msgs[1]["content"].as_str().unwrap();
        assert!(ctx.contains("Domains"));
        assert!(ctx.contains("软件开发、AI / 机器学习"));
    }

    #[test]
    fn build_messages_skips_system_when_empty() {
        let msgs = build_messages("", None, None, None, None, None, "hi");
        assert_eq!(msgs.len(), 1);
        assert_eq!(msgs[0]["role"], "user");
    }
}
