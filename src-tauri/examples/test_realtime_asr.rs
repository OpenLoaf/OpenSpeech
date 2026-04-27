//! 独立 realtime ASR 测试脚本——不依赖 Tauri 主进程，直接用 `openloaf-saas` SDK
//! 把已有的 WAV 文件当输入，走一遍 `realtimeAsr` 流式识别，打印所有事件。
//!
//! 前置条件：
//! 1. `pnpm tauri dev` 跑起来，**已经登录过一次**——这会把 access_token /
//!    refresh_token 写到 `~/.openspeech/dev_session.json`（debug build 特性）。
//! 2. 至少录过一次音——`~/Library/Application Support/com.openspeech.app/recordings/`
//!    下有 WAV 文件。
//!
//! 运行：
//!   cargo run --example test_realtime_asr
//!   # 或指定某个 WAV
//!   cargo run --example test_realtime_asr -- path/to/file.wav
//!
//! 典型用途：
//! - 验证 realtime 链路本身是否通（把客户端 stt 模块 + audio 回调的逻辑剥离掉）
//! - 复现某条录音在服务端识别时的行为（拿 WAV 反复测，不用再按快捷键录）
//! - 换服务端 URL / 参数排查时方便快速回归

use std::fs;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use hound::{SampleFormat, WavReader};
use openloaf_saas::{RealtimeEvent, SaaSClient, SaaSClientConfig};
use serde::Deserialize;

const FEATURE_ID: &str = "realtimeAsr";
const FRAME_MS: u64 = 200;
const TARGET_SAMPLE_RATE: u32 = 16_000;

#[derive(Deserialize)]
struct DevSession {
    access_token: String,
    base_url: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    // ── 1. 读 dev session（access_token + base_url）─────────────────────
    let home = std::env::var("HOME")?;
    let session_path = PathBuf::from(&home).join(".openspeech/dev_session.json");
    if !session_path.exists() {
        eprintln!(
            "❌ 找不到 {}\n\
             → 先 `pnpm tauri dev` 跑起客户端并登录一次（debug build 会自动 dump session）。",
            session_path.display()
        );
        std::process::exit(1);
    }
    let sess: DevSession = serde_json::from_slice(&fs::read(&session_path)?)?;
    println!("🔑 base_url: {}", sess.base_url);
    println!(
        "🔑 access_token: {}…（已加载）",
        &sess.access_token[..8.min(sess.access_token.len())]
    );

    // ── 2. 选 WAV：命令行第 2 参数优先，否则 recordings/ 里找最新 ─────────
    let wav_path = match std::env::args().nth(1) {
        Some(p) => PathBuf::from(p),
        None => {
            let rec_dir = PathBuf::from(&home)
                .join("Library/Application Support/com.openspeech.app/recordings");
            find_newest_wav(&rec_dir)?
        }
    };
    if !wav_path.exists() {
        eprintln!("❌ WAV 文件不存在: {}", wav_path.display());
        std::process::exit(1);
    }
    println!("🎵 wav: {}", wav_path.display());

    // ── 3. 解 WAV → mono i16 ─────────────────────────────────────────────
    let file = fs::File::open(&wav_path)?;
    let mut reader = WavReader::new(BufReader::new(file))?;
    let spec = reader.spec();
    println!(
        "   spec: sr={}Hz ch={} bits={} fmt={:?}",
        spec.sample_rate, spec.channels, spec.bits_per_sample, spec.sample_format
    );

