// 会议 ASR provider 抽象层测试。
//
// 单元测试：parser 走 vendor 文档示例 JSON 的 round-trip。
// 集成测试：真实 WS 烟雾测试见 `examples/test_meeting_speaker_realtime.rs`，
// 需要 TENCENT_APPID/SECRET_ID/SECRET_KEY，CI 跑不到。

use super::provider::{MeetingEvent, MeetingSegment};
use super::tencent_speaker::{SUPPORTED_LANGUAGES, parse_frame};

fn one(events: Vec<MeetingEvent>) -> MeetingEvent {
    assert_eq!(events.len(), 1, "expected exactly one event, got {events:?}");
    events.into_iter().next().unwrap()
}

/// 文档示例：握手成功响应。
#[test]
fn parse_handshake_ok_emits_ready_with_voice_id() {
    let raw = r#"{"code":0,"message":"success","voice_id":"RnKu9FODFHK5FPpsrN"}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::Ready {
            session_id: Some("RnKu9FODFHK5FPpsrN".into()),
        }
    );
}

/// 文档实测响应：稳态结果含 speaker_id（sentences.sentence_list 包了一层数组）。
#[test]
fn parse_final_segment_with_speaker_id() {
    let raw = r#"{"code":0,"message":"success","voice_id":"vid","message_id":"vid_11_0","sentences":{"sentence_list":[{"sentence":"实时语音识别","sentence_type":1,"sentence_id":1,"speaker_id":0,"start_time":1200,"end_time":2850}]}}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::SegmentFinal(MeetingSegment {
            sentence_id: 1,
            speaker_id: 0,
            text: "实时语音识别".into(),
            start_ms: 1200,
            end_ms: 2850,
        })
    );
}

/// partial 阶段：sentence_type=0 → SegmentPartial。
#[test]
fn parse_partial_segment_with_pending_speaker() {
    let raw = r#"{"code":0,"sentences":{"sentence_list":[{"sentence":"你好","sentence_type":0,"sentence_id":2,"speaker_id":-1,"start_time":3000,"end_time":3300}]}}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::SegmentPartial(MeetingSegment {
            sentence_id: 2,
            speaker_id: -1,
            text: "你好".into(),
            start_ms: 3000,
            end_ms: 3300,
        })
    );
}

/// speaker_id 字段缺失时 default 为 -1，不抛错。
#[test]
fn parse_missing_speaker_id_defaults_to_unknown() {
    let raw = r#"{"code":0,"sentences":{"sentence_list":[{"sentence":"hello","sentence_type":1,"sentence_id":0,"start_time":0,"end_time":500}]}}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    let MeetingEvent::SegmentFinal(seg) = ev else {
        panic!("expected SegmentFinal");
    };
    assert_eq!(seg.speaker_id, -1);
}

/// 一帧带多句：每条 sentence 都要单独 emit，不能丢。
#[test]
fn parse_multi_sentences_in_one_frame() {
    let raw = r#"{"code":0,"sentences":{"sentence_list":[
        {"sentence":"第一句","sentence_type":1,"sentence_id":1,"speaker_id":0,"start_time":0,"end_time":1000},
        {"sentence":"第二句","sentence_type":0,"sentence_id":2,"speaker_id":-1,"start_time":1000,"end_time":1500}
    ]}}"#;
    let events = parse_frame(raw).expect("parse");
    assert_eq!(events.len(), 2);
    assert!(matches!(events[0], MeetingEvent::SegmentFinal(ref s) if s.sentence_id == 1 && s.text == "第一句"));
    assert!(matches!(events[1], MeetingEvent::SegmentPartial(ref s) if s.sentence_id == 2 && s.text == "第二句"));
}

/// final=1 → EndOfStream（与音频流是否还在 buffer 无关）。
#[test]
fn parse_final_flag_emits_end_of_stream() {
    let raw =
        r#"{"code":0,"message":"success","voice_id":"vid","message_id":"vid_241","final":1}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(ev, MeetingEvent::EndOfStream);
}

/// 鉴权失败：4002 → unauthenticated_byok。
#[test]
fn parse_4002_maps_to_unauthenticated_byok() {
    let raw = r#"{"code":4002,"message":"signature error","voice_id":"vid"}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::Error {
            code: "unauthenticated_byok".into(),
            message: "signature error".into(),
        }
    );
}

/// 余额耗尽：4004/4005 → insufficient_funds。
#[test]
fn parse_4004_4005_maps_to_insufficient_funds() {
    for code in [4004, 4005] {
        let raw = format!(r#"{{"code":{code},"message":"no funds"}}"#);
        let ev = one(parse_frame(&raw).expect("parse"));
        assert_eq!(
            ev,
            MeetingEvent::Error {
                code: "insufficient_funds".into(),
                message: "no funds".into(),
            }
        );
    }
}

/// 静默断连：4008 → idle_timeout（前端要触发"重连或自动续接"流程）。
#[test]
fn parse_4008_maps_to_idle_timeout() {
    let raw = r#"{"code":4008,"message":"15s idle"}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::Error {
            code: "idle_timeout".into(),
            message: "15s idle".into(),
        }
    );
}

/// 未知错误码 → tencent_<code>，前端可走兜底文案。
#[test]
fn parse_unknown_code_passes_through_with_prefix() {
    let raw = r#"{"code":9999,"message":"weird"}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::Error {
            code: "tencent_9999".into(),
            message: "weird".into(),
        }
    );
}

