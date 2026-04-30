// 麦克风电平监控 + 录音 PCM 采集
//
// 职责范围：
// 1. 采集麦克风 peak 电平，~20Hz emit 到前端供 overlay 波形 + 设置页电平表消费。
// 2. 录音会话（task #13 的第一步）：同一个 stream callback 内，在激活 session
//    时把 PCM 归一化为 f32 [-1, 1] 累积到 Zeroizing<Vec<f32>>；
//    `audio_recording_stop` 时编码为 OGG Vorbis 落到 app_data_dir/recordings/<id>.ogg。
//    STT 和文本注入尚未接入；stop 返回 { audio_path, duration_ms, sample_rate,
//    channels } 供前端写 history 记录。
//    历史落盘的 .wav 文件继续支持读取 / 导出 / 重转写——只是不再新写。
//
// 线程模型：cpal::Stream 是 !Send，生命周期必须和 audio callback 在同一线程。
// 因此我们把整个"打开设备 + build_input_stream + play + tick emit"都塞进一个
// 专用 std::thread。主线程通过 mpsc::Sender 发 stop 信号，专用线程收到后 drop
// stream 退出。peak 用 AtomicU32（f32 的 bits）在 audio callback 与 emit tick
// 之间共享 — audio callback 不能 block，atomics 是唯一合理的同步手段。
//
// 录音 session 与 stream 解耦：session 只是"callback 是否 push PCM 的开关"。
// start_recording 前必须保证 stream 正在跑（即 ref_count > 0，由前端 startMic
// 保证）；stop_recording 把 session 取走后 stream 可以继续跑或停，OGG 编码由
// take 出来的 samples 独立完成。
//
// 关于 callback 内持锁：push 样本用 try_lock，失败就丢一帧（几 ms 音频）——
// 正常情况下只有 stop_recording 会在 callback 之外 lock 一次，竞争极低；丢的
// 这一帧对 STT 识别率影响忽略不计，远比阻塞 audio callback 可接受。
//
// 引用计数：start/stop 可能同时被多处调用（录音流程 + 设置页实时电平）。用
// ref_count 保证：只要还有一处需要电平，stream 就保持运行；切换设备时强制
// restart（保持 ref_count）。

use std::{
    fs::File,
    io::BufWriter,
    num::{NonZeroU32, NonZeroU8},
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU32, AtomicU64, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, ipc::Response};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};
use zeroize::Zeroizing;

use crate::db;

// cpal 0.17 把 DeviceTrait::name() 标记为 deprecated，推荐改用 description().name()。
// 默认实现等价（self.description().map(|d| d.name().to_string())），所以替换后
// 设备匹配 key（settings.inputDevice 持久化值）保持不变。
fn device_label<D: DeviceTrait>(d: &D) -> Option<String> {
    d.description().ok().map(|desc| desc.name().to_string())
}

const AUDIO_LEVEL_EVENT: &str = "openspeech://audio-level";
const TICK_MS: u64 = 50; // 20Hz emit
const PEAK_GAIN: f32 = 2.8; // 普通对话音量（-25 dBFS 左右）就推到波形 60%+
// 噪声门：低于该幅值的窗口直接送 0，避免空调 / 键盘底噪把波形顶起来。
// 0.015 ≈ -36 dBFS，安静室内底噪刚好被压住，正常说话（哪怕轻声）能干净越过。
const NOISE_GATE: f32 = 0.015;

// 波形显示带通滤波：300Hz HP + 3400Hz LP（电话语音频段），用于压住车噪 / 风噪 /
// 键盘脆响，让用户在嘈杂环境里仍能从波形看出自己说话的节奏。仅作用于电平显示，
// 录音文件 + 喂给 STT 的 PCM 都走原始全频段，不影响识别质量。
const VOICE_HP_HZ: f32 = 300.0;
const VOICE_LP_HZ: f32 = 3400.0;
const VOICE_FILTER_Q: f32 = 0.707;

// 波形显示 VAD（webrtc-vad / fvad）：在带通滤波之上再加"是不是有人说话"判断，
// 关掉电视 / 音乐 / 远处 babble 这类与人声同频段、滤波器无能为力的伪人声。
// 仅影响 peak emit；录音 + STT 不经过这一层。
const VAD_SAMPLE_RATE: u32 = 16_000;
// 30ms 帧 @16k = 480 sample；webrtc-vad 接受 10/20/30ms，30ms 在准确率与延迟间最稳。
const VAD_FRAME_SAMPLES: usize = (VAD_SAMPLE_RATE as usize) * 30 / 1000;
// 检测到 voice 后保留多久不归零——避免"词与词之间的几十 ms 静默"把波形跌到 0。
const VAD_VOICE_HANG_MS: u64 = 200;
// OGG Vorbis 输出：采样率 / 声道跟随采集配置，不做 resample / 下混——这两步
// 留给 STT 集成阶段（大多数 STT 服务上传前自己会做）。
// 质量取 0.4（≈ 96 kbps mono），人声完全够用且文件 ~1/10 WAV 大小。
const OGG_VORBIS_QUALITY: f32 = 0.4;
// 每次喂给 Vorbis 编码器的 frame 数（per-channel 样本）。libvorbis 文档建议
// "1024 是合理的选择"——块过小 setup 开销大，过大占内存（>2^18 时显著退化）。
const OGG_ENCODE_BLOCK_FRAMES: usize = 1024;

