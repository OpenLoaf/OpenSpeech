//! 独立 AI refine chat 测试脚本——不依赖 Tauri 主进程，直接复用 dev_session 拿
//! access_token / base_url，再调 SDK `fast_chat_variant()` 拿快速模型 ID + endpoint，
//! 用 reqwest 直发 OpenAI 协议 chat completions，打印 SSE 流。
//!
//! 不用 async-openai 的 `client.chat().create_stream`：它把 path 写死成
//! `/chat/completions`，但用我们仍要塞 `variant` 字段且要走 OpenLoaf 自己的 chat
//! 端点。这里 POST 到 `<saas_base>/api/v1/chat/completions`，body 走 OpenAI 标准 +
//! `variant` + `enable_thinking: false`，用 async-openai 的
//! `CreateChatCompletionStreamResponse` 类型解析 SSE 帧。
//!
//! 前置：`pnpm tauri dev` 至少跑过一次并登录。
//!
//! 运行：
//!   cargo run --example test_ai_refine_chat
//!   cargo run --example test_ai_refine_chat -- "你的口语化原文..."

use std::fs;
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let home = std::env::var("HOME")?;
    let session_path = PathBuf::from(&home).join(".openspeech/dev_session.json");
    if !session_path.exists() {
        eprintln!(
            "❌ 找不到 {}\n→ 先跑一次 `pnpm tauri dev` 并登录。",
            session_path.display()
        );
        std::process::exit(1);
    }
    let sess: DevSession = serde_json::from_slice(&fs::read(&session_path)?)?;
    println!("🔑 base_url: {}", sess.base_url);
    println!(
        "🔑 access_token: {}…",
        &sess.access_token[..8.min(sess.access_token.len())]
    );

    let cfg = SaaSClientConfig {
        base_url: sess.base_url.clone(),
        ..Default::default()
    };
    let client = SaaSClient::new(cfg);
    client.set_access_token(Some(sess.access_token.clone()));

    let variant = tokio::task::spawn_blocking({
        let client = client.clone();
        move || client.ai().fast_chat_variant()
    })
    .await??
    .ok_or("no fast_chat_variant — server returned None")?;
    let endpoint = variant
        .endpoint
        .clone()
        .ok_or("variant missing endpoint")?;
    println!(
        "🤖 fast variant: id={}  endpoint={}  family={:?}",
        variant.id, endpoint, variant.family_id
    );

    let url = format!(
        "{}/api/v1/chat/completions",
        sess.base_url.trim_end_matches('/')
    );
    let _ = endpoint;
    println!("➡  POST {url}");

    let user_text = std::env::args().nth(1).unwrap_or_else(|| {
        "现成的组件呢？找一下现成组件，尽量不要自己写。".to_string()
    });

    let context_msg = "<system-tag type=\"HotWords\">\n\tOpenSpeech、OpenLoaf\n</system-tag>\n\n\
<system-tag type=\"ConversationHistory\">\n\
\t[8 分钟前] 首页有个布局的 bug 修复一下。\n\n\
\t[7 分钟前] 我需要 Markdown 格式，我在哪里可以直接复制？或者你给我一个文件的路径，我直接从文件里面复制。\n\n\
\t[2 分钟前] 这个 dialog 打开的时候应该是 diff 的那种形式，每一行有什么不一样。\n\
</system-tag>\n\n\
<system-tag type=\"MessageContext\">\n\trequestTime: 2026-05-01T08:08:28.551Z (UTC)\n</system-tag>";

    let body = json!({
        "variant": variant.id,
        "model": variant.id,
        "messages": [
            { "role": "system", "content": "你是口语整理助手。把口述 / ASR 转写整理成可读的书面文字，**保持原义、不增不删、不翻译换种**。只整理，不扩写——不解释、不总结、不回答问题、不加引号或代码块。" },
            { "role": "user", "content": context_msg },
            { "role": "user", "content": user_text },
        ],
        "stream": true,
        "stream_options": { "include_usage": true },
        "temperature": 0,
        "enable_thinking": false,
    });

    let http = reqwest::Client::builder()
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
        eprintln!("❌ HTTP {status}: {txt}");
        std::process::exit(1);
    }

    println!("\n────── streaming ──────");
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
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
            // SaaS 在末尾会发非标帧（如 {"x_credits_consumed": 0.04} 计费元数据）。
            // 没有 "choices" 键的一律按元数据丢弃，不告警。
            let v: serde_json::Value = match serde_json::from_str(payload) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("\n⚠ parse SSE frame failed: {e}\nframe: {payload}");
                    continue;
                }
            };
            if !v.is_object() || !v.as_object().unwrap().contains_key("choices") {
                continue;
            }
            let parsed: Result<CreateChatCompletionStreamResponse, _> =
                serde_json::from_value(v);
            match parsed {
                Ok(r) => {
                    for choice in r.choices {
                        if let Some(content) = choice.delta.content {
                            if !content.is_empty() {
                                print!("{content}");
                                std::io::Write::flush(&mut std::io::stdout()).ok();
                                full.push_str(&content);
                            }
                        }
                    }
                }
                Err(e) => {
                    eprintln!("\n⚠ decode chat chunk failed: {e}\nframe: {payload}");
                }
            }
        }
    }

    println!("\n────── done ──────");
    println!("📝 refined ({} chars):\n{full}", full.chars().count());
    Ok(())
}
