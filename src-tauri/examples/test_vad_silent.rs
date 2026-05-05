// 在某段 16k mono i16 PCM 上跑现有的 VAD + RMS 二级能量门，验证"全是底噪"的录音
// 是否会被裁剪逻辑判定为 Empty。
//
// usage: cargo run --example test_vad_silent -- /tmp/silent_test.pcm

use std::env;
use std::fs;

const VAD_FRAME_SAMPLES: usize = 480;
const VAD_FRAME_MIN_RMS: f32 = 0.01;

fn main() {
    let path = env::args().nth(1).expect("need pcm path");
    let bytes = fs::read(&path).expect("read");
    let mut samples_i16 = Vec::with_capacity(bytes.len() / 2);
    for chunk in bytes.chunks_exact(2) {
        samples_i16.push(i16::from_le_bytes([chunk[0], chunk[1]]));
    }
    let samples_f32: Vec<f32> = samples_i16
        .iter()
        .map(|s| *s as f32 / i16::MAX as f32)
        .collect();

    let mut vad = webrtc_vad::Vad::new_with_rate_and_mode(
        webrtc_vad::SampleRate::Rate16kHz,
        webrtc_vad::VadMode::Aggressive,
    );

    let frame_count = samples_i16.len() / VAD_FRAME_SAMPLES;
    let mut raw_voice = 0usize;
    let mut gated_voice = 0usize;
    let mut max_rms = 0.0f32;
    let mut max_peak = 0.0f32;

    for i in 0..frame_count {
        let start = i * VAD_FRAME_SAMPLES;
        let frame_i16 = &samples_i16[start..start + VAD_FRAME_SAMPLES];
        let frame_f32 = &samples_f32[start..start + VAD_FRAME_SAMPLES];

        let mut sumsq = 0.0f64;
        let mut peak = 0.0f32;
        for s in frame_f32 {
            sumsq += (*s as f64) * (*s as f64);
            let a = s.abs();
            if a > peak {
                peak = a;
            }
        }
        let rms = (sumsq / frame_f32.len() as f64).sqrt() as f32;
        if rms > max_rms {
            max_rms = rms;
        }
        if peak > max_peak {
            max_peak = peak;
        }

        let is_voice = matches!(vad.is_voice_segment(frame_i16), Ok(true));
        if is_voice {
            raw_voice += 1;
            if rms >= VAD_FRAME_MIN_RMS {
                gated_voice += 1;
            }
        }
    }

    println!(
        "frames={} duration_ms={} raw_voice={} gated_voice={} max_rms={:.5} max_peak={:.5}",
        frame_count,
        frame_count * 30,
        raw_voice,
        gated_voice,
        max_rms,
        max_peak
    );
    println!(
        "raw_voice_ms={} gated_voice_ms={}",
        raw_voice * 30,
        gated_voice * 30
    );
    println!(
        "max_rms_dBFS={:.1} max_peak_dBFS={:.1}",
        20.0 * max_rms.log10(),
        20.0 * max_peak.log10()
    );
}