// 录音会话：归一化为 f32 [-1, 1] 的交错样本（多声道时 LRLRLR... 排列）。
// Zeroizing<Vec<f32>> 保证 drop 时自动清零内存，符合 docs/voice-input-flow.md
// 的"内存音频必须 zeroize"条款。
struct RecordingSession {
    id: String,
    started_at: Instant,
    sample_rate: u32,
    channels: u16,
    samples: Zeroizing<Vec<f32>>,
}

fn recording_slot() -> &'static Mutex<Option<RecordingSession>> {
    static SLOT: OnceLock<Mutex<Option<RecordingSession>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 当前 stream 的 (sample_rate, channels)——audio 线程打开 stream 后写入，
/// stream 关闭前清空。start_recording 读它来决定 session 的 OGG 参数。
fn stream_info() -> &'static Mutex<Option<(u32, u16)>> {
    static INFO: OnceLock<Mutex<Option<(u32, u16)>>> = OnceLock::new();
    INFO.get_or_init(|| Mutex::new(None))
}

/// 对外暴露的只读 snapshot：stt 模块启动 realtime ASR 时需要把 sample_rate /
/// channels 塞进 send_start 的 config，避免前端再多一次 invoke 往返。未开流
/// 时返回 None——调用方据此拒绝请求。
pub fn current_stream_info() -> Option<(u32, u16)> {
    stream_info().lock().ok().and_then(|g| *g)
}

/// callback 内调用：若当前有激活 session 则追加归一化 f32 样本；try_lock
/// 失败就丢这一帧（对 STT 质量影响可忽略，远比阻塞 audio callback 可接受）。
fn push_samples(data: &[f32]) {
    let Ok(mut guard) = recording_slot().try_lock() else {
        return;
    };
    if let Some(s) = guard.as_mut() {
        s.samples.extend_from_slice(data);
    }
}

/// 服务端 realtimeAsr 固定按 16kHz pcm16 解码——任何源采样率必须先重采样。
const STT_TARGET_SAMPLE_RATE: u32 = 16_000;

/// callback 内调用：mono 下混 → 重采样到 16kHz → PCM16 LE bytes，丢给
/// `stt::try_send_audio_pcm16`。stt 内部走 mpsc 进 worker 线程，跟 audio
/// callback 解耦（SDK 的 `RealtimeSession` 自身不 Sync，不能跨线程共享）。
///
/// 多声道按算术平均下混；重采样用最朴素的线性插值（单帧无状态，会在 chunk
/// 边界丢 0~1 个采样 ≈ <0.1ms，对识别率影响可忽略）。无激活 session 时
/// `try_send_audio_pcm16` 内部 try_lock 短路返回，零开销。
fn push_to_stt_pcm16(data: &[f32], channels: u16, src_rate: u32) {
    let ch = channels.max(1) as usize;
    let frames = data.len() / ch;
    if frames == 0 {
        return;
    }

    // 1) mono downmix
    let mono: Vec<f32> = if ch == 1 {
        data[..frames].to_vec()
    } else {
        let mut out = Vec::with_capacity(frames);
        for f in 0..frames {
            let start = f * ch;
            let mut sum = 0.0f32;
            for c in 0..ch {
                sum += data[start + c];
            }
            out.push(sum / ch as f32);
        }
        out
    };

    // 2) 线性插值重采样到 16k（src_rate == 16k 时跳过）
    let resampled: Vec<f32> = if src_rate == STT_TARGET_SAMPLE_RATE {
        mono
    } else {
        let ratio = src_rate as f64 / STT_TARGET_SAMPLE_RATE as f64;
        let dst_len = (mono.len() as f64 / ratio).floor() as usize;
        if dst_len == 0 {
            return;
        }
        let last = mono.len() - 1;
        let mut out = Vec::with_capacity(dst_len);
        for i in 0..dst_len {
            let src_idx = i as f64 * ratio;
            let lo = src_idx.floor() as usize;
            let hi = (lo + 1).min(last);
            let frac = src_idx - lo as f64;
            let s = mono[lo] as f64 * (1.0 - frac) + mono[hi] as f64 * frac;
            out.push(s as f32);
        }
        out
    };

    // 3) f32 → i16 LE bytes
    let mut bytes = Vec::with_capacity(resampled.len() * 2);
    for s in resampled {
        let v = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        bytes.extend_from_slice(&v.to_le_bytes());
    }
    crate::stt::try_send_audio_pcm16(bytes);
}

