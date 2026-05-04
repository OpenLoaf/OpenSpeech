//! prompt-eval skill 的 ASR runner。
//!
//! 输入：
//!   --pcm16-file <path>  16kHz mono PCM16-LE raw 字节流（ffmpeg 转好的）
//! 可选：
//!   --lang <auto|zh|en|ja|ko|yue>  默认 auto
//!   --chunk-ms <ms>                每帧大小，默认 100ms
//!
//! stdout：服务端按 sentenceId 顺序拼接的最终 transcript（去掉前后空白后再换一行）。
//! stderr：诊断日志。
//!
//! 跟 src/stt/mod.rs 的 worker 同形态，但去掉 Tauri 集成 / 录音 stream 校验 /
//! mpsc 控制通道，只剩"喂完音频 → finish → 拉到 Closed → 输出"这条直线。

use std::collections::BTreeMap;
use std::fs;
use std::io::Write as _;
use std::path::PathBuf;
use std::time::Duration;

use openloaf_saas::v4_tools::{
    RealtimeAsrLlmOlTlRt002Lang, RealtimeAsrLlmOlTlRt002Params, RealtimeAsrLlmOlTlRt002ServerVad,
    RealtimeAsrLlmOlTlRt002Transcription, RealtimeAsrSession, RealtimeEvent,
};
use openloaf_saas::{SaaSClient, SaaSClientConfig, SaaSError, SaaSResult};
use serde::Deserialize;

const SAMPLE_RATE: usize = 16_000;
const BYTES_PER_SAMPLE: usize = 2; // PCM16-LE
const POLL_MS: u64 = 50;
const TOTAL_TIMEOUT_SECS: u64 = 120;

#[derive(Deserialize)]
struct DevSession {
    access_token: String,
    base_url: String,
}

struct Args {
    pcm16_file: PathBuf,
    lang: RealtimeAsrLlmOlTlRt002Lang,
    chunk_ms: u64,
}

fn parse_lang(s: &str) -> RealtimeAsrLlmOlTlRt002Lang {
    match s {
        "zh" | "zh-CN" | "zh-cn" | "zh-TW" | "zh-tw" => RealtimeAsrLlmOlTlRt002Lang::Zh,
        "en" => RealtimeAsrLlmOlTlRt002Lang::En,
        "ja" => RealtimeAsrLlmOlTlRt002Lang::Ja,
        "ko" => RealtimeAsrLlmOlTlRt002Lang::Ko,
        "yue" => RealtimeAsrLlmOlTlRt002Lang::Yue,
        _ => RealtimeAsrLlmOlTlRt002Lang::Auto,
    }
}

fn parse_args() -> Result<Args, String> {
    let mut iter = std::env::args().skip(1);
    let mut pcm16_file: Option<PathBuf> = None;
    let mut lang = RealtimeAsrLlmOlTlRt002Lang::Auto;
    let mut chunk_ms: u64 = 100;
    while let Some(flag) = iter.next() {
        match flag.as_str() {
            "--pcm16-file" => pcm16_file = iter.next().map(PathBuf::from),
            "--lang" => {
                if let Some(v) = iter.next() {
                    lang = parse_lang(&v);
                }
            }
            "--chunk-ms" => {
                if let Some(v) = iter.next() {
                    chunk_ms = v.parse().map_err(|e| format!("bad --chunk-ms: {e}"))?;
                }
            }
            other => return Err(format!("unknown arg: {other}")),
        }
    }
    Ok(Args {
        pcm16_file: pcm16_file.ok_or("--pcm16-file required")?,
        lang,
        chunk_ms,
    })
}

