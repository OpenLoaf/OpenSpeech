//! 会议的流式落盘：audio (OGG/Vorbis) + transcript (jsonl append-only)。
//!
//! 与 dictation 的「内存累积 + stop 一次性编码」不同——会议长达 1-2 小时，
//! 全内存 PCM 会吃几百 MB 内存且进程被杀即丢。流式让强退也能保住前面的数据：
//! BufWriter 内 page 没 flush 也只丢最后几 KB，OGG 是 page-based 容器，
//! ffmpeg 能读前面完整 page 的数据。

use std::fs::{File, OpenOptions};
use std::io::{BufWriter, Write};
use std::num::{NonZeroU8, NonZeroU32};
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Runtime};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoder, VorbisEncoderBuilder};

use crate::audio::is_valid_date_segment;
use crate::db;
use crate::meetings::SegmentPayload;

// audio fanout 已 downmix + resample 到 16k mono，writer 不再做转换。
const MEETING_SAMPLE_RATE: u32 = 16_000;
const MEETING_CHANNELS: u16 = 1;
// libvorbis 推荐每 block ~1024 frame；过小 setup 开销大，过大占内存。
const ENCODE_BLOCK_FRAMES: usize = 1024;
// 0.4 ≈ 96 kbps mono，人声完全够；100 分钟约 48 MB。
const OGG_QUALITY: f32 = 0.4;

fn validate_id_date(meeting_id: &str, date: &str) -> Result<(), String> {
    if !is_valid_date_segment(date) {
        return Err(format!("invalid date format (need yyyy-MM-dd): {date}"));
    }
    if meeting_id.is_empty()
        || meeting_id.contains('/')
        || meeting_id.contains('\\')
        || meeting_id.contains('\0')
        || meeting_id.contains("..")
    {
        return Err(format!("invalid meeting_id: {meeting_id}"));
    }
    Ok(())
}

pub struct MeetingAudioWriter {
    encoder: VorbisEncoder<BufWriter<File>>,
    planar_buf: Vec<Vec<f32>>,
    abs_path: PathBuf,
    rel_path: String,
    /// 不足 ENCODE_BLOCK_FRAMES 的 leftover，下一帧来了凑齐再 encode。
    pending: Vec<f32>,
    total_samples: u64,
}

// VorbisEncoder 内部持 `*mut vorbis_info` 这种 raw pointer 所以默认 !Send。
// 实际只在 worker 线程独占——meeting_start 创建后 move 给 worker，停止时随 worker
// 一起 drop，全程零跨线程共享。手动声明 Send 让 worker spawn 编译通过。
unsafe impl Send for MeetingAudioWriter {}

impl MeetingAudioWriter {
    pub fn create<R: Runtime>(
        app: &AppHandle<R>,
        meeting_id: &str,
        date: &str,
    ) -> Result<Self, String> {
        validate_id_date(meeting_id, date)?;

        let day_dir = db::ensure_recordings_dir(app)?.join(date);
        std::fs::create_dir_all(&day_dir)
            .map_err(|e| format!("mkdir {}: {e}", day_dir.display()))?;
        let abs_path = day_dir.join(format!("{meeting_id}.ogg"));
        let rel_path = format!("recordings/{date}/{meeting_id}.ogg");

        let sr = NonZeroU32::new(MEETING_SAMPLE_RATE).unwrap();
        let ch = NonZeroU8::new(MEETING_CHANNELS as u8).unwrap();
        let file = File::create(&abs_path)
            .map_err(|e| format!("create {}: {e}", abs_path.display()))?;
        let encoder = VorbisEncoderBuilder::new(sr, ch, BufWriter::new(file))
            .map_err(|e| format!("VorbisEncoderBuilder::new: {e}"))?
            .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
                target_quality: OGG_QUALITY,
            })
            .build()
            .map_err(|e| format!("VorbisEncoderBuilder::build: {e}"))?;

        log::info!("[meetings] audio writer opened: {}", abs_path.display());
        Ok(Self {
            encoder,
            planar_buf: vec![Vec::with_capacity(ENCODE_BLOCK_FRAMES)],
            abs_path,
            rel_path,
            pending: Vec::with_capacity(ENCODE_BLOCK_FRAMES * 2),
            total_samples: 0,
        })
    }

    /// 把 fanout 来的 16k mono PCM16 LE bytes 编码追加到 OGG。
    pub fn push_pcm16(&mut self, pcm16: &[u8]) -> Result<(), String> {
        let sample_count = pcm16.len() / 2;
        if sample_count == 0 {
            return Ok(());
        }
        self.total_samples += sample_count as u64;

        self.pending.reserve(sample_count);
        let mut i = 0;
        while i + 1 < pcm16.len() {
            let s = i16::from_le_bytes([pcm16[i], pcm16[i + 1]]) as f32 / i16::MAX as f32;
            self.pending.push(s);
            i += 2;
        }

        while self.pending.len() >= ENCODE_BLOCK_FRAMES {
            self.planar_buf[0].clear();
            self.planar_buf[0]
                .extend(self.pending.drain(..ENCODE_BLOCK_FRAMES));
            self.encoder
                .encode_audio_block(&self.planar_buf)
                .map_err(|e| format!("encode_audio_block: {e}"))?;
        }
        Ok(())
    }

    /// 把 pending 残块 flush 出去，调 finish() 写 EOS page，返回 history.audio_path。
    pub fn finalize(mut self) -> Result<String, String> {
        if !self.pending.is_empty() {
            self.planar_buf[0].clear();
            self.planar_buf[0].extend(self.pending.drain(..));
            self.encoder
                .encode_audio_block(&self.planar_buf)
                .map_err(|e| format!("encode_audio_block final: {e}"))?;
        }
        self.encoder
            .finish()
            .map_err(|e| format!("VorbisEncoder::finish: {e}"))?;
        log::info!(
            "[meetings] audio finalized: {} ({} samples ≈ {}ms)",
            self.abs_path.display(),
            self.total_samples,
            self.total_samples * 1000 / MEETING_SAMPLE_RATE as u64,
        );
        Ok(self.rel_path)
    }

    pub fn rel_path(&self) -> &str {
        &self.rel_path
    }
}