// RBJ Cookbook biquad，Direct Form II Transposed。系数构造时已除 a0，process 内
// 仅 5 mul + 4 add，每 callback 几百样本对 audio 线程毫无压力。
#[derive(Clone, Copy)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn highpass(sample_rate: f32, fc: f32, q: f32) -> Self {
        let omega = 2.0 * std::f32::consts::PI * fc / sample_rate;
        let (sin_o, cos_o) = (omega.sin(), omega.cos());
        let alpha = sin_o / (2.0 * q);
        let a0 = 1.0 + alpha;
        let one_plus_cos = 1.0 + cos_o;
        Self {
            b0: one_plus_cos * 0.5 / a0,
            b1: -one_plus_cos / a0,
            b2: one_plus_cos * 0.5 / a0,
            a1: -2.0 * cos_o / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn lowpass(sample_rate: f32, fc: f32, q: f32) -> Self {
        let omega = 2.0 * std::f32::consts::PI * fc / sample_rate;
        let (sin_o, cos_o) = (omega.sin(), omega.cos());
        let alpha = sin_o / (2.0 * q);
        let a0 = 1.0 + alpha;
        let one_minus_cos = 1.0 - cos_o;
        Self {
            b0: one_minus_cos * 0.5 / a0,
            b1: one_minus_cos / a0,
            b2: one_minus_cos * 0.5 / a0,
            a1: -2.0 * cos_o / a0,
            a2: (1.0 - alpha) / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

#[derive(Clone, Copy)]
struct VoiceBandFilter {
    hp: Biquad,
    lp: Biquad,
}

impl VoiceBandFilter {
    fn new(sample_rate: f32) -> Self {
        // Nyquist 限制：超过 sr/2 的截止会让系数发散；极端 8kHz 设备时把 LP 压到 sr*0.45
        let lp_fc = VOICE_LP_HZ.min(sample_rate * 0.45);
        let hp_fc = VOICE_HP_HZ.min(lp_fc * 0.5);
        Self {
            hp: Biquad::highpass(sample_rate, hp_fc, VOICE_FILTER_Q),
            lp: Biquad::lowpass(sample_rate, lp_fc, VOICE_FILTER_Q),
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        self.lp.process(self.hp.process(x))
    }
}

// 仅取第一通道喂滤波器（多声道下混再滤波只为更准确的 peak 不值得，立体声麦左右
// 都有人声）。filter 状态跨 callback 累积，调用方持有 mut 引用。
fn voice_band_peak(data: &[f32], channels: u16, filter: &mut VoiceBandFilter) -> f32 {
    let step = channels.max(1) as usize;
    let mut p = 0f32;
    let mut i = 0;
    while i < data.len() {
        let y = filter.process(data[i]).abs();
        if y > p {
            p = y;
        }
        i += step;
    }
    p
}

// 包住 fvad 实例 + 16k mono i16 累积 buffer。callback 内独占使用，跨线程移交
// 仅发生一次（spawn → audio thread），故标 Send 安全。
struct VadGate {
    vad: webrtc_vad::Vad,
    buf: Vec<i16>,
}

unsafe impl Send for VadGate {}

impl VadGate {
    fn new() -> Self {
        Self {
            // Aggressive (mode 2)：嘈杂环境下减少误报；不用 VeryAggressive 否则
            // 轻声 / 普通对话起始 50-100ms 容易被吞。
            vad: webrtc_vad::Vad::new_with_rate_and_mode(
                webrtc_vad::SampleRate::Rate16kHz,
                webrtc_vad::VadMode::Aggressive,
            ),
            buf: Vec::with_capacity(VAD_FRAME_SAMPLES * 2),
        }
    }

    /// 把原始 callback 数据转成 16k mono i16 累积，每凑够 30ms 帧喂一次 fvad；
    /// 检测到 voice 时把当前 elapsed_ms 写入 atomic，emit tick 据此 hang。
    fn feed(
        &mut self,
        data: &[f32],
        channels: u16,
        src_rate: u32,
        stream_start: Instant,
        voice_marker: &AtomicU64,
    ) {
        let ch = channels.max(1) as usize;
        let frames = data.len() / ch;
        if frames == 0 {
            return;
        }

        let mono: Vec<f32> = if ch == 1 {
            data[..frames].to_vec()
        } else {
            let mut out = Vec::with_capacity(frames);
            for f in 0..frames {
                let start = f * ch;
                let mut sum = 0.0f32;
                for c in 0..ch {
                    sum += data[start + c];
                }
                out.push(sum / ch as f32);
            }
            out
        };

        let pcm: Vec<f32> = if src_rate == VAD_SAMPLE_RATE {
            mono
        } else {
            let ratio = src_rate as f64 / VAD_SAMPLE_RATE as f64;
            let dst_len = (mono.len() as f64 / ratio).floor() as usize;
            if dst_len == 0 {
                return;
            }
            let last = mono.len() - 1;
            let mut out = Vec::with_capacity(dst_len);
            for i in 0..dst_len {
                let src_idx = i as f64 * ratio;
                let lo = src_idx.floor() as usize;
                let hi = (lo + 1).min(last);
                let frac = src_idx - lo as f64;
                out.push((mono[lo] as f64 * (1.0 - frac) + mono[hi] as f64 * frac) as f32);
            }
            out
        };

        for s in pcm {
            self.buf.push((s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16);
        }

        while self.buf.len() >= VAD_FRAME_SAMPLES {
            let frame: Vec<i16> = self.buf.drain(..VAD_FRAME_SAMPLES).collect();
            if let Ok(true) = self.vad.is_voice_segment(&frame) {
                let elapsed_ms = stream_start.elapsed().as_millis() as u64;
                voice_marker.store(elapsed_ms, Ordering::Relaxed);
            }
        }
    }
}

struct MonitorState {
    ref_count: usize,
    stop_tx: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
    current_device: Option<String>,
}

impl MonitorState {
    const fn new() -> Self {
        Self {
            ref_count: 0,
            stop_tx: None,
            thread: None,
            current_device: None,
        }
    }
}

fn monitor() -> &'static Mutex<MonitorState> {
    static MONITOR: OnceLock<Mutex<MonitorState>> = OnceLock::new();
    MONITOR.get_or_init(|| Mutex::new(MonitorState::new()))
}

#[derive(Debug, Clone, Serialize)]
pub struct InputDeviceInfo {
    pub name: String,
    pub is_default: bool,
}

#[tauri::command]
pub fn audio_list_input_devices() -> Vec<InputDeviceInfo> {
    let host = cpal::default_host();
    let default_name = host.default_input_device().and_then(|d| device_label(&d));
    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            if let Some(name) = device_label(&d) {
                let is_default = default_name.as_deref() == Some(name.as_str());
                out.push(InputDeviceInfo { name, is_default });
            }
        }
    }
    out
}

/// audio 线程把 stream 起来 / 起失败的结果回报给 `start()`，让命令真正同步。
/// 历史上 spawn 完就返回，调用方 300ms 后调 stt_start 经常撞上 stream_info 还没
/// 写入（macOS 冷启动 cpal init ≈ 1s），命中 "audio stream not running"。
type ReadyTx = mpsc::SyncSender<Result<(), String>>;

fn spawn_monitor_thread<R: Runtime>(
    app: AppHandle<R>,
    device_name: Option<String>,
    ready_tx: ReadyTx,
) -> (mpsc::Sender<()>, JoinHandle<()>) {
    let (stop_tx, stop_rx) = mpsc::channel::<()>();
    let peak_bits = Arc::new(AtomicU32::new(0));
    let peak_cb = peak_bits.clone();
    let peak_tick = peak_bits.clone();
    // VAD 决策的最近 voice 时间戳（自 stream_start 起的毫秒数）；0 表示从未检测到。
    let voice_marker = Arc::new(AtomicU64::new(0));
    let voice_marker_tick = voice_marker.clone();
    // VAD callback 与 emit tick 共享同一时间参考。在 spawn 闭包入口取一次。
    let stream_start = Instant::now();

    let th = thread::Builder::new()
        .name("openspeech-audio".into())
        .spawn(move || {
            let host = cpal::default_host();
            let device = match device_name.as_deref() {
                Some(wanted) => host
                    .input_devices()
                    .ok()
                    .and_then(|it| {
                        it.into_iter()
                            .find(|d| device_label(d).as_deref() == Some(wanted))
                    })
                    .or_else(|| host.default_input_device()),
                None => host.default_input_device(),
            };
            let Some(device) = device else {
                log::error!("[audio] no input device available (host has no default input)");
                let _ = ready_tx.send(Err("no input device available".into()));
                return;
            };
            log::info!(
                "[audio] selected device={:?} (requested={:?})",
                device_label(&device),
                device_name
            );

            let supported = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    log::error!(
                        "[audio] default_input_config failed for device {:?}: {e}",
                        device_label(&device)
                    );
                    let _ = ready_tx.send(Err(format!("default_input_config: {e}")));
                    return;
                }
            };
            let sample_format = supported.sample_format();
            let stream_config: cpal::StreamConfig = supported.into();
            // channels / sample_rate 需要进 audio callback 做 PCM16 下混 + 重采样
            // 到 16k；u16 / u32 都是 Copy，move 闭包按值捕获即可。
            let cb_channels = stream_config.channels;
            let cb_sample_rate = stream_config.sample_rate;

            let err_fn = |e: cpal::StreamError| log::warn!("[audio] stream error: {e}");

            let stream_result = match sample_format {
                cpal::SampleFormat::F32 => {
                    let mut filter = VoiceBandFilter::new(cb_sample_rate as f32);
                    let mut vad_gate = VadGate::new();
                    let voice_marker_cb = voice_marker.clone();
                    device.build_input_stream(
                        &stream_config,
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            let p = voice_band_peak(data, cb_channels, &mut filter);
                            peak_cb.store(p.to_bits(), Ordering::Relaxed);
                            push_samples(data);
                            push_to_stt_pcm16(data, cb_channels, cb_sample_rate);
                            vad_gate.feed(
                                data,
                                cb_channels,
                                cb_sample_rate,
                                stream_start,
                                &voice_marker_cb,
                            );
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::I16 => {
                    let mut filter = VoiceBandFilter::new(cb_sample_rate as f32);
                    let mut vad_gate = VadGate::new();
                    let voice_marker_cb = voice_marker.clone();
                    device.build_input_stream(
                        &stream_config,
                        move |data: &[i16], _: &cpal::InputCallbackInfo| {
                            let scale = 1.0 / i16::MAX as f32;
                            let mut p = 0f32;
                            // 归一化一次，同时喂给 peak / 录音 / STT / VAD——避免多次
                            // i16→f32 转换，降低 callback 里的 CPU 峰值。
                            let mut buf: [f32; 1024] = [0.0; 1024];
                            for chunk in data.chunks(buf.len()) {
                                for (i, s) in chunk.iter().enumerate() {
                                    buf[i] = *s as f32 * scale;
                                }
                                let slice = &buf[..chunk.len()];
                                let chunk_peak = voice_band_peak(slice, cb_channels, &mut filter);
                                if chunk_peak > p {
                                    p = chunk_peak;
                                }
                                push_samples(slice);
                                push_to_stt_pcm16(slice, cb_channels, cb_sample_rate);
                                vad_gate.feed(
                                    slice,
                                    cb_channels,
                                    cb_sample_rate,
                                    stream_start,
                                    &voice_marker_cb,
                                );
                            }
                            peak_cb.store(p.to_bits(), Ordering::Relaxed);
                        },
                        err_fn,
                        None,
                    )
                }
                cpal::SampleFormat::U16 => {
                    let mut filter = VoiceBandFilter::new(cb_sample_rate as f32);
                    let mut vad_gate = VadGate::new();
                    let voice_marker_cb = voice_marker.clone();
                    device.build_input_stream(
                        &stream_config,
                        move |data: &[u16], _: &cpal::InputCallbackInfo| {
                            let mut p = 0f32;
                            let mut buf: [f32; 1024] = [0.0; 1024];
                            for chunk in data.chunks(buf.len()) {
                                for (i, s) in chunk.iter().enumerate() {
                                    buf[i] = (*s as f32 - 32768.0) / 32768.0;
                                }
                                let slice = &buf[..chunk.len()];
                                let chunk_peak = voice_band_peak(slice, cb_channels, &mut filter);
                                if chunk_peak > p {
                                    p = chunk_peak;
                                }
                                push_samples(slice);
                                push_to_stt_pcm16(slice, cb_channels, cb_sample_rate);
                                vad_gate.feed(
                                    slice,
                                    cb_channels,
                                    cb_sample_rate,
                                    stream_start,
                                    &voice_marker_cb,
                                );
                            }
                            peak_cb.store(p.to_bits(), Ordering::Relaxed);
                        },
                        err_fn,
                        None,
                    )
                }
                other => {
                    log::error!("[audio] unsupported sample format: {other:?}");
                    let _ = ready_tx.send(Err(format!("unsupported sample format: {other:?}")));
                    return;
                }
            };

            let stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    log::error!(
                        "[audio] build_input_stream failed for device {:?} sr={}Hz ch={}: {e}",
                        device_label(&device),
                        stream_config.sample_rate,
                        stream_config.channels
                    );
                    let _ = ready_tx.send(Err(format!("build_input_stream: {e}")));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                log::error!("[audio] stream.play failed: {e}");
                let _ = ready_tx.send(Err(format!("stream.play: {e}")));
                return;
            }
            log::info!(
                "[audio] stream started (device={:?}, sr={}Hz, ch={}, fmt={:?})",
                device_label(&device),
                stream_config.sample_rate,
                stream_config.channels,
                sample_format
            );
            // stream_info 必须在 ready_tx 通知之前写入——start() 同步返回后调用方
            // （stt_start_impl）会立刻读 current_stream_info()，这里要保证 happens-before。
            {
                let mut g = stream_info().lock().expect("stream_info poisoned");
                *g = Some((stream_config.sample_rate, stream_config.channels));
            }
            let _ = ready_tx.send(Ok(()));

            loop {
                match stop_rx.recv_timeout(Duration::from_millis(TICK_MS)) {
                    Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let bits = peak_tick.swap(0, Ordering::Relaxed);
                        let raw_peak = f32::from_bits(bits);
                        // VAD gate：距离最近一次 voice 检测超过 hang 窗口就强制 0；
                        // last_voice_ms == 0 表示从未检测到（stream 刚起 / 全程静音）。
                        let now_ms = stream_start.elapsed().as_millis() as u64;
                        let last_voice_ms = voice_marker_tick.load(Ordering::Relaxed);
                        let voice_active = last_voice_ms > 0
                            && now_ms.saturating_sub(last_voice_ms) <= VAD_VOICE_HANG_MS;
                        let raw = if voice_active { raw_peak } else { 0.0 };
                        // gate 之后把 [GATE, 1] 重新铺到 [0, 1]，避免门刚开时电平骤跳。
                        let gated = if raw < NOISE_GATE {
                            0.0
                        } else {
                            (raw - NOISE_GATE) / (1.0 - NOISE_GATE)
                        };
                        let peak = (gated * PEAK_GAIN).clamp(0.0, 1.0);
                        let _ = app.emit(AUDIO_LEVEL_EVENT, peak);
                    }
                }
            }

            drop(stream);
            {
                let mut g = stream_info().lock().expect("stream_info poisoned");
                *g = None;
            }
            log::info!("[audio] stream stopped");
        })
        .expect("spawn audio thread");

    (stop_tx, th)
}

