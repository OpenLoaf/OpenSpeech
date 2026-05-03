//! prompt-eval skill 的 refine runner。
//!
//! 输入：
//!   --system-file <path>  system prompt 全文
//!   --user-file   <path>  user message 正文（即 ASR transcript）
//! 可选：
//!   --context-file <path> 第一条 user message（HotWords / History / MessageContext 等
//!                         <system-tag> 块）。不给就跳过——做最纯净的 prompt × text 对照。
//!
//! stdout：仅 refined 文本，无任何 log、无前后缀。
//! stderr：诊断信息（model id、HTTP status 等），方便排查但不污染 stdout。
//! 退出码：0 成功；非 0 = 失败。
//!
//! 不复用 src 里的 ai_refine 模块——那条路径绑了 Tauri runtime / event emit。
//! 这里直接走 reqwest + SaaS chat completions endpoint，跟
//! examples/test_ai_refine_chat.rs 同形态，差别只是把 system / user 改成可注入。

use std::fs;
use std::io::Write as _;
use std::path::PathBuf;

use async_openai::types::chat::CreateChatCompletionStreamResponse;
use futures_util::StreamExt;
use openloaf_saas::{SaaSClient, SaaSClientConfig};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct DevSession {
    access_token: String,
    base_url: String,
}

struct Args {
    system_file: PathBuf,
    user_file: PathBuf,
    context_file: Option<PathBuf>,
    variant: Option<String>,
}

fn parse_args() -> Result<Args, String> {
    let mut iter = std::env::args().skip(1);
    let mut system_file: Option<PathBuf> = None;
    let mut user_file: Option<PathBuf> = None;
    let mut context_file: Option<PathBuf> = None;
    let mut variant: Option<String> = None;
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--system-file" => system_file = iter.next().map(PathBuf::from),
            "--user-file" => user_file = iter.next().map(PathBuf::from),
            "--context-file" => context_file = iter.next().map(PathBuf::from),
            "--variant" => variant = iter.next(),
            other => return Err(format!("unknown arg: {other}")),
        }
    }
    Ok(Args {
        system_file: system_file.ok_or("--system-file required")?,
        user_file: user_file.ok_or("--user-file required")?,
        context_file,
        variant,
    })
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let args = parse_args().map_err(|e| {
        eprintln!("usage: prompt_eval_runner --system-file <path> --user-file <path> [--context-file <path>]\n{e}");
        e
    })?;

    let system_prompt = fs::read_to_string(&args.system_file)
        .map_err(|e| format!("read system-file {}: {e}", args.system_file.display()))?;
    let user_text = fs::read_to_string(&args.user_file)
        .map_err(|e| format!("read user-file {}: {e}", args.user_file.display()))?;
    let context_msg = match &args.context_file {
        Some(p) => Some(
            fs::read_to_string(p).map_err(|e| format!("read context-file {}: {e}", p.display()))?,
        ),
        None => None,
    };

    let home = std::env::var("HOME")?;
    let session_path = PathBuf::from(&home).join(".openspeech/dev_session.json");
    if !session_path.exists() {
        return Err(format!(
            "missing {}\n→ 先跑一次 `pnpm tauri dev` 并登录",
            session_path.display()
        )
        .into());
    }
    let sess: DevSession = serde_json::from_slice(&fs::read(&session_path)?)?;

    let cfg = SaaSClientConfig {
        base_url: sess.base_url.clone(),
        ..Default::default()
    };
    let client = SaaSClient::new(cfg);
    client.set_access_token(Some(sess.access_token.clone()));

    let variant_id = match args.variant {
        Some(v) => v,
        None => tokio::task::spawn_blocking({
            let client = client.clone();
            move || client.ai().fast_chat_variant()
        })
        .await??
        .ok_or("no fast_chat_variant — server returned None")?
        .id,
    };

    eprintln!("[runner] base_url={}", sess.base_url);
    eprintln!("[runner] variant={}", variant_id);

    let url = format!(
        "{}/api/v1/chat/completions",
        sess.base_url.trim_end_matches('/')
    );

    let mut messages = vec![json!({ "role": "system", "content": system_prompt })];
    if let Some(ctx) = context_msg {
        messages.push(json!({ "role": "user", "content": ctx }));
    }
    messages.push(json!({ "role": "user", "content": user_text }));

    let body = json!({
        "variant": variant_id,
        "model": variant_id,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
        "temperature": 0,
        "enable_thinking": false,
    });

    let http = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(60))
        .build()?;
    let resp = http
        .post(&url)
        .bearer_auth(&sess.access_token)
        .json(&body)
        .send()
        .await?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {txt}").into());
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        loop {
            let Some(nl) = buf.find('\n') else { break };
            let line = buf[..nl].trim_end_matches('\r').to_string();
            buf.drain(..=nl);
            let Some(rest) = line.strip_prefix("data:") else { continue };
            let payload = rest.trim();
            if payload.is_empty() || payload == "[DONE]" {
                continue;
            }
            let v: serde_json::Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("[runner] parse SSE failed: {e} | frame: {payload}");
                    continue;
                }
            };
            if !v.is_object() || !v.as_object().unwrap().contains_key("choices") {
                continue;
            }
            let parsed: Result<CreateChatCompletionStreamResponse, _> = serde_json::from_value(v);
            match parsed {
                Ok(r) => {
                    for choice in r.choices {
                        if let Some(content) = choice.delta.content {
                            if !content.is_empty() {
                                out.write_all(content.as_bytes())?;
                                out.flush()?;
                                full.push_str(&content);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("[runner] decode chunk failed: {e} | frame: {payload}");
                }
            }
        }
    }
    eprintln!("\n[runner] done ({} chars)", full.chars().count());
    Ok(())
}
