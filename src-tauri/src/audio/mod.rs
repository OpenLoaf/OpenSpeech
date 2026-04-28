// 麦克风电平监控 + 录音 PCM 采集
//
// 职责范围：
// 1. 采集麦克风 peak 电平，~20Hz emit 到前端供 overlay 波形 + 设置页电平表消费。
// 2. 录音会话（task #13 的第一步）：同一个 stream callback 内，在激活 session
//    时把 PCM 归一化为 f32 [-1, 1] 累积到 Zeroizing<Vec<f32>>；
//    `audio_recording_stop` 时编码为 16-bit WAV 落到 app_data_dir/recordings/<id>.wav。
//    STT 和文本注入尚未接入；stop 返回 { audio_path, duration_ms, sample_rate,
//    channels } 供前端写 history 记录。
//
// 线程模型：cpal::Stream 是 !Send，生命周期必须和 audio callback 在同一线程。
// 因此我们把整个"打开设备 + build_input_stream + play + tick emit"都塞进一个
// 专用 std::thread。主线程通过 mpsc::Sender 发 stop 信号，专用线程收到后 drop
// stream 退出。peak 用 AtomicU32（f32 的 bits）在 audio callback 与 emit tick
// 之间共享 — audio callback 不能 block，atomics 是唯一合理的同步手段。
//
// 录音 session 与 stream 解耦：session 只是"callback 是否 push PCM 的开关"。
// start_recording 前必须保证 stream 正在跑（即 ref_count > 0，由前端 startMic
// 保证）；stop_recording 把 session 取走后 stream 可以继续跑或停，WAV 编码由
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
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicU32, Ordering},
        mpsc,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{SampleFormat as WavSampleFormat, WavSpec, WavWriter};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime, ipc::Response};
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
// WAV 输出：16-bit PCM。采样率 / 声道跟随采集配置，不做 resample / 下混——
// 这两步留给 STT 集成阶段（大多数 STT 服务上传前自己会做）。
const WAV_BITS_PER_SAMPLE: u16 = 16;

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
/// stream 关闭前清空。start_recording 读它来决定 session 的 WAV 参数。
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
                cpal::SampleFormat::F32 => device.build_input_stream(
                    &stream_config,
                    move |data: &[f32], _: &cpal::InputCallbackInfo| {
                        let mut p = 0f32;
                        for s in data {
                            let a = s.abs();
                            if a > p {
                                p = a;
                            }
                        }
                        peak_cb.store(p.to_bits(), Ordering::Relaxed);
                        push_samples(data);
                        push_to_stt_pcm16(data, cb_channels, cb_sample_rate);
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::I16 => device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let scale = 1.0 / i16::MAX as f32;
                        let mut p = 0f32;
                        // 归一化一次，同时喂给 peak / 录音 / STT——避免多次 i16→f32
                        // 转换，降低 callback 里的 CPU 峰值。
                        let mut buf: [f32; 1024] = [0.0; 1024];
                        for chunk in data.chunks(buf.len()) {
                            for (i, s) in chunk.iter().enumerate() {
                                let v = *s as f32 * scale;
                                buf[i] = v;
                                let a = v.abs();
                                if a > p {
                                    p = a;
                                }
                            }
                            push_samples(&buf[..chunk.len()]);
                            push_to_stt_pcm16(&buf[..chunk.len()], cb_channels, cb_sample_rate);
                        }
                        peak_cb.store(p.to_bits(), Ordering::Relaxed);
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::U16 => device.build_input_stream(
                    &stream_config,
                    move |data: &[u16], _: &cpal::InputCallbackInfo| {
                        let mut p = 0f32;
                        let mut buf: [f32; 1024] = [0.0; 1024];
                        for chunk in data.chunks(buf.len()) {
                            for (i, s) in chunk.iter().enumerate() {
                                let v = (*s as f32 - 32768.0) / 32768.0;
                                buf[i] = v;
                                let a = v.abs();
                                if a > p {
                                    p = a;
                                }
                            }
                            push_samples(&buf[..chunk.len()]);
                            push_to_stt_pcm16(&buf[..chunk.len()], cb_channels, cb_sample_rate);
                        }
                        peak_cb.store(p.to_bits(), Ordering::Relaxed);
                    },
                    err_fn,
                    None,
                ),
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
                        let raw = f32::from_bits(bits);
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
    /// 相对 app_data_dir 的路径（如 "recordings/<id>.wav"），直接写进 history.audio_path
    pub audio_path: String,
    pub duration_ms: u64,
    pub sample_rate: u32,
    pub channels: u16,
    pub samples: usize,
}

/// 前端按下快捷键、进入 recording 前调用。传入的 id 就是 history.id，
/// 也作为 WAV 文件名（`recordings/<id>.wav`）。
///
/// 要求调用方已经通过 `audio_level_start` 把 stream 拉起来（前端 recording
/// store 的 startMic() 已经保证了这一点）；否则 session 创建了但 callback
/// 不会跑，WAV 会是空的。
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

/// 前端 finalize 时调用。把 session 取出，编码 WAV 写到 recordings/<id>.wav，
/// 返回 RecordingResult 供前端写 history 记录。
///
/// 若无激活 session（用户快速双击误触 / 没调 start 就 stop）返回 Err；前端
/// 据此走"不写历史"分支。
///
/// async + spawn_blocking：WAV 编码 + fs 写入少则几 ms 多则几十 ms（大音频），
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
    let rel_path = format!("recordings/{}.wav", session.id);
    let abs_path = dir.join(format!("{}.wav", session.id));

    let spec = WavSpec {
        channels: session.channels,
        sample_rate: session.sample_rate,
        bits_per_sample: WAV_BITS_PER_SAMPLE,
        sample_format: WavSampleFormat::Int,
    };
    let mut writer = WavWriter::create(&abs_path, spec)
        .map_err(|e| format!("WavWriter::create({}): {e}", abs_path.display()))?;
    // f32 [-1, 1] → i16：clamp 避免溢出（硬峰值时 ±1.0 * 32767 正好到上界）。
    for s in session.samples.iter() {
        let clamped = s.clamp(-1.0, 1.0);
        let v = (clamped * i16::MAX as f32) as i16;
        writer
            .write_sample(v)
            .map_err(|e| format!("write_sample: {e}"))?;
    }
    writer
        .finalize()
        .map_err(|e| format!("WavWriter::finalize: {e}"))?;

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

/// 读取一条历史记录对应的 WAV 字节，供前端 `<audio>` 元素播放。
///
/// 入参 `audio_path` 必须严格形如 `"recordings/<id>.wav"`——这是 DB 里
/// `history.audio_path` 的存储约定；其他形式（绝对路径 / 含 `..` / 含多级子目录）
/// 一律拒绝，防止被构造成任意文件读取漏洞。
///
/// 返回 `tauri::ipc::Response`，让 Tauri 以原始二进制通道回传——前端收到的是
/// `ArrayBuffer`，而不是 `Vec<u8>` 默认序列化的 JSON number 数组（那会让几 MB
/// 的 WAV 膨胀到几十 MB 的 IPC payload）。
#[tauri::command]
pub fn audio_recording_load<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
) -> Result<Response, String> {
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
    let dir = db::recordings_dir(&app)?;
    let abs = dir.join(filename);
    let bytes = std::fs::read(&abs).map_err(|e| format!("read {}: {e}", abs.display()))?;
    Ok(Response::new(bytes))
}

/// 把 history 中某条录音另存到用户在系统对话框里选的位置。
/// `audio_path` 沿用 `audio_recording_load` 的相对路径约定（`recordings/<id>.wav`），
/// `dest_path` 来自前端 `plugin-dialog::save()` 的绝对路径——交给 std::fs::copy
/// 由 OS 自行处理覆盖 / 权限。
#[tauri::command]
pub fn audio_recording_export<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    dest_path: String,
) -> Result<(), String> {
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
    let dir = db::recordings_dir(&app)?;
    let src = dir.join(filename);
    std::fs::copy(&src, &dest_path)
        .map_err(|e| format!("copy {} -> {}: {e}", src.display(), dest_path))?;
    Ok(())
}