/// 同步等 audio 线程把 cpal stream 起来。冷启动 macOS 实测 ~1s，所以默认 1.5s
/// 上限——超时即视为失败，调用方拿到 Err 不会再贸然走 stt_start。
const STREAM_READY_TIMEOUT: Duration = Duration::from_millis(1500);

pub fn start<R: Runtime>(app: AppHandle<R>, device_name: Option<String>) -> Result<(), String> {
    // 快速路径：已在运行且设备相同 → 只增引用计数（stream_info 已就绪，无需等待）
    // 必须同时检查线程是否还活着——audio 线程可能因 cpal stream error / panic 已退出，
    // 退出时清了 stream_info 但 MonitorState 的 thread/current_device 还残留，
    // 不检查就会命中快速路径返回 Ok，后续 audio_recording_start 读到 stream_info=None
    // 报 "audio stream not running"。
    {
        let mut guard = monitor().lock().expect("monitor mutex poisoned");
        let alive = guard.thread.as_ref().is_some_and(|th| !th.is_finished());
        if alive && guard.current_device == device_name {
            guard.ref_count += 1;
            return Ok(());
        }
    }

    // 需要 (re)spawn。若 thread 已在（设备不同 / 僵尸），先停掉旧线程，保持 ref_count 不变
    // 的前提下替换设备。
    let (old_tx, old_th) = {
        let mut guard = monitor().lock().expect("monitor mutex poisoned");
        (guard.stop_tx.take(), guard.thread.take())
    };
    if let Some(tx) = old_tx {
        let _ = tx.send(());
    }
    if let Some(th) = old_th {
        let _ = th.join();
    }

    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<(), String>>(1);
    let (stop_tx, th) = spawn_monitor_thread(app, device_name.clone(), ready_tx);

    let ready = match ready_rx.recv_timeout(STREAM_READY_TIMEOUT) {
        Ok(r) => r,
        Err(mpsc::RecvTimeoutError::Timeout) => Err(format!(
            "audio stream not ready within {}ms",
            STREAM_READY_TIMEOUT.as_millis()
        )),
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            Err("audio thread disconnected before ready".into())
        }
    };

    if let Err(ref e) = ready {
        log::warn!("[audio] start failed: {e}");
        // 起失败：让 audio 线程退出（spawn 时即便走了 ready_tx 失败 return，线程已经
        // 自然结束；这里 join 兜底，避免句柄泄漏）。ref_count 不递增。
        let _ = stop_tx.send(());
        let _ = th.join();
        return ready;
    }

    let mut guard = monitor().lock().expect("monitor mutex poisoned");
    guard.ref_count += 1;
    guard.current_device = device_name;
    guard.stop_tx = Some(stop_tx);
    guard.thread = Some(th);
    Ok(())
}

