// Windows 系统声音采集：WASAPI loopback。
//
// cpal 对 eRender（输出）设备调 build_input_stream 会自动带 AUDCLNT_STREAMFLAGS_LOOPBACK。
// Windows 的输出端点不会同时是输入端点，所以不存在 macOS 上「USB 耳机被当成麦克风」的问题。
//
// loopback 绑在开流时的默认输出设备上：中途插拔耳机 / 切换输出时要跟着重开，
// 采集线程每 2s 比一次默认输出设备名。
// 注意 WASAPI loopback 在没有任何声音播放时不回调——混音器把它当欠载补零，正好。

use std::sync::mpsc::{self, RecvTimeoutError, Sender};
use std::thread::JoinHandle;
use std::time::Duration;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

use super::StreamResampler;

const DEVICE_POLL: Duration = Duration::from_secs(2);
const READY_TIMEOUT: Duration = Duration::from_secs(3);

pub(crate) struct Capture {
    stop_tx: Option<Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl Capture {
    pub(crate) fn start() -> Result<Self, String> {
        let (ready_tx, ready_rx) = mpsc::channel::<Result<(), String>>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        // cpal::Stream 在 Windows 上不是 Send，必须在同一线程创建和销毁。
        let thread = std::thread::Builder::new()
            .name("openspeech-sysaudio".into())
            .spawn(move || {
                let mut current = match open_stream() {
                    Ok(s) => {
                        let _ = ready_tx.send(Ok(()));
                        s
                    }
                    Err(e) => {
                        let _ = ready_tx.send(Err(e));
                        return;
                    }
                };
                loop {
                    match stop_rx.recv_timeout(DEVICE_POLL) {
                        Ok(()) | Err(RecvTimeoutError::Disconnected) => break,
                        Err(RecvTimeoutError::Timeout) => {}
                    }
                    let now = default_output_name();
                    if now.is_some() && now != current.1 {
                        log::info!(
                            "[sysaudio] default output changed {:?} → {:?}, reopening loopback",
                            current.1,
                            now
                        );
                        drop(current);
                        match open_stream() {
                            Ok(s) => current = s,
                            Err(e) => {
                                log::warn!("[sysaudio] reopen loopback failed: {e}");
                                return;
                            }
                        }
                    }
                }
                drop(current);
            })
            .map_err(|e| format!("spawn sysaudio thread: {e}"))?;

        match ready_rx.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(())) => Ok(Self {
                stop_tx: Some(stop_tx),
                thread: Some(thread),
            }),
            Ok(Err(e)) => {
                let _ = thread.join();
                Err(e)
            }
            Err(_) => {
                // 不 join：线程卡在开流里，drop stop_tx 后它开完流会自己退出。
                drop(stop_tx);
                Err("loopback stream did not start within 3s".into())
            }
        }
    }
}

impl Drop for Capture {
    fn drop(&mut self) {
        if let Some(tx) = self.stop_tx.take() {
            let _ = tx.send(());
        }
        if let Some(th) = self.thread.take() {
            let _ = th.join();
        }
    }
}

fn device_name<D: DeviceTrait>(d: &D) -> Option<String> {
    d.description().ok().map(|desc| desc.name().to_string())
}

fn default_output_name() -> Option<String> {
    cpal::default_host()
        .default_output_device()
        .and_then(|d| device_name(&d))
}

/// 下混 + 重采样状态，归 cpal callback 独占。
struct Feed {
    channels: usize,
    resampler: StreamResampler,
    mono: Vec<f32>,
    out: Vec<f32>,
}

impl Feed {
    fn new(channels: u16, sample_rate: u32) -> Self {
        Self {
            channels: channels.max(1) as usize,
            resampler: StreamResampler::new(sample_rate),
            mono: Vec::with_capacity(4096),
            out: Vec::with_capacity(2048),
        }
    }

    fn push(&mut self, interleaved: &[f32]) {
        self.mono.clear();
        for frame in interleaved.chunks_exact(self.channels) {
            self.mono
                .push(frame.iter().sum::<f32>() / self.channels as f32);
        }
        self.out.clear();
        self.resampler.process(&self.mono, &mut self.out);
        super::push_system_16k(&self.out);
    }
}

/// 打开默认输出设备的 loopback 流；返回流和设备名（用于检测切换）。
fn open_stream() -> Result<(cpal::Stream, Option<String>), String> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or("no default output device")?;
    let name = device_name(&device);
    let supported = device
        .default_output_config()
        .map_err(|e| format!("default_output_config: {e}"))?;
    let sample_format = supported.sample_format();
    let config: cpal::StreamConfig = supported.into();
    let err_fn = |e: cpal::StreamError| log::warn!("[sysaudio] loopback stream error: {e}");

    let stream = match sample_format {
        cpal::SampleFormat::F32 => {
            let mut feed = Feed::new(config.channels, config.sample_rate);
            device.build_input_stream(
                &config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| feed.push(data),
                err_fn,
                None,
            )
        }
        cpal::SampleFormat::I16 => {
            let mut feed = Feed::new(config.channels, config.sample_rate);
            let mut buf: Vec<f32> = Vec::with_capacity(4096);
            device.build_input_stream(
                &config,
                move |data: &[i16], _: &cpal::InputCallbackInfo| {
                    buf.clear();
                    buf.extend(data.iter().map(|s| *s as f32 / i16::MAX as f32));
                    feed.push(&buf);
                },
                err_fn,
                None,
            )
        }
        other => return Err(format!("unsupported loopback sample format: {other:?}")),
    }
    .map_err(|e| format!("build loopback stream on {name:?}: {e}"))?;
    stream
        .play()
        .map_err(|e| format!("loopback stream.play: {e}"))?;
    log::info!(
        "[sysaudio] loopback started on {name:?} sr={}Hz ch={}",
        config.sample_rate,
        config.channels
    );
    Ok((stream, name))
}
