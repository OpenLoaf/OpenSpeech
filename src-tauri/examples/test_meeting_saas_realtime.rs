//! SaaS OL-TL-RT-003 实时 ASR + 说话人分离的端到端烟雾测试。
//!
//! 等价于 `test_meeting_speaker_realtime.rs` 但走 SaaS 路径——同一段音频、同一个
//! `16k_zh_en_speaker` 引擎、同样期待 partial / final 含 speaker_id。两个 example
//! 一对照能立刻定位"为什么自带腾讯 OK、SaaS 出不来识别"是哪一段链路坏了。
//!
//! **零环境变量**：默认从 OpenSpeech dev 登录态读 access_token：
//!   - debug build：`~/.openspeech/dev-auth.json` 里的 `accessToken`
//!   - release build：macOS Keychain `service=ai.openloaf.saas` `account=default`
//! base_url 跟 OpenSpeech 主进程一致，从 `openspeech_lib::openloaf::DEFAULT_BASE_URL`
//! 拿（debug=localhost:5180 / release=openloaf.hexems.com / 或 OPENLOAF_BASE_URL 覆盖）。
//!
//! 运行：
//!   cargo run --example test_meeting_saas_realtime
//!   cargo run --example test_meeting_saas_realtime -- path/to/audio.ogg

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use ogg::PacketReader;
use openloaf_saas::{SaaSClient, SaaSClientConfig};
use openspeech_lib::asr::meeting::saas::SaasMeetingProvider;
use openspeech_lib::asr::meeting::{MeetingAsrProvider, MeetingEvent, MeetingSessionConfig};

// 与 src/openloaf/mod.rs::DEFAULT_BASE_URL 行为对齐：
// - debug build：localhost:5180
// - release build：openloaf.hexems.com
// - OPENLOAF_BASE_URL 环境变量覆盖优先
#[cfg(debug_assertions)]
const FALLBACK_BASE_URL: &str = "http://localhost:5180";
#[cfg(not(debug_assertions))]
const FALLBACK_BASE_URL: &str = "https://openloaf.hexems.com";
use opus::{Channels, Decoder};
use serde::Deserialize;

