//! 复现 / 诊断「长句中间停顿，转写结果只剩最后一段」的 bug。V4 通道版本。
//!
//! 走 V4 `OL-TL-RT-002` (`realtimeAsrLlm` / Qwen3-ASR-Flash-Realtime)，
//! 与 src-tauri/src/stt/mod.rs 实际生产链路保持一致。
//!
//! 用法：
//!   cargo run --example test_realtime_asr_segmentation
//!   cargo run --example test_realtime_asr_segmentation -- /path/to.wav
//!   cargo run --example test_realtime_asr_segmentation -- /path/to.wav 1500
//!     ↑ 第二个参数：在音频中点注入多少 ms 静音（默认 0 = 不注入）
//!   cargo run --example test_realtime_asr_segmentation -- /path/to.wav 1500 manual
//!     ↑ 第三个参数：vad 模式 auto (默认) / manual

use std::collections::BTreeMap;
use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use hound::{SampleFormat, WavReader};
use openloaf_saas::v4_tools::{
    RealtimeAsrLlmOlTlRt002Lang, RealtimeAsrLlmOlTlRt002Params, RealtimeAsrLlmOlTlRt002ServerVad,
    RealtimeAsrLlmOlTlRt002Transcription, RealtimeEvent,
};
use openloaf_saas::{SaaSClient, SaaSClientConfig};
use serde::Deserialize;

const FRAME_MS: u64 = 200;
const TARGET_SAMPLE_RATE: u32 = 16_000;

#[derive(Deserialize)]
struct DevSession {
    access_token: String,
    base_url: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let home = std::env::var("HOME")?;
    let session_path = PathBuf::from(&home).join(".openspeech/dev_session.json");
    if !session_path.exists() {
        eprintln!("❌ 找不到 {}", session_path.display());
        std::process::exit(1);
    }
    let sess: DevSession = serde_json::from_slice(&fs::read(&session_path)?)?;
    println!("🔑 base_url: {}", sess.base_url);