pub fn stop() {
    let (tx, th) = {
        let mut guard = monitor().lock().expect("monitor mutex poisoned");
        if guard.ref_count > 0 {
            guard.ref_count -= 1;
        }
        if guard.ref_count == 0 {
            guard.current_device = None;
            (guard.stop_tx.take(), guard.thread.take())
        } else {
            (None, None)
        }
    };
    if let Some(tx) = tx {
        let _ = tx.send(());
    }
    if let Some(th) = th {
        let _ = th.join();
    }
}

// audio_level_start / audio_level_stop：内部可能 join 旧 audio 线程 + 打开新
// cpal stream（macOS 上 device.build_input_stream 首次可达 100+ms）。同步
// command 会阻塞 Tauri 命令线程池，和 stt_* 挤一起时肉眼可见卡顿——全部挪到
// spawn_blocking 池里。
#[tauri::command]
pub async fn audio_level_start<R: Runtime>(
    app: AppHandle<R>,
    device_name: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || start(app, device_name))
        .await
        .map_err(|e| format!("audio_level_start join: {e}"))?
}

#[tauri::command]
pub async fn audio_level_stop() {
    let _ = tauri::async_runtime::spawn_blocking(stop).await;
}

#[derive(Debug, Clone, Serialize)]
pub struct RecordingResult {
    /// 相对 app_data_dir 的路径（如 "recordings/<id>.ogg"），直接写进 history.audio_path
    pub audio_path: String,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: usize,
}

