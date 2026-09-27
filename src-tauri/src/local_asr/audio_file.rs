// 录音文件 → 16kHz 单声道 f32，供本地引擎整段识别（历史重试 / 文件转写路径）。
//
// 落盘格式见 audio/mod.rs：新录音是设备原生采样率 / 声道的 OGG Vorbis，老录音是 WAV。
// 重采样用线性插值，与实时链路 push_to_stt_pcm16 同算法，保证同一段录音走实时和走
// 文件时模型看到的输入一致。

use std::fs::File;
use std::io::BufReader;
use std::path::Path;

use super::engine::SAMPLE_RATE;
use super::error::LocalAsrError;

pub fn load_mono_16k(path: &Path) -> Result<Vec<f32>, LocalAsrError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase);
    let (mono, rate) = match ext.as_deref() {
        Some("ogg") => decode_ogg(path)?,
        Some("wav") => decode_wav(path)?,
        other => {
            return Err(LocalAsrError::Decode(format!(
                "unsupported recording extension {other:?}"
            )));
        }
    };
    Ok(resample_linear(&mono, rate, SAMPLE_RATE))
}

fn open(path: &Path) -> Result<BufReader<File>, LocalAsrError> {
    File::open(path)
        .map(BufReader::new)
        .map_err(|e| LocalAsrError::Decode(format!("open {}: {e}", path.display())))
}

fn decode_ogg(path: &Path) -> Result<(Vec<f32>, u32), LocalAsrError> {
    let mut dec = vorbis_rs::VorbisDecoder::new(open(path)?)
        .map_err(|e| LocalAsrError::Decode(format!("vorbis open: {e}")))?;
    let rate = dec.sampling_frequency().get();
    let mut mono = Vec::new();
    while let Some(block) = dec
        .decode_audio_block()
        .map_err(|e| LocalAsrError::Decode(format!("vorbis decode: {e}")))?
    {
        let channels = block.samples();
        let Some(first) = channels.first() else {
            continue;
        };
        let n = channels.len() as f32;
        for i in 0..first.len() {
            mono.push(channels.iter().map(|c| c[i]).sum::<f32>() / n);
        }
    }
    Ok((mono, rate))
}

fn decode_wav(path: &Path) -> Result<(Vec<f32>, u32), LocalAsrError> {
    let mut reader = hound::WavReader::new(open(path)?)
        .map_err(|e| LocalAsrError::Decode(format!("wav open: {e}")))?;
    let spec = reader.spec();
    let ch = spec.channels.max(1) as usize;
    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<Result<_, _>>()
            .map_err(|e| LocalAsrError::Decode(format!("wav read: {e}")))?,
        hound::SampleFormat::Int => {
            let scale = (1i64 << (spec.bits_per_sample.saturating_sub(1))) as f32;
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 / scale))
                .collect::<Result<_, _>>()
                .map_err(|e| LocalAsrError::Decode(format!("wav read: {e}")))?
        }
    };
    let mono = interleaved
        .chunks(ch)
        .map(|f| f.iter().sum::<f32>() / f.len() as f32)
        .collect();
    Ok((mono, spec.sample_rate))
}

fn resample_linear(src: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || src.is_empty() {
        return src.to_vec();
    }
    let ratio = from as f64 / to as f64;
    let dst_len = (src.len() as f64 / ratio).floor() as usize;
    let last = src.len() - 1;
    (0..dst_len)
        .map(|i| {
            let pos = i as f64 * ratio;
            let lo = pos.floor() as usize;
            let hi = (lo + 1).min(last);
            let frac = pos - lo as f64;
            (src[lo] as f64 * (1.0 - frac) + src[hi] as f64 * frac) as f32
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resample_48k_to_16k_keeps_duration() {
        let one_sec = vec![0.25f32; 48_000];
        let out = resample_linear(&one_sec, 48_000, 16_000);
        assert_eq!(out.len(), 16_000);
        assert!(out.iter().all(|&v| (v - 0.25).abs() < 1e-6));
    }

    #[test]
    fn wav_stereo_int16_is_downmixed() {
        let path = std::env::temp_dir().join(format!("os-local-asr-{}.wav", uuid::Uuid::new_v4()));
        let spec = hound::WavSpec {
            channels: 2,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(&path, spec).unwrap();
        for _ in 0..1600 {
            w.write_sample(i16::MAX / 2).unwrap();
            w.write_sample(0i16).unwrap();
        }
        w.finalize().unwrap();
        let out = load_mono_16k(&path).unwrap();
        std::fs::remove_file(&path).unwrap();
        assert_eq!(out.len(), 1600);
        assert!((out[0] - 0.25).abs() < 1e-3);
    }
}
