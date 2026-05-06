//! 腾讯实时语音识别 + 说话人分离的端到端烟雾测试。
//!
//! 不依赖 Tauri / SaaS 登录态——直接拿环境变量 + 本地 OGG 文件跑通。
//!
//! 前置条件：
//!   export TENCENT_APPID=...
//!   export TENCENT_SECRET_ID=...
//!   export TENCENT_SECRET_KEY=...
//!
//! 运行：
//!   cargo run --example test_meeting_speaker_realtime
//!   cargo run --example test_meeting_speaker_realtime -- path/to/audio.ogg
//!
//! 默认音频用 `.claude/skills/openspeech-prompt-eval/cases/005-history-view-detail/audio.ogg`。

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use ogg::PacketReader;
use openspeech_lib::asr::meeting::tencent_speaker::TencentSpeakerProvider;
use openspeech_lib::asr::meeting::{
    MeetingAsrProvider, MeetingEvent, MeetingSessionConfig,
};
use opus::{Channels, Decoder};

const TARGET_RATE: u32 = 16_000;
const FRAME_MS: u64 = 40; // 腾讯说话人分离推荐节奏

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let provider = TencentSpeakerProvider::from_env()?;
    println!("✅ provider id = {}", provider.id());
    println!("    capabilities = {:#?}", provider.capabilities());

    let audio_path = std::env::args().nth(1).map(PathBuf::from).unwrap_or_else(|| {
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".claude/skills/openspeech-prompt-eval/cases/005-history-view-detail/audio.ogg")
    });
    println!("📂 audio: {}", audio_path.display());
    let pcm = decode_ogg_to_pcm16_mono_16k(&audio_path)?;
    println!("📊 decoded {} bytes ({:.2}s)", pcm.len(), pcm.len() as f64 / (TARGET_RATE as f64 * 2.0));

    let mut session = provider.open(MeetingSessionConfig {
        language: "zh".into(),
        sample_rate: TARGET_RATE,
        enable_diarization: true,
    })?;

    println!("⏳ waiting for handshake...");
    loop {
        match session.next_event(Duration::from_secs(5)) {
            MeetingEvent::Ready { session_id } => {
                println!("✅ ready (voice_id={:?})", session_id);
                break;
            }
            MeetingEvent::Error { code, message } => {
                eprintln!("❌ handshake error: {code} {message}");
                return Ok(());
            }
            MeetingEvent::NetworkExit(m) => {
                eprintln!("❌ network: {m}");
                return Ok(());
            }
            MeetingEvent::Idle => {
                eprintln!("…still waiting");
            }
            other => {
                eprintln!("? unexpected pre-ready event: {other:?}");
            }
        }
    }

    let frame_bytes = (TARGET_RATE as usize / 1000 * FRAME_MS as usize) * 2;
    let started = Instant::now();

    // 串行：边发边收（实战是两个线程，example 里简化）
    let mut offset = 0;
    let mut last_print = Instant::now();
    while offset < pcm.len() {
        let end = (offset + frame_bytes).min(pcm.len());
        let chunk = pcm[offset..end].to_vec();
        offset = end;
        if let Err(e) = session.send_audio(chunk) {
            eprintln!("send_audio err: {e}");
            break;
        }
        // 拉一次事件（非阻塞短超时）
        match session.next_event(Duration::from_millis(2)) {
            MeetingEvent::SegmentPartial(s) => {
                if last_print.elapsed() > Duration::from_millis(200) {
                    println!("  partial speaker={} sid={} text={}", s.speaker_id, s.sentence_id, s.text);
                    last_print = Instant::now();
                }
            }
            MeetingEvent::SegmentFinal(s) => {
                println!("✅ final   speaker={} sid={} t=[{}..{}]ms text={}", s.speaker_id, s.sentence_id, s.start_ms, s.end_ms, s.text);
            }
            MeetingEvent::Error { code, message } => {
                eprintln!("❌ error during stream: {code} {message}");
                break;
            }
            MeetingEvent::NetworkExit(m) => {
                eprintln!("❌ network exit: {m}");
                break;
            }
            _ => {}
        }
        // 控制节奏：实时率 1:1
        thread::sleep(Duration::from_millis(FRAME_MS));
    }

    println!("⏹  finishing...");
    let _ = session.finish();

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match session.next_event(Duration::from_millis(200)) {
            MeetingEvent::SegmentFinal(s) => {
                println!("✅ final   speaker={} sid={} t=[{}..{}]ms text={}", s.speaker_id, s.sentence_id, s.start_ms, s.end_ms, s.text);
            }
            MeetingEvent::SegmentPartial(s) => {
                println!("  partial speaker={} sid={} text={}", s.speaker_id, s.sentence_id, s.text);
            }
            MeetingEvent::EndOfStream => {
                println!("🏁 end-of-stream");
                break;
            }
            MeetingEvent::Error { code, message } => {
                eprintln!("❌ {code} {message}");
                break;
            }
            MeetingEvent::NetworkExit(m) => {
                eprintln!("❌ network: {m}");
                break;
            }
            MeetingEvent::Idle => {}
            _ => {}
        }
    }

    println!("⌛ total elapsed = {:.2}s", started.elapsed().as_secs_f64());
    Ok(())
}

fn decode_ogg_to_pcm16_mono_16k(path: &Path) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let f = std::fs::File::open(path)?;
    let mut reader = PacketReader::new(f);

    let mut decoder: Option<Decoder> = None;
    let mut out_pcm: Vec<i16> = Vec::new();
    let mut frame_buf = vec![0i16; 6000];
    let mut idx = 0usize;
    while let Some(packet) = reader.read_packet()? {
        let data = packet.data;
        match idx {
            0 => {
                if data.len() < 19 || &data[0..8] != b"OpusHead" {
                    return Err("not Ogg/Opus".into());
                }
                let channels_u8 = data[9];
                if channels_u8 != 1 {
                    return Err(format!("expected mono, got {} channels", channels_u8).into());
                }
                decoder = Some(Decoder::new(TARGET_RATE, Channels::Mono)?);
            }
            1 => {} // OpusTags
            _ => {
                let dec = decoder.as_mut().ok_or("decoder not initialized")?;
                let n = dec.decode(&data, &mut frame_buf, false)?;
                out_pcm.extend_from_slice(&frame_buf[..n]);
            }
        }
        idx += 1;
    }

    let mut bytes = Vec::with_capacity(out_pcm.len() * 2);
    for s in out_pcm {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    Ok(bytes)
}