fn drive_session(
    sess: RealtimeAsrSession,
    pcm: Vec<u8>,
    chunk_ms: u64,
) -> Result<String, String> {
    let chunk_size = (SAMPLE_RATE * BYTES_PER_SAMPLE * chunk_ms as usize) / 1000;
    let chunk_size = chunk_size.max(BYTES_PER_SAMPLE * 2);

    let mut finals: BTreeMap<i64, String> = BTreeMap::new();
    let mut sent = 0usize;
    let mut finish_sent = false;
    let started = std::time::Instant::now();

    loop {
        // 1) 喂一帧音频（如果还有），节流不必要——ASR 服务端能吞快流
        if sent < pcm.len() {
            let end = (sent + chunk_size).min(pcm.len());
            let frame = pcm[sent..end].to_vec();
            sent = end;
            if let Err(e) = sess.send_audio(frame) {
                eprintln!("[transcribe] send_audio: {e}");
            }
        } else if !finish_sent {
            if let Err(e) = sess.finish() {
                return Err(format!("finish: {e}"));
            }
            eprintln!("[transcribe] all PCM sent ({} bytes), finish() called", pcm.len());
            finish_sent = true;
        }

        // 2) 拉一个事件
        let r: SaaSResult<Option<RealtimeEvent>> =
            sess.next_event_timeout(Duration::from_millis(POLL_MS));
        match r {
            Ok(Some(RealtimeEvent::Ready { session_id, .. })) => {
                eprintln!("[transcribe] ready session_id={session_id}");
            }
            Ok(Some(RealtimeEvent::Partial { .. })) => { /* 不消费 partial */ }
            Ok(Some(RealtimeEvent::Final {
                sentence_id, text, ..
            })) => {
                eprintln!("[transcribe] final[{sentence_id}]: {}", text.replace('\n', "⏎"));
                finals.entry(sentence_id).or_insert(text);
            }
            Ok(Some(RealtimeEvent::Credits { remaining_credits, .. })) => {
                eprintln!("[transcribe] credits remaining={:?}", remaining_credits);
            }
            Ok(Some(RealtimeEvent::Closed { reason, .. })) => {
                eprintln!("[transcribe] closed reason={:?}", reason);
                break;
            }
            Ok(Some(RealtimeEvent::Error { code, message })) => {
                return Err(format!("server error code={code}: {message}"));
            }
            Ok(None) => { /* idle */ }
            Err(SaaSError::Network(msg)) => {
                eprintln!("[transcribe] network exit: {msg}");
                break;
            }
            Err(e) => {
                eprintln!("[transcribe] decode err (skip): {e}");
            }
        }

        if started.elapsed() > Duration::from_secs(TOTAL_TIMEOUT_SECS) {
            return Err(format!("timeout after {TOTAL_TIMEOUT_SECS}s"));
        }
        if finish_sent && finals.is_empty() && started.elapsed() > Duration::from_secs(20) {
            // finish 后 20s 还一个 final 都没拿到 → 服务端可能没回应，提前退
            return Err("no Final events received after finish".into());
        }
    }

    let mut out = String::new();
    for v in finals.values() {
        out.push_str(v);
    }
    Ok(out.trim().to_string())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let args = parse_args().map_err(|e| {
        eprintln!("usage: transcribe_audio_runner --pcm16-file <path> [--lang zh|en|ja|ko|yue|auto] [--chunk-ms 100]\n{e}");
        e
    })?;

    let pcm = fs::read(&args.pcm16_file)
        .map_err(|e| format!("read {}: {e}", args.pcm16_file.display()))?;
    if pcm.len() % BYTES_PER_SAMPLE != 0 {
        return Err(format!(
            "pcm length {} is not a multiple of {} (bad PCM16-LE?)",
            pcm.len(),
            BYTES_PER_SAMPLE
        )
        .into());
    }
    let secs = pcm.len() as f64 / (SAMPLE_RATE * BYTES_PER_SAMPLE) as f64;
    eprintln!(
        "[transcribe] {} bytes ≈ {secs:.2}s (16kHz PCM16-LE mono)",
        pcm.len()
    );

    let home = std::env::var("HOME")?;
    let session_path = PathBuf::from(&home).join(".openspeech/dev_session.json");
    if !session_path.exists() {
        return Err(format!(
            "missing {}\n→ 先跑一次 `pnpm tauri dev` 并登录",
            session_path.display()
        )
        .into());
    }
    let sess_meta: DevSession = serde_json::from_slice(&fs::read(&session_path)?)?;

    let cfg = SaaSClientConfig {
        base_url: sess_meta.base_url.clone(),
        ..Default::default()
    };
    let client = SaaSClient::new(cfg);
    client.set_access_token(Some(sess_meta.access_token.clone()));

    let params = RealtimeAsrLlmOlTlRt002Params {
        input_audio_transcription: Some(RealtimeAsrLlmOlTlRt002Transcription {
            language: Some(args.lang),
            context: None,
        }),
        turn_detection: Some(RealtimeAsrLlmOlTlRt002ServerVad::default()),
        ..Default::default()
    };

    let lang_for_log = args.lang;
    let chunk_ms = args.chunk_ms;
    let transcript = tokio::task::spawn_blocking(move || -> Result<String, String> {
        let sess = client
            .tools_v4()
            .realtime_asr_llm_ol_tl_rt_002(&params)
            .map_err(|e| format!("realtime connect: {e}"))?;
        eprintln!(
            "[transcribe] connected (lang={:?}, chunk={chunk_ms}ms)",
            lang_for_log
        );
        drive_session(sess, pcm, chunk_ms)
    })
    .await??;

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    out.write_all(transcript.as_bytes())?;
    out.write_all(b"\n")?;
    Ok(())
}