    // 我们的 Rust 侧只写 16-bit PCM（Int）。其他格式的 WAV（32-bit float 等）罕见，
    // 先不支持——真遇到了再加分支。
    if spec.bits_per_sample != 16 || spec.sample_format != SampleFormat::Int {
        eprintln!(
            "❌ 仅支持 16-bit PCM int；got bits={} fmt={:?}",
            spec.bits_per_sample, spec.sample_format
        );
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
    println!("   samples(mono): {} ({} ms)", mono.len(), duration_ms);

    // ── 3.5 重采样到 16kHz（服务端固定按 16kHz mono pcm16 解码） ──────────
    let pcm16k = resample_linear_pcm16(&mono, spec.sample_rate, TARGET_SAMPLE_RATE);
    println!(
        "   resampled to {}Hz: {} samples",
        TARGET_SAMPLE_RATE,
        pcm16k.len()
    );

    // ── 4. 连 realtime session ───────────────────────────────────────────
    let client = SaaSClient::new(SaaSClientConfig {
        base_url: sess.base_url.clone(),
        access_token: Some(sess.access_token.clone()),
        locale: Some("zh-CN".into()),
        ..Default::default()
    });

    println!("🔌 connecting {}…", FEATURE_ID);
    let t0 = Instant::now();
    let rt = client.realtime().connect(FEATURE_ID)?;
    println!("   connected in {} ms", t0.elapsed().as_millis());

    // 服务端只接 `params.language`，sampleRate/channels/encoding 都是固定值（16kHz/1/pcm16）
    rt.send_start(
        Some(serde_json::json!({ "language": "zh" })),
        Some(serde_json::json!({})),
    )?;
    println!("🚀 start frame sent (language=zh)");

    // ── 5. 按 200ms 分帧发送，穿插拉事件 ─────────────────────────────────
    let frame_samples = (TARGET_SAMPLE_RATE as usize * FRAME_MS as usize / 1000).max(1);
    let total_frames = pcm16k.len().div_ceil(frame_samples);
    println!(
        "📤 streaming {} frames × {} samples ({}ms each)",
        total_frames, frame_samples, FRAME_MS
    );

    let stream_t0 = Instant::now();
    for (i, chunk) in pcm16k.chunks(frame_samples).enumerate() {
        let bytes: Vec<u8> = chunk.iter().flat_map(|s| s.to_le_bytes()).collect();
        rt.send_audio(bytes)?;

        // 拉排队事件（非阻塞）
        while let Some(ev) = rt.try_recv_event()? {
            print_event(&ev, stream_t0);
        }

        // 伪实时：按 FRAME_MS 节流。如果想"满速灌"可以注释掉——服务端通常也能
        // 处理，但伪实时更贴近真机行为（便于观察 Partial 的节奏）。
        thread::sleep(Duration::from_millis(FRAME_MS));

        if (i + 1) % 50 == 0 {
            println!("   … sent {}/{}", i + 1, total_frames);
        }
    }
    println!(
        "📤 all audio sent in {} ms",
        stream_t0.elapsed().as_millis()
    );

    // ── 6. send_finish → 等 Final / Closed ───────────────────────────────
    rt.send_finish()?;
    println!("🏁 finish frame sent, waiting for Final / Closed…");

    let deadline = Instant::now() + Duration::from_secs(10);
    let mut final_text: Option<String> = None;
    loop {
        if Instant::now() >= deadline {
            eprintln!("⏱  timeout waiting for Closed");
            break;
        }
        match rt.recv_event_timeout(Duration::from_millis(200))? {
            Some(ev) => {
                let is_closed = matches!(ev, RealtimeEvent::Closed { .. });
                if let RealtimeEvent::Final { ref text, .. } = ev {
                    final_text = Some(text.clone());
                }
                print_event(&ev, stream_t0);
                if is_closed {
                    break;
                }
            }
            None => continue,
        }
    }

    println!();
    match final_text {
        Some(t) => println!("✅ FINAL: {t}"),
        None => println!("⚠️  no Final received"),
    }

    Ok(())
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

fn print_event(ev: &RealtimeEvent, t0: Instant) {
    let ms = t0.elapsed().as_millis();
    match ev {
        RealtimeEvent::Ready { session_id, .. } => {
            println!("[{ms:>5} ms] ready · session_id={session_id}");
        }
        RealtimeEvent::Partial { text, .. } => {
            println!("[{ms:>5} ms] partial · {text}");
        }
        RealtimeEvent::Final { text, .. } => {
            println!("[{ms:>5} ms] FINAL   · {text}");
        }
        RealtimeEvent::Credits {
            consumed_credits,
            remaining_credits,
            ..
        } => {
            println!(
                "[{ms:>5} ms] credits · consumed={consumed_credits} remaining={remaining_credits}"
            );
        }
        RealtimeEvent::Closed {
            reason,
            total_credits,
            ..
        } => {
            println!("[{ms:>5} ms] closed  · reason={reason} total_credits={total_credits}");
        }
        RealtimeEvent::Error { code, message } => {
            eprintln!("[{ms:>5} ms] ERROR   · {code}: {message}");
        }
    }
}
