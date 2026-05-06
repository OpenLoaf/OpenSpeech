//! 腾讯实时语音识别 + 说话人分离的端到端烟雾测试。
//!
//! **零环境变量**：默认从 OpenSpeech 已配置的"自定义 → 腾讯"BYOK 自动取凭证：
//!   - settings.json 里 `dictation.customProviders` 找 vendor=tencent 那条，
//!     拿 id / tencentAppId
//!   - macOS Keychain service=`com.openspeech.app` key=`dictation_provider_<id>`
//!     里取 secretId / secretKey
//!
//! 这样在 dev 环境点过设置 → 听写 → 自定义 → 腾讯 之后，example 直接能跑通，
//! 不需要再 export 任何东西，也不会把 SecretKey 落到任何文件。
//!
//! 旧的环境变量路径仍然 fallback 支持（CI 或没配 BYOK 的人可走 env）：
//!   export TENCENT_APPID=...
//!   export TENCENT_SECRET_ID=...
//!   export TENCENT_SECRET_KEY=...
//!
//! 运行：
//!   cargo run --example test_meeting_speaker_realtime
//!   cargo run --example test_meeting_speaker_realtime -- path/to/audio.ogg
//!
//! 默认音频用 `.claude/skills/openspeech-prompt-eval/cases/005-history-view-detail/audio.ogg`。
//!
//! **首次运行 macOS 会弹 Keychain 授权弹窗**——选「始终允许」。

use std::path::{Path, PathBuf};
use std::thread;
use std::time::{Duration, Instant};

use ogg::PacketReader;
use openspeech_lib::asr::meeting::tencent_speaker::TencentSpeakerProvider;
use openspeech_lib::asr::meeting::{
    MeetingAsrProvider, MeetingEvent, MeetingSessionConfig,
};
use openspeech_lib::secrets::{
    DictationCredentials, load_dictation_provider_credentials_for_rust,
};
use opus::{Channels, Decoder};
use serde::Deserialize;

const TARGET_RATE: u32 = 16_000;
const FRAME_MS: u64 = 40; // 腾讯说话人分离推荐节奏

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    // 简单初始化日志，让 tencent_speaker 模块的 [ws-debug] / [ws-in] 都打到 stderr。
    let _ = env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info"))
        .try_init();

    let provider = load_provider()?;
    println!("✅ provider id = {}", provider.id());
    println!("    app_id = {} (secret_id={}***)", provider.app_id, &provider.secret_id[..provider.secret_id.len().min(8)]);
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

// ─── 凭证装载 ─────────────────────────────────────────────────────
//
// 优先：从 settings.json + macOS Keychain 取（与 byok_e2e.rs 同一套）。
// 兜底：env vars TENCENT_APPID / TENCENT_SECRET_ID / TENCENT_SECRET_KEY。

#[derive(Debug, Deserialize)]
struct PersistRoot {
    root: PersistInner,
}

#[derive(Debug, Deserialize)]
struct PersistInner {
    dictation: DictationSlice,
}

#[derive(Debug, Deserialize)]
struct DictationSlice {
    #[serde(default, rename = "activeCustomProviderId")]
    active_custom_provider_id: Option<String>,
    #[serde(default, rename = "customProviders")]
    custom_providers: Vec<ProviderEntry>,
}

#[derive(Debug, Deserialize, Clone)]
struct ProviderEntry {
    id: String,
    #[serde(default)]
    vendor: String,
    #[serde(rename = "tencentAppId", default)]
    tencent_app_id: Option<String>,
}

fn settings_path() -> PathBuf {
    let home = std::env::var("HOME").expect("HOME env var must be set");
    PathBuf::from(home)
        .join("Library/Application Support/com.openspeech.app/settings.json")
}

fn load_provider() -> Result<TencentSpeakerProvider, Box<dyn std::error::Error>> {
    if let Ok(p) = TencentSpeakerProvider::from_env() {
        println!("🔐 凭证来源：环境变量 TENCENT_*");
        return Ok(p);
    }

    let path = settings_path();
    let raw = std::fs::read_to_string(&path).map_err(|e| {
        format!(
            "读不到 OpenSpeech 配置：{} ({e})\n\
             请先在 OpenSpeech 设置 → 听写 中添加并激活一个「自定义 → 腾讯」供应商，\n\
             或者 export TENCENT_APPID/SECRET_ID/SECRET_KEY 环境变量。",
            path.display()
        )
    })?;
    let parsed: PersistRoot = serde_json::from_str(&raw).map_err(|e| {
        format!("解析 settings.json 失败：{e}（路径 {}）", path.display())
    })?;
    let dictation = parsed.root.dictation;

    let active_id = dictation.active_custom_provider_id.clone();
    let active = dictation
        .custom_providers
        .iter()
        .find(|p| Some(&p.id) == active_id.as_ref() && p.vendor == "tencent")
        .cloned()
        .or_else(|| {
            dictation
                .custom_providers
                .iter()
                .find(|p| p.vendor == "tencent")
                .cloned()
        })
        .ok_or("settings.json 里没有 vendor='tencent' 的自定义供应商")?;

    let app_id = active
        .tencent_app_id
        .clone()
        .filter(|s| !s.is_empty())
        .ok_or("自定义供应商缺 tencentAppId")?;

    let creds = load_dictation_provider_credentials_for_rust(&active.id)
        .map_err(|e| format!("Keychain 读取失败：{e}"))?
        .ok_or_else(|| {
            format!(
                "Keychain 里没有 dictation_provider_{} 条目（service=com.openspeech.app）",
                active.id
            )
        })?;
    let (secret_id, secret_key) = match creds {
        DictationCredentials::Tencent {
            secret_id,
            secret_key,
        } => (secret_id, secret_key),
        DictationCredentials::Aliyun { .. } => {
            return Err("当前激活的自定义供应商是阿里，不是腾讯".into());
        }
    };
    println!(
        "🔐 凭证来源：Keychain (provider id = {})  app_id={}",
        active.id, app_id
    );
    Ok(TencentSpeakerProvider::new(app_id, secret_id, secret_key))
}