/// 前端按下快捷键、进入 recording 前调用。传入的 id 就是 history.id，
/// 也作为录音文件名（`recordings/<id>.ogg`）。
///
/// 要求调用方已经通过 `audio_level_start` 把 stream 拉起来（前端 recording
/// store 的 startMic() 已经保证了这一点）；否则 session 创建了但 callback
/// 不会跑，OGG 会是空的。
#[tauri::command]
pub fn audio_recording_start(id: String) -> Result<(), String> {
    let (sample_rate, channels) = stream_info()
        .lock()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "audio stream not running; call audio_level_start first".to_string())?;

    let mut slot = recording_slot().lock().map_err(|e| e.to_string())?;
    // 旧 session 未 stop 就又 start——丢弃旧 samples（Zeroizing 会清零）
    *slot = Some(RecordingSession {
        id,
        started_at: Instant::now(),
        sample_rate,
        channels,
        samples: Zeroizing::new(Vec::new()),
    });
    Ok(())
}

/// 前端 finalize 时调用。把 session 取出，编码 OGG Vorbis 写到 recordings/<id>.ogg，
/// 返回 RecordingResult 供前端写 history 记录。
///
/// 若无激活 session（用户快速双击误触 / 没调 start 就 stop）返回 Err；前端
/// 据此走"不写历史"分支。
///
/// async + spawn_blocking：OGG 编码 + fs 写入少则几十 ms 多则几百 ms（大音频），
/// 放 blocking 池避免跟 stt_finalize 挤 IPC 命令线程。
#[tauri::command]
pub async fn audio_recording_stop<R: Runtime>(
    app: AppHandle<R>,
) -> Result<RecordingResult, String> {
    tauri::async_runtime::spawn_blocking(move || audio_recording_stop_impl(app))
        .await
        .map_err(|e| format!("audio_recording_stop join: {e}"))?
}

