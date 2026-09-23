//! RT-005（Qwen-Audio-3.1 streaming）事件流探针：把 16k mono PCM16 按 100ms 分帧喂进去，
//! finish 后打印全部事件，用来确认 V4 外壳下 Partial / Final / Closed 的形态与
//! sentence_id 规律，以及 vocabulary / context 是否生效。
//!
//! 用法：--pcm16-file <path> [--vocab 词1,词2] [--context 一句历史]

use std::collections::BTreeMap;
use std::fs;
use std::path::PathBuf;
use std::time::{Duration, Instant};

use openloaf_saas::v4_tools::{
    RealtimeAsrOlTlRt005ContextMessage, RealtimeAsrOlTlRt005Lang, RealtimeAsrOlTlRt005Params,
    RealtimeEvent,
};
use openloaf_saas::{SaaSClient, SaaSClientConfig};
use serde::Deserialize;

#[derive(Deserialize)]
struct DevSession {
    access_token: String,
    base_url: String,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();
    let mut pcm: Option<PathBuf> = None;
    let mut vocab: Option<BTreeMap<String, u8>> = None;
    let mut context: Option<Vec<RealtimeAsrOlTlRt005ContextMessage>> = None;
    let mut it = std::env::args().skip(1);
    while let Some(a) = it.next() {
        match a.as_str() {
            "--pcm16-file" => pcm = it.next().map(PathBuf::from),
            "--vocab" => {
                vocab = it
                    .next()
                    .map(|s| s.split(',').map(|w| (w.trim().to_string(), 4)).collect())
            }
            "--context" => {
                context = it
                    .next()
                    .map(|s| vec![RealtimeAsrOlTlRt005ContextMessage::user(s)])
            }
            other => return Err(format!("unknown arg {other}").into()),
        }
    }
    let pcm = fs::read(pcm.ok_or("missing --pcm16-file")?)?;
    let home = std::env::var("HOME")?;
    let sess: DevSession = serde_json::from_slice(&fs::read(
        PathBuf::from(home).join(".openspeech/dev_session.json"),
    )?)?;
    let client = SaaSClient::new(SaaSClientConfig {
        base_url: sess.base_url,
        access_token: Some(sess.access_token),
        ..Default::default()
    });
    let params = RealtimeAsrOlTlRt005Params {
        language_hints: Some(vec![RealtimeAsrOlTlRt005Lang::Zh]),
        vocabulary: vocab,
        context,
        ..Default::default()
    };
    let started = Instant::now();
    let s = client.tools_v4().realtime_asr_ol_tl_rt_005(&params)?;
    // 100ms = 3200 字节（16k × 2B），按真实时间节奏送，模拟麦克风
    for chunk in pcm.chunks(3200) {
        s.send_audio(chunk.to_vec())?;
        std::thread::sleep(Duration::from_millis(100));
        while let Ok(Some(ev)) = s.try_next_event() {
            print_ev(&ev, started);
        }
    }
    s.finish()?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline {
        match s.next_event_timeout(Duration::from_millis(200)) {
            Ok(Some(ev)) => {
                let closed = matches!(ev, RealtimeEvent::Closed { .. });
                print_ev(&ev, started);
                if closed {
                    break;
                }
            }
            Ok(None) => {}
            Err(e) => {
                println!("ERR {e}");
                break;
            }
        }
    }
    Ok(())
}

fn print_ev(ev: &RealtimeEvent, t0: Instant) {
    let ms = t0.elapsed().as_millis();
    match ev {
        RealtimeEvent::Partial {
            sentence_id, text, ..
        } => println!("{ms:>6}ms partial #{sentence_id} {text}"),
        RealtimeEvent::Final {
            sentence_id, text, ..
        } => println!("{ms:>6}ms FINAL   #{sentence_id} {text}"),
        other => println!("{ms:>6}ms {other:?}"),
    }
}