    let wav_path = match std::env::args().nth(1) {
        Some(p) => PathBuf::from(p),
        None => {
            let rec_dir = PathBuf::from(&home)
                .join("Library/Application Support/com.openspeech.app/recordings");
            find_newest_wav(&rec_dir)?
        }
    };
    let silence_inject_ms: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0);
    let use_server_vad = !matches!(
        std::env::args().nth(3).as_deref(),
        Some("manual") | Some("none")
    );

    println!("🎵 wav: {}", wav_path.display());
    println!("🤐 silence inject (mid): {} ms", silence_inject_ms);
    println!("🎚 server_vad: {}", use_server_vad);

    let file = fs::File::open(&wav_path)?;
    let mut reader = WavReader::new(BufReader::new(file))?;
    let spec = reader.spec();
    println!(
        "   spec: sr={}Hz ch={} bits={} fmt={:?}",
        spec.sample_rate, spec.channels, spec.bits_per_sample, spec.sample_format
    );
    if spec.bits_per_sample != 16 || spec.sample_format != SampleFormat::Int {
        eprintln!("❌ 仅支持 16-bit PCM int");
        std::process::exit(1);
    }

    let all_samples: Vec<i16> = reader.samples::<i16>().collect::<Result<Vec<_>, _>>()?;
    let mono: Vec<i16> = if spec.channels <= 1 {
        all_samples
    } else {
        let ch = spec.channels as usize;
        all_samples
            .chunks(ch)
            .map(|c| {
                let sum: i32 = c.iter().map(|&s| s as i32).sum();
                (sum / ch as i32) as i16
            })
            .collect()
    };
    let duration_ms = mono.len() as u64 * 1000 / spec.sample_rate as u64;
    println!("   原始时长: {} ms", duration_ms);

    let mut pcm16k = resample_linear_pcm16(&mono, spec.sample_rate, TARGET_SAMPLE_RATE);
    if silence_inject_ms > 0 {
        let silence_samples = (TARGET_SAMPLE_RATE as u64 * silence_inject_ms / 1000) as usize;
        let mid = pcm16k.len() / 2;
        let mut spliced = Vec::with_capacity(pcm16k.len() + silence_samples);
        spliced.extend_from_slice(&pcm16k[..mid]);
        spliced.extend(std::iter::repeat(0i16).take(silence_samples));
        spliced.extend_from_slice(&pcm16k[mid..]);
        pcm16k = spliced;
        println!(
            "   ✂ 已在中点 ({}ms) 插入 {}ms 静音",
            mid as u64 * 1000 / TARGET_SAMPLE_RATE as u64,
            silence_inject_ms
        );
    }
    let final_duration_ms = pcm16k.len() as u64 * 1000 / TARGET_SAMPLE_RATE as u64;
    println!("   送出时长（含注入静音）: {} ms", final_duration_ms);

    let client = SaaSClient::new(SaaSClientConfig {
        base_url: sess.base_url.clone(),
        access_token: Some(sess.access_token.clone()),
        locale: Some("zh-CN".into()),
        ..Default::default()
    });

    println!("🔌 connecting OL-TL-RT-002 …");
    let t0 = Instant::now();
    let rt = client
        .tools_v4()
        .realtime_asr_llm_ol_tl_rt_002(&RealtimeAsrLlmOlTlRt002Params {
            input_audio_transcription: Some(RealtimeAsrLlmOlTlRt002Transcription {
                language: Some(RealtimeAsrLlmOlTlRt002Lang::Auto),
                context: None,
            }),
            turn_detection: if use_server_vad {
                Some(RealtimeAsrLlmOlTlRt002ServerVad::default())
            } else {
                None
            },
            ..Default::default()
        })?;
    println!("   connected in {} ms", t0.elapsed().as_millis());

    let frame_samples = (TARGET_SAMPLE_RATE as usize * FRAME_MS as usize / 1000).max(1);
    let total_frames = pcm16k.len().div_ceil(frame_samples);
    println!(
        "📤 streaming {} frames × {} samples ({}ms each)",
        total_frames, frame_samples, FRAME_MS
    );

    let mut all_finals: Vec<(u128, i64, String)> = Vec::new();
    let mut all_partials: Vec<(u128, i64, String)> = Vec::new();
    let mut closed_seen = false;

    let stream_t0 = Instant::now();
    for (i, chunk) in pcm16k.chunks(frame_samples).enumerate() {
        let bytes: Vec<u8> = chunk.iter().flat_map(|s| s.to_le_bytes()).collect();
        rt.send_audio(bytes)?;

        while let Some(ev) = rt.try_next_event()? {
            collect_event(&ev, stream_t0, &mut all_finals, &mut all_partials);
            if matches!(ev, RealtimeEvent::Closed { .. }) {
                closed_seen = true;
            }
        }

        thread::sleep(Duration::from_millis(FRAME_MS));

        if (i + 1) % 50 == 0 {
            println!(
                "   … sent {}/{} (elapsed {}ms, finals so far: {})",
                i + 1,
                total_frames,
                stream_t0.elapsed().as_millis(),
                all_finals.len()
            );
        }
    }
    println!(
        "📤 all audio sent in {} ms",
        stream_t0.elapsed().as_millis()
    );

    rt.finish()?;
    println!("🏁 finish frame sent, waiting for Final / Closed…");

    let deadline = Instant::now() + Duration::from_secs(15);
    while !closed_seen && Instant::now() < deadline {
        match rt.next_event_timeout(Duration::from_millis(200))? {
            Some(ev) => {
                let is_closed = matches!(ev, RealtimeEvent::Closed { .. });
                collect_event(&ev, stream_t0, &mut all_finals, &mut all_partials);
                if is_closed {
                    closed_seen = true;
                    break;
                }
            }
            None => continue,
        }
    }
    if !closed_seen {
        eprintln!("⏱  timeout waiting for Closed");
    }

    println!();
    println!("════════════════════ 诊断结果 ════════════════════");
    println!("Partial 事件总数: {}", all_partials.len());
    println!("Final   事件总数: {}", all_finals.len());
    println!();
    println!("─── 所有 Final（按到达顺序）────────────────────");
    for (i, (ms, sid, t)) in all_finals.iter().enumerate() {
        println!("  #{:<2} [{:>6} ms] sentenceId={} {:?}", i + 1, ms, sid, t);
    }
    println!();

    // 按 sentenceId 顺序拼接（与 stt/mod.rs 实际行为一致）
    let mut by_sid: BTreeMap<i64, &String> = BTreeMap::new();
    for (_, sid, t) in &all_finals {
        by_sid.insert(*sid, t);
    }
    let concat_by_sid: String = by_sid.values().map(|s| s.as_str()).collect::<String>();
    let concat_by_arrival: String = all_finals
        .iter()
        .map(|(_, _, t)| t.as_str())
        .collect::<Vec<_>>()
        .join("");
    let last_only = all_finals
        .last()
        .map(|(_, _, t)| t.clone())
        .unwrap_or_default();

    println!("─── 按 sentenceId 顺序拼接（生产实际行为）─────");
    println!("{concat_by_sid}");
    println!();
    println!("─── 按到达顺序拼接（参考） ────────────────────");
    println!("{concat_by_arrival}");
    println!();
    println!("─── 仅最后一个 Final（旧 bug 行为）─────────────");
    println!("{last_only}");
    println!();
    if all_finals.len() > 1 {
        let lost = concat_by_sid
            .chars()
            .count()
            .saturating_sub(last_only.chars().count());
        println!(
            "⚠️  本次产生 {} 个 Final 段；旧实现只保留最后一段时丢字 ≈ {} 字。",
            all_finals.len(),
            lost
        );
    } else {
        println!("ℹ️  仅 1 个 Final，本次音频未触发服务端分段。");
    }

    Ok(())
}