fn audio_recording_stop_impl<R: Runtime>(app: AppHandle<R>) -> Result<RecordingResult, String> {
    let session = {
        let mut slot = recording_slot().lock().map_err(|e| e.to_string())?;
        slot.take()
    };
    let Some(session) = session else {
        return Err("no active recording session".to_string());
    };

    let duration_ms = session.started_at.elapsed().as_millis() as u64;
    let samples_len = session.samples.len();

    // 确保 recordings 目录存在
    let dir = db::ensure_recordings_dir(&app)?;
    let rel_path = format!("recordings/{}.ogg", session.id);
    let abs_path = dir.join(format!("{}.ogg", session.id));

    encode_ogg_vorbis(&abs_path, &session.samples, session.sample_rate, session.channels)?;

    log::info!(
        "[audio] recording saved: {} ({} ms, {} samples, {}Hz x{})",
        abs_path.display(),
        duration_ms,
        samples_len,
        session.sample_rate,
        session.channels
    );

    Ok(RecordingResult {
        audio_path: rel_path,
        duration_ms,
        sample_rate: session.sample_rate,
        channels: session.channels,
        samples: samples_len,
    })
}

/// 取消当前录音：丢弃 samples，不写文件。用户 Esc / 误触走这条。
#[tauri::command]
pub fn audio_recording_cancel() -> Result<(), String> {
    let mut slot = recording_slot().lock().map_err(|e| e.to_string())?;
    // take → drop → Zeroizing 清零
    let _ = slot.take();
    Ok(())
}

