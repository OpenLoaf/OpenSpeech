//! ASR 换代 A/B runner：同一段音频分别打 OL-TL-003（Qwen3-ASR-Flash，现网主路径）
//! 与 OL-TL-010（Qwen-Audio-3.1-ASR-Flash），并排输出结果、耗时与积分。
//!
//! 两侧送同一份 system prompt，保证只有模型这一个变量。
//!
//! 输入：
//!   --audio <path>              .ogg / .wav / .mp3，≤5 分钟
//! 可选：
//!   --system-prompt-file <path> ASR 偏置 prompt（两侧送同一份）
//!   --lang <zh|en|...>          语种提示，默认不传（上游自动判定）
//!   --only <003|010>            只跑一侧
//!   --vocab-file <path>         010 的即时热词（每行 `词` 或 `词<TAB>权重`，默认权重 4）。
//!                               3.1 会丢弃 system 消息，词典只能走 vocabulary 生效
//!   --json                      输出单行 JSON（供批量脚本消费）
//!
//! token 取 `~/.openspeech/dev_session.json`（过期先跑 refresh_dev_session）。
//! 全程不打印 token 明文。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

use base64::Engine as _;
use openloaf_saas::v4_tools::{
    AsrShortOlTl003Input, AsrShortOlTl003Params, AsrShortOlTl010Input, AsrShortOlTl010Params,
};
use openloaf_saas::{SaaSClient, SaaSClientConfig};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct DevSession {
    access_token: String,
    base_url: String,
}

struct Args {
    audio: PathBuf,
    system_prompt_file: Option<PathBuf>,
    lang: Option<String>,
    only: Option<String>,
    vocab_file: Option<PathBuf>,
    json_out: bool,
}

fn parse_args() -> Result<Args, String> {
    let mut iter = std::env::args().skip(1);
    let mut audio = None;
    let mut system_prompt_file = None;
    let mut lang = None;
    let mut only = None;
    let mut vocab_file = None;
    let mut json_out = false;
    while let Some(a) = iter.next() {
        match a.as_str() {
            "--audio" => audio = iter.next().map(PathBuf::from),
            "--system-prompt-file" => system_prompt_file = iter.next().map(PathBuf::from),
            "--lang" => lang = iter.next(),
            "--only" => only = iter.next(),
            "--vocab-file" => vocab_file = iter.next().map(PathBuf::from),
            "--json" => json_out = true,
            other => return Err(format!("unknown arg: {other}")),
        }
    }
    Ok(Args {
        audio: audio.ok_or("missing --audio <path>")?,
        system_prompt_file,
        lang,
        only,
        vocab_file,
        json_out,
    })
}

fn media_type_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .as_deref()
    {
        Some("ogg") => "audio/ogg",
        Some("mp3") => "audio/mpeg",
        Some("m4a") => "audio/mp4",
        _ => "audio/wav",
    }
}

#[derive(Default)]
struct Outcome {
    text: String,
    credits: f64,
    elapsed_ms: u128,
    error: Option<String>,
}

fn run_003(
    client: &SaaSClient,
    b64: &str,
    mt: &str,
    lang: Option<String>,
    sp: Option<String>,
) -> Outcome {
    let started = Instant::now();
    let input = AsrShortOlTl003Input::from_base64(b64, mt);
    let params = AsrShortOlTl003Params {
        language: lang,
        enable_itn: Some(true),
        system_prompt: sp,
    };
    let r = client.tools_v4().asr_short_ol_tl_003(&input, &params);
    let elapsed_ms = started.elapsed().as_millis();
    match r {
        Ok(r) => Outcome {
            text: r.data.text,
            credits: r.credits_consumed,
            elapsed_ms,
            error: None,
        },
        Err(e) => Outcome {
            elapsed_ms,
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

fn run_010(
    client: &SaaSClient,
    b64: &str,
    mt: &str,
    lang: Option<String>,
    sp: Option<String>,
    vocabulary: Option<BTreeMap<String, u8>>,
) -> Outcome {
    let started = Instant::now();
    let input = AsrShortOlTl010Input::from_base64(b64, mt);
    // format 留空：服务端按 mediaType 推断（SDK 文档说明上游只校验非空）。
    let params = AsrShortOlTl010Params {
        language: lang,
        format: None,
        system_prompt: sp,
        vocabulary,
    };
    let r = client.tools_v4().asr_short_ol_tl_010(&input, &params);
    let elapsed_ms = started.elapsed().as_millis();
    match r {
        Ok(r) => Outcome {
            text: r.data.text,
            credits: r.credits_consumed,
            elapsed_ms,
            error: None,
        },
        Err(e) => Outcome {
            elapsed_ms,
            error: Some(e.to_string()),
            ..Default::default()
        },
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let args = parse_args()?;

    let home = std::env::var("HOME")?;
    let sess: DevSession = serde_json::from_slice(&fs::read(
        PathBuf::from(&home).join(".openspeech/dev_session.json"),
    )?)?;
    let client = SaaSClient::new(SaaSClientConfig {
        base_url: sess.base_url,
        access_token: Some(sess.access_token),
        ..Default::default()
    });

    let bytes = fs::read(&args.audio)?;
    let mt = media_type_for(&args.audio);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    let sp = match &args.system_prompt_file {
        Some(p) => Some(fs::read_to_string(p)?),
        None => None,
    };

    // 上游只认 1–5 或 50，越界整张表被静默丢弃（服务端会直接 400），这里夹到 1–5。
    let vocabulary = match &args.vocab_file {
        Some(p) => {
            let mut m = BTreeMap::new();
            for line in fs::read_to_string(p)?.lines() {
                let mut it = line.split('\t');
                let word = it.next().unwrap_or("").trim();
                if word.is_empty() {
                    continue;
                }
                let w: u8 = it.next().and_then(|x| x.trim().parse().ok()).unwrap_or(4);
                m.insert(word.to_string(), if w == 50 { 50 } else { w.clamp(1, 5) });
            }
            Some(m)
        }
        None => None,
    };

    let want = |v: &str| args.only.as_deref().is_none_or(|o| o == v);
    let a = want("003").then(|| run_003(&client, &b64, mt, args.lang.clone(), sp.clone()));
    let b = want("010").then(|| {
        run_010(
            &client,
            &b64,
            mt,
            args.lang.clone(),
            sp.clone(),
            vocabulary.clone(),
        )
    });

    let to_json = |o: &Option<Outcome>| {
        o.as_ref().map(|o| {
            json!({ "text": o.text, "credits": o.credits, "elapsedMs": o.elapsed_ms, "error": o.error })
        })
    };
    if args.json_out {
        println!(
            "{}",
            json!({ "audio": args.audio.display().to_string(), "v003": to_json(&a), "v010": to_json(&b) })
        );
    } else {
        for (name, o) in [
            ("OL-TL-003 Qwen3-ASR", &a),
            ("OL-TL-010 Qwen-Audio-3.1", &b),
        ] {
            let Some(o) = o else { continue };
            println!("── {name} ──");
            match &o.error {
                Some(e) => println!("  ERROR: {e}"),
                None => println!("  {}\n  [{}ms · {} 积分]", o.text, o.elapsed_ms, o.credits),
            }
        }
    }
    Ok(())
}
