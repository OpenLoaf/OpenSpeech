// 麦克风电平监控
//
// 职责范围：**只**采集麦克风 peak 电平，以 ~20Hz 的频率 emit 到前端供 overlay
// 波形动画 + 设置页"输入声音"电平表共享消费。不负责写 WAV / 发送 STT / 任何持
// 久化 — 那些属于 task #13。
//
// 线程模型：cpal::Stream 是 !Send，生命周期必须和 audio callback 在同一线程。
// 因此我们把整个"打开设备 + build_input_stream + play + tick emit"都塞进一个
// 专用 std::thread。主线程通过 mpsc::Sender 发 stop 信号，专用线程收到后 drop
// stream 退出。peak 用 AtomicU32（f32 的 bits）在 audio callback 与 emit tick
// 之间共享 — audio callback 不能 block，atomics 是唯一合理的同步手段。
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
    time::Duration,
};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

const AUDIO_LEVEL_EVENT: &str = "openspeech://audio-level";
const TICK_MS: u64 = 50; // 20Hz emit
const PEAK_GAIN: f32 = 1.6; // 轻度增益，普通说话音量下 bar 更明显

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
    let default_name = host
        .default_input_device()
        .and_then(|d| d.name().ok());
    let mut out = Vec::new();
    if let Ok(devices) = host.input_devices() {
        for d in devices {
            if let Ok(name) = d.name() {
                let is_default = default_name.as_deref() == Some(name.as_str());
                out.push(InputDeviceInfo { name, is_default });
            }
        }
    }
    out
}

fn spawn_monitor_thread<R: Runtime>(
    app: AppHandle<R>,
    device_name: Option<String>,
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
                            .find(|d| d.name().ok().as_deref() == Some(wanted))
                    })
                    .or_else(|| host.default_input_device()),
                None => host.default_input_device(),
            };
            let Some(device) = device else {
                eprintln!("[audio] no input device available");
                return;
            };

            let supported = match device.default_input_config() {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[audio] default_input_config failed: {e}");
                    return;
                }
            };
            let sample_format = supported.sample_format();
            let stream_config: cpal::StreamConfig = supported.into();

            let err_fn = |e: cpal::StreamError| eprintln!("[audio] stream error: {e}");

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
                    },
                    err_fn,
                    None,
                ),
                cpal::SampleFormat::I16 => device.build_input_stream(
                    &stream_config,
                    move |data: &[i16], _: &cpal::InputCallbackInfo| {
                        let scale = 1.0 / i16::MAX as f32;
                        let mut p = 0f32;
                        for s in data {
                            let a = (*s as f32 * scale).abs();
                            if a > p {
                                p = a;
                            }
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
                        for s in data {
                            let a = ((*s as f32 - 32768.0) / 32768.0).abs();
                            if a > p {
                                p = a;
                            }
                        }
                        peak_cb.store(p.to_bits(), Ordering::Relaxed);
                    },
                    err_fn,
                    None,
                ),
                other => {
                    eprintln!("[audio] unsupported sample format: {other:?}");
                    return;
                }
            };

            let stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("[audio] build_input_stream failed: {e}");
                    return;
                }
            };
            if let Err(e) = stream.play() {
                eprintln!("[audio] stream.play failed: {e}");
                return;
            }
            eprintln!("[audio] stream started (device={:?})", device.name().ok());

            loop {
                match stop_rx.recv_timeout(Duration::from_millis(TICK_MS)) {
                    Ok(_) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        let bits = peak_tick.swap(0, Ordering::Relaxed);
                        let peak = (f32::from_bits(bits) * PEAK_GAIN).min(1.0).max(0.0);
                        let _ = app.emit(AUDIO_LEVEL_EVENT, peak);
                    }
                }
            }

            drop(stream);
            eprintln!("[audio] stream stopped");
        })
        .expect("spawn audio thread");

    (stop_tx, th)
}

pub fn start<R: Runtime>(app: AppHandle<R>, device_name: Option<String>) {
    // 快速路径：已在运行且设备相同 → 只增引用计数
    {
        let mut guard = monitor().lock().expect("monitor mutex poisoned");
        if guard.thread.is_some() && guard.current_device == device_name {
            guard.ref_count += 1;
            return;
        }
    }

    // 需要 (re)spawn。若 thread 已在（设备不同），先停掉旧线程，保持 ref_count 不变
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

    let (stop_tx, th) = spawn_monitor_thread(app, device_name.clone());

    let mut guard = monitor().lock().expect("monitor mutex poisoned");
    guard.ref_count += 1;
    guard.current_device = device_name;
    guard.stop_tx = Some(stop_tx);
    guard.thread = Some(th);
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

#[tauri::command]
pub fn audio_level_start<R: Runtime>(app: AppHandle<R>, device_name: Option<String>) {
    start(app, device_name);
}

#[tauri::command]
pub fn audio_level_stop() {
    stop();
}