#[derive(Serialize)]
struct TranscriptLine<'a> {
    #[serde(rename = "sentenceId")]
    sentence_id: i64,
    #[serde(rename = "speakerId")]
    speaker_id: i32,
    text: &'a str,
    #[serde(rename = "startMs")]
    start_ms: u64,
    #[serde(rename = "endMs")]
    end_ms: u64,
}

pub struct MeetingTranscriptAppender {
    file: BufWriter<File>,
    abs_path: PathBuf,
    rel_path: String,
    /// 已写入的 final 段数，仅用于 finalize 日志。
    written: u32,
}

impl MeetingTranscriptAppender {
    pub fn create<R: Runtime>(
        app: &AppHandle<R>,
        meeting_id: &str,
        date: &str,
    ) -> Result<Self, String> {
        validate_id_date(meeting_id, date)?;

        let day_dir = db::ensure_recordings_dir(app)?.join(date);
        std::fs::create_dir_all(&day_dir)
            .map_err(|e| format!("mkdir {}: {e}", day_dir.display()))?;
        let abs_path = day_dir.join(format!("{meeting_id}.jsonl"));
        let rel_path = format!("recordings/{date}/{meeting_id}.jsonl");

        // truncate=true：同 meeting_id 重启视为新会议；会议恢复（resume）走另一个路径，
        // 不在这里 reopen 同一文件。
        let file = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(true)
            .open(&abs_path)
            .map_err(|e| format!("create {}: {e}", abs_path.display()))?;
        log::info!("[meetings] transcript writer opened: {}", abs_path.display());
        Ok(Self {
            file: BufWriter::new(file),
            abs_path,
            rel_path,
            written: 0,
        })
    }

    /// 每段 final 写一行 + flush——会议中途强退也保住已识别段。
    pub fn append_final(&mut self, seg: &SegmentPayload) -> Result<(), String> {
        let line = TranscriptLine {
            sentence_id: seg.sentence_id,
            speaker_id: seg.speaker_id,
            text: &seg.text,
            start_ms: seg.start_ms,
            end_ms: seg.end_ms,
        };
        let json = serde_json::to_string(&line).map_err(|e| format!("serialize: {e}"))?;
        writeln!(self.file, "{json}").map_err(|e| format!("write: {e}"))?;
        self.file.flush().map_err(|e| format!("flush: {e}"))?;
        self.written += 1;
        Ok(())
    }

    pub fn finalize(mut self) -> Result<String, String> {
        self.file.flush().map_err(|e| format!("flush final: {e}"))?;
        log::info!(
            "[meetings] transcript finalized: {} ({} segments)",
            self.abs_path.display(),
            self.written,
        );
        Ok(self.rel_path)
    }

    pub fn rel_path(&self) -> &str {
        &self.rel_path
    }
}