/// 4001 + message 含 engine_model_type → engine_not_authorized。
/// 账号没在腾讯云开通独立 SKU"实时说话人分离"时实际看到的报错原文。
#[test]
fn parse_4001_engine_not_supported_maps_to_engine_not_authorized() {
    let raw = r#"{"code":4001,"message":"参数不合法(Not support [engine_model_type: 16k_zh_en_speaker])","voice_id":"vid"}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::Error {
            code: "engine_not_authorized".into(),
            message: "参数不合法(Not support [engine_model_type: 16k_zh_en_speaker])".into(),
        }
    );
}

/// 4001 + 不含 engine_model_type → 走通用兜底 tencent_4001，避免误归类。
#[test]
fn parse_4001_other_param_keeps_generic_code() {
    let raw = r#"{"code":4001,"message":"参数不合法(invalid sign)","voice_id":"vid"}"#;
    let ev = one(parse_frame(raw).expect("parse"));
    assert_eq!(
        ev,
        MeetingEvent::Error {
            code: "tencent_4001".into(),
            message: "参数不合法(invalid sign)".into(),
        }
    );
}

/// 损坏 JSON 不应 panic。
#[test]
fn parse_malformed_returns_err() {
    assert!(parse_frame("not json at all").is_err());
}

/// SUPPORTED_LANGUAGES 至少包含中英两种，且不重复。
#[test]
fn supported_languages_contract() {
    assert!(SUPPORTED_LANGUAGES.contains(&"zh"));
    assert!(SUPPORTED_LANGUAGES.contains(&"en"));
    let mut sorted: Vec<&str> = SUPPORTED_LANGUAGES.to_vec();
    sorted.sort();
    sorted.dedup();
    assert_eq!(sorted.len(), SUPPORTED_LANGUAGES.len(), "no dup langs");
}

// ---------- OGG 音频解码冒烟（不打网络） ----------

/// 取 prompt-eval 仓里现成的 OGG（vorbis 编码）作为测试素材，
/// 验证我们能把它解码成 16k mono PCM16。这是会议 provider 上线前必须打通的链路：
/// 真实运行时 cpal 直接给 PCM；测试 / examples 走 OGG → PCM 这条路也得能跑。
///
/// 不依赖网络；只验证 lewton 能正确解出预期范围内的音频。
#[test]
fn decode_existing_ogg_to_pcm16() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .join(".claude/skills/openspeech-prompt-eval/cases/005-history-view-detail/audio.ogg");
    if !path.exists() {
        eprintln!("skipping: test fixture {} not found", path.display());
        return;
    }
    let pcm = decode_ogg_to_pcm16_mono_16k(&path).expect("decode ogg");
    // 5 秒以上的样本（项目里这些 case 录音通常 8s+）
    assert!(
        pcm.len() >= 16_000 * 2 * 3, // 至少 3 秒
        "decoded pcm too short: {} bytes",
        pcm.len()
    );
    // PCM16 mono 16k：长度必须是 2 字节对齐
    assert_eq!(pcm.len() % 2, 0);
}

/// 解码 Ogg/Opus 到 PCM16 LE / mono / 16k。
///
/// 项目录音默认 Ogg/Opus 16k mono，所以走最直接的 ogg(container) + opus(decoder) 组合。
/// 第一个 OGG packet 是 OpusHead（19 字节起始 "OpusHead"），第二个是 OpusTags
/// （"OpusTags"），从第三个起才是真正的音频。
pub(super) fn decode_ogg_to_pcm16_mono_16k(
    path: &std::path::Path,
) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    use ogg::PacketReader;
    use opus::{Channels, Decoder};

    let f = std::fs::File::open(path)?;
    let mut reader = PacketReader::new(f);

    let mut decoder: Option<Decoder> = None;
    let mut out_pcm: Vec<i16> = Vec::new();
    // 一帧最大 120ms @ 48k = 5760 sample；预留 6000 足够。
    let mut frame_buf = vec![0i16; 6000];

    let mut packet_idx = 0usize;
    while let Some(packet) = reader.read_packet()? {
        let data = packet.data;
        match packet_idx {
            0 => {
                // OpusHead
                if data.len() < 19 || &data[0..8] != b"OpusHead" {
                    return Err("not an Ogg/Opus stream".into());
                }
                let channels_u8 = data[9];
                let input_sample_rate = u32::from_le_bytes([data[12], data[13], data[14], data[15]]);
                if channels_u8 != 1 {
                    return Err(format!("expected mono, got {} channels", channels_u8).into());
                }
                if input_sample_rate != 16_000 {
                    eprintln!(
                        "warning: source rate {} Hz; opus decoder always outputs 48k unless we ask 16k",
                        input_sample_rate
                    );
                }
                // libopus 内置重采样器——直接要 16k 输出。
                decoder = Some(Decoder::new(16_000, Channels::Mono)?);
            }
            1 => {
                // OpusTags：忽略
            }
            _ => {
                let dec = decoder.as_mut().ok_or("decoder not initialized")?;
                let n = dec.decode(&data, &mut frame_buf, false)?;
                out_pcm.extend_from_slice(&frame_buf[..n]);
            }
        }
        packet_idx += 1;
    }

    let mut bytes = Vec::with_capacity(out_pcm.len() * 2);
    for s in out_pcm {
        bytes.extend_from_slice(&s.to_le_bytes());
    }
    Ok(bytes)
}