const TARGET_RATE: u32 = 16_000;
// 文档建议 100ms 一帧（OL-TL-RT-003）；改 40ms 也跑——主要为了节奏与自带腾讯 example 对齐。
const FRAME_MS: u64 = 40;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    let family_token = load_family_token()?;
    let base_url = std::env::var("OPENLOAF_BASE_URL").unwrap_or_else(|_| FALLBACK_BASE_URL.into());
    println!(
        "🔐 family_token = ***{}",
        &family_token[family_token.len().saturating_sub(8)..]
    );
    println!("🌐 base_url     = {base_url}");

    let client = SaaSClient::new(SaaSClientConfig {
        base_url: base_url.clone(),
        client_name: Some("openspeech-example".into()),
        client_version: Some(env!("CARGO_PKG_VERSION").into()),
        ..Default::default()
    });
    // family_exchange 用 familyToken 换 access_token，并自动 set 到 client。
    let session = client
        .auth()
        .family_exchange(&family_token, None)
        .map_err(|e| format!("family_exchange failed: {e}"))?;
    println!(
        "✅ family_exchange ok userId={:?} access=***{}",
        session.user.id,
        &session.access_token[session.access_token.len().saturating_sub(8)..]
    );
    let provider = SaasMeetingProvider::new(client);
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
    println!(
        "📊 decoded {} bytes ({:.2}s)",
        pcm.len(),
        pcm.len() as f64 / (TARGET_RATE as f64 * 2.0)
    );

    let mut session = provider.open(MeetingSessionConfig {
        language: "zh".into(),
        sample_rate: TARGET_RATE,
        enable_diarization: true,
    })?;

    println!("⏳ waiting for handshake...");
    loop {
        match session.next_event(Duration::from_secs(8)) {
            MeetingEvent::Ready { session_id } => {
                println!("✅ ready (session_id={:?})", session_id);
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
            other => eprintln!("? unexpected pre-ready event: {other:?}"),
        }
    }

    let frame_bytes = (TARGET_RATE as usize / 1000 * FRAME_MS as usize) * 2;
    let started = Instant::now();
    let mut sent_bytes = 0usize;
    let mut partial_count = 0usize;
    let mut final_count = 0usize;

    let mut offset = 0;
    let mut last_print = Instant::now();
    while offset < pcm.len() {
        let end = (offset + frame_bytes).min(pcm.len());
        let chunk = pcm[offset..end].to_vec();
        sent_bytes += chunk.len();
        offset = end;
        if let Err(e) = session.send_audio(chunk) {
            eprintln!("send_audio err: {e}");
            break;
        }
        match session.next_event(Duration::from_millis(2)) {
            MeetingEvent::SegmentPartial(s) => {
                partial_count += 1;
                if last_print.elapsed() > Duration::from_millis(200) {
                    println!(
                        "  partial speaker={} sid={} text={}",
                        s.speaker_id, s.sentence_id, s.text
                    );
                    last_print = Instant::now();
                }
            }
            MeetingEvent::SegmentFinal(s) => {
                final_count += 1;
                println!(
                    "✅ final   speaker={} sid={} t=[{}..{}]ms text={}",
                    s.speaker_id, s.sentence_id, s.start_ms, s.end_ms, s.text
                );
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
        thread::sleep(Duration::from_millis(FRAME_MS));
    }

    println!("⏹  finishing... (sent {} bytes)", sent_bytes);
    let _ = session.finish();

    let deadline = Instant::now() + Duration::from_secs(15);
    while Instant::now() < deadline {
        match session.next_event(Duration::from_millis(200)) {
            MeetingEvent::SegmentFinal(s) => {
                final_count += 1;
                println!(
                    "✅ final   speaker={} sid={} t=[{}..{}]ms text={}",
                    s.speaker_id, s.sentence_id, s.start_ms, s.end_ms, s.text
                );
            }
            MeetingEvent::SegmentPartial(s) => {
                partial_count += 1;
                println!(
                    "  partial speaker={} sid={} text={}",
                    s.speaker_id, s.sentence_id, s.text
                );
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

    println!(
        "⌛ total elapsed = {:.2}s  partials={}  finals={}",
        started.elapsed().as_secs_f64(),
        partial_count,
        final_count
    );
    if partial_count == 0 && final_count == 0 {
        eprintln!("❌ ZERO transcripts — SaaS 转发链路上的问题，对比 test_meeting_speaker_realtime（自带腾讯）应该有结果。");
        std::process::exit(2);
    }
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
            1 => {}
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

// ─── family_token 装载 ─────────────────────────────────────────────
//
// dev-auth.json / Keychain 里持久化的是 familyToken（不是短期 accessToken）。
// 拿 familyToken 调 SDK family_exchange 即可换出短期 accessToken。

#[derive(Debug, Deserialize)]
struct StoredAuthSlice {
    #[serde(rename = "familyToken")]
    family_token: Option<String>,
    #[serde(rename = "refreshToken")]
    refresh_token: Option<String>,
}

#[cfg(debug_assertions)]
fn load_family_token() -> Result<String, Box<dyn std::error::Error>> {
    let home = std::env::var("HOME").map_err(|_| "$HOME not set")?;
    let path = PathBuf::from(home).join(".openspeech/dev-auth.json");
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "读不到 dev 登录文件 {} ({e})\n请先在 OpenSpeech 主进程登录一次（debug build）",
            path.display()
        )
    })?;
    let slice: StoredAuthSlice = serde_json::from_str(&raw)
        .map_err(|e| format!("解析 dev-auth.json 失败：{e}（路径 {}）", path.display()))?;
    slice
        .family_token
        .or(slice.refresh_token)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "dev-auth.json 里没有 familyToken / refreshToken".into())
}

#[cfg(not(debug_assertions))]
fn load_family_token() -> Result<String, Box<dyn std::error::Error>> {
    use keyring::Entry;
    let entry = Entry::new("ai.openloaf.saas", "default")?;
    let raw = entry
        .get_password()
        .map_err(|e| format!("Keychain ai.openloaf.saas/default 读失败：{e}"))?;
    let slice: StoredAuthSlice = serde_json::from_str(&raw)?;
    slice
        .family_token
        .or(slice.refresh_token)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "Keychain 里没有 familyToken / refreshToken".into())
}