/// 把交错 f32 PCM 编码成 OGG Vorbis 写到 path。
///
/// vorbis_rs 的 `encode_audio_block` 要求 planar 输入（每声道一段连续 [f32]），
/// 并且 libvorbis 文档建议块大小 ~1024 frame——这里按 OGG_ENCODE_BLOCK_FRAMES
/// 切片、复用 deinterleaved buffer 避免每块重新分配。
fn encode_ogg_vorbis(
    path: &std::path::Path,
    interleaved: &[f32],
    sample_rate: u32,
    channels: u16,
) -> Result<(), String> {
    let sr = NonZeroU32::new(sample_rate)
        .ok_or_else(|| format!("invalid sample_rate: {sample_rate}"))?;
    let ch = NonZeroU8::new(channels.min(u8::MAX as u16) as u8)
        .ok_or_else(|| format!("invalid channels: {channels}"))?;
    let ch_usize = channels as usize;

    let file = File::create(path).map_err(|e| format!("create {}: {e}", path.display()))?;
    let sink = BufWriter::new(file);

    let mut encoder = VorbisEncoderBuilder::new(sr, ch, sink)
        .map_err(|e| format!("VorbisEncoderBuilder::new: {e}"))?
        .bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
            target_quality: OGG_VORBIS_QUALITY,
        })
        .build()
        .map_err(|e| format!("VorbisEncoderBuilder::build: {e}"))?;

    let total_frames = interleaved.len() / ch_usize;
    if total_frames > 0 {
        let mut planar: Vec<Vec<f32>> = (0..ch_usize)
            .map(|_| Vec::with_capacity(OGG_ENCODE_BLOCK_FRAMES))
            .collect();

        let mut frame = 0usize;
        while frame < total_frames {
            let block_frames = (total_frames - frame).min(OGG_ENCODE_BLOCK_FRAMES);
            for buf in planar.iter_mut() {
                buf.clear();
            }
            for f in 0..block_frames {
                let base = (frame + f) * ch_usize;
                for c in 0..ch_usize {
                    planar[c].push(interleaved[base + c].clamp(-1.0, 1.0));
                }
            }
            encoder
                .encode_audio_block(&planar)
                .map_err(|e| format!("encode_audio_block: {e}"))?;
            frame += block_frames;
        }
    }

    encoder
        .finish()
        .map_err(|e| format!("VorbisEncoder::finish: {e}"))?;
    Ok(())
}

/// 校验 history.audio_path：必须是 `recordings/<filename>` 形式，filename 不允许
/// 路径分隔符 / `..` / 空串，扩展名只接受 `.ogg`（新版）或 `.wav`（兼容旧库）。
/// 返回纯 filename，由调用方拼到 recordings_dir 下。
fn validated_recording_filename(audio_path: &str) -> Result<&str, String> {
    let Some(filename) = audio_path.strip_prefix("recordings/") else {
        return Err("audio_path must start with recordings/".to_string());
    };
    if filename.is_empty()
        || filename.contains('/')
        || filename.contains('\\')
        || filename.contains("..")
    {
        return Err("invalid filename in audio_path".to_string());
    }
    let lower = filename.to_ascii_lowercase();
    if !(lower.ends_with(".ogg") || lower.ends_with(".wav")) {
        return Err("audio_path must end with .ogg or .wav".to_string());
    }
    Ok(filename)
}

/// 读取一条历史记录对应的录音字节，供前端 `<audio>` 元素播放。
///
/// 入参 `audio_path` 必须形如 `"recordings/<id>.ogg"`（新录音）或
/// `"recordings/<id>.wav"`（迁移前已落盘的老录音）——这是 DB 里
/// `history.audio_path` 的存储约定；其他形式（绝对路径 / 含 `..` / 含多级子目录
/// / 非音频后缀）一律拒绝，防止被构造成任意文件读取漏洞。
///
/// 返回 `tauri::ipc::Response`，让 Tauri 以原始二进制通道回传——前端收到的是
/// `ArrayBuffer`，而不是 `Vec<u8>` 默认序列化的 JSON number 数组（那会让几 MB
/// 的录音膨胀到几十 MB 的 IPC payload）。
#[tauri::command]
pub fn audio_recording_load<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
) -> Result<Response, String> {
    let filename = validated_recording_filename(&audio_path)?;
    let dir = db::recordings_dir(&app)?;
    let abs = dir.join(filename);
    let bytes = std::fs::read(&abs).map_err(|e| format!("read {}: {e}", abs.display()))?;
    Ok(Response::new(bytes))
}

/// 把 history 中某条录音另存到用户在系统对话框里选的位置。
/// `audio_path` 沿用 `audio_recording_load` 的相对路径约定（`recordings/<id>.ogg`
/// 或迁移前的 `recordings/<id>.wav`），`dest_path` 来自前端 `plugin-dialog::save()`
/// 的绝对路径——交给 std::fs::copy 由 OS 自行处理覆盖 / 权限。
#[tauri::command]
pub fn audio_recording_export<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    dest_path: String,
) -> Result<(), String> {
    let filename = validated_recording_filename(&audio_path)?;
    let dir = db::recordings_dir(&app)?;
    let src = dir.join(filename);
    std::fs::copy(&src, &dest_path)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest_path))?;
    Ok(())
}

/// 删除 history 中某条录音对应的 WAV/OGG 文件。
/// `audio_path` 沿用相对路径约定。文件不存在视为成功（idempotent）；前端
/// retention sweep / 清空历史 / 单条删除时调用，DB 行的删除由调用方自己执行。
#[tauri::command]
pub fn audio_recording_delete<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
) -> Result<(), String> {
    let filename = validated_recording_filename(&audio_path)?;
    let dir = db::recordings_dir(&app)?;
    let abs = dir.join(filename);
    match std::fs::remove_file(&abs) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("delete {}: {e}", abs.display())),
    }
}