fn collect_event(
    ev: &RealtimeEvent,
    t0: Instant,
    finals: &mut Vec<(u128, i64, String)>,
    partials: &mut Vec<(u128, i64, String)>,
) {
    let ms = t0.elapsed().as_millis();
    match ev {
        RealtimeEvent::Ready { session_id, .. } => {
            println!("[{ms:>6} ms] ready · {session_id}");
        }
        RealtimeEvent::Partial { sentence_id, text, .. } => {
            println!("[{ms:>6} ms] partial · sid={sentence_id} {text}");
            partials.push((ms, *sentence_id, text.clone()));
        }
        RealtimeEvent::Final {
            sentence_id, text, ..
        } => {
            println!("[{ms:>6} ms] FINAL   · sid={sentence_id} {text}");
            finals.push((ms, *sentence_id, text.clone()));
        }
        RealtimeEvent::Credits {
            consumed_credits,
            remaining_credits,
            ..
        } => {
            println!(
                "[{ms:>6} ms] credits · used={consumed_credits:?} remaining={remaining_credits:?}"
            );
        }
        RealtimeEvent::Closed {
            reason,
            total_credits,
            ..
        } => {
            println!("[{ms:>6} ms] closed  · reason={reason} total={total_credits:?}");
        }
        RealtimeEvent::Error { code, message } => {
            eprintln!("[{ms:>6} ms] ERROR   · {code}: {message}");
        }
    }
}

fn resample_linear_pcm16(input: &[i16], src_rate: u32, dst_rate: u32) -> Vec<i16> {
    if src_rate == dst_rate || input.is_empty() {
        return input.to_vec();
    }
    let ratio = src_rate as f64 / dst_rate as f64;
    let dst_len = (input.len() as f64 / ratio).floor() as usize;
    let mut out = Vec::with_capacity(dst_len);
    let last = input.len().saturating_sub(1);
    for i in 0..dst_len {
        let src_idx = i as f64 * ratio;
        let lo = src_idx.floor() as usize;
        let hi = (lo + 1).min(last);
        let frac = src_idx - lo as f64;
        let s = input[lo] as f64 * (1.0 - frac) + input[hi] as f64 * frac;
        out.push(s.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
    }
    out
}

fn find_newest_wav(dir: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if !dir.exists() {
        return Err(format!("recordings dir not found: {}", dir.display()).into());
    }
    let mut newest: Option<(SystemTime, PathBuf)> = None;
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|s| s.to_str()) != Some("wav") {
            continue;
        }
        let mtime = entry.metadata()?.modified()?;
        match &newest {
            None => newest = Some((mtime, path)),
            Some((cur, _)) if mtime > *cur => newest = Some((mtime, path)),
            _ => {}
        }
    }
    newest
        .map(|(_, p)| p)
        .ok_or_else(|| format!("no .wav in {}", dir.display()).into())
}
