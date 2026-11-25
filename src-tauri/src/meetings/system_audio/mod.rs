// 会议录制的「系统声音」采集：把本机正在播放的声音（会议软件里对方的发言）
// 混进会议链路。
//
// 背景：会议原本只录麦克风。在本机开会时对方的声音只走扬声器 / 耳机——戴耳机完全
// 收不到，外放也只能隔空收到一点，还会被会议软件的回声消除压掉，所以「在当前电脑
// 开会，会议录制录不到对方」。
//
// 平台：
//   - macOS 14.4+：Core Audio process tap（全局立体声 tap，排除本进程，避免录进
//     自己的提示音），只需「系统音频录制」授权，不需要屏幕录制。见 macos.rs。
//     不用 cpal 自带的 loopback：它对「同时有输入」的输出设备（USB 耳机等）会直接
//     录那个设备的麦克风而不是系统声音。
//   - Windows：WASAPI loopback（cpal 对输出设备开输入流即为 loopback）。见 windows.rs。
//   - 其它平台 / 旧系统：不采集，会议照常只录麦克风。
//
// 数据流：采集线程 → 16k 单声道 → 全局 Mixer ring；麦克风 PCM 帧进入
// `meetings::try_send_audio_pcm16` 时调 `mix_into_pcm16` 叠加。OGG 落盘与 ASR
// 拿到的都是混音后的同一份数据。

#[cfg(target_os = "macos")]
mod macos;
mod mixer;
#[cfg(target_os = "windows")]
mod windows;

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};

use mixer::Mixer;
pub(crate) use mixer::StreamResampler;

fn mixer_slot() -> &'static Mutex<Option<Mixer>> {
    static SLOT: OnceLock<Mutex<Option<Mixer>>> = OnceLock::new();
    SLOT.get_or_init(|| Mutex::new(None))
}

/// 诊断统计：本次采集收到的系统声音总采样数 / 非静音采样数。授权被拒时 macOS
/// 不报错而是一直给静音，结束时据此打一行日志，排查「为什么还是录不到对方」。
static TOTAL_SAMPLES: AtomicU64 = AtomicU64::new(0);
static VOICED_SAMPLES: AtomicU64 = AtomicU64::new(0);

/// 采集线程写入已重采样到 16k 的单声道系统声音。无激活混音器时丢弃。
pub(crate) fn push_system_16k(samples: &[f32]) {
    if samples.is_empty() {
        return;
    }
    let voiced = samples.iter().filter(|s| s.abs() > 1e-4).count() as u64;
    let prev_voiced = VOICED_SAMPLES.fetch_add(voiced, Ordering::Relaxed);
    TOTAL_SAMPLES.fetch_add(samples.len() as u64, Ordering::Relaxed);
    if prev_voiced == 0 && voiced > 0 {
        log::info!("[sysaudio] first non-silent system audio received");
    }
    if let Ok(mut g) = mixer_slot().lock()
        && let Some(m) = g.as_mut()
    {
        m.push_system(samples);
    }
}

/// 把系统声音叠进一帧麦克风 PCM16（16k 单声道 LE）。未采集时原样不动。
pub(crate) fn mix_into_pcm16(pcm16: &mut [u8]) {
    if let Ok(mut g) = mixer_slot().lock()
        && let Some(m) = g.as_mut()
    {
        m.mix_into_pcm16(pcm16);
    }
}

#[cfg(target_os = "macos")]
type Platform = macos::Capture;
#[cfg(target_os = "windows")]
type Platform = windows::Capture;

/// 系统声音采集句柄。drop 即停止采集并撤掉混音器。
pub(crate) struct SystemAudio {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    _platform: Platform,
}

/// 尝试开始采集系统声音。不支持 / 失败时返回 None 并打日志——会议降级为只录麦克风，
/// 不影响会议本身开始。
pub(crate) fn start() -> Option<SystemAudio> {
    TOTAL_SAMPLES.store(0, Ordering::Relaxed);
    VOICED_SAMPLES.store(0, Ordering::Relaxed);
    // 先装好混音器，采集线程一开始回调就有地方写。
    if let Ok(mut g) = mixer_slot().lock() {
        *g = Some(Mixer::new());
    }

    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        #[cfg(target_os = "macos")]
        let r = macos::Capture::start();
        #[cfg(target_os = "windows")]
        let r = windows::Capture::start();
        match r {
            Ok(p) => {
                log::info!("[sysaudio] system audio capture started");
                Some(SystemAudio { _platform: p })
            }
            Err(e) => {
                log::warn!("[sysaudio] system audio capture unavailable: {e}");
                clear_mixer();
                None
            }
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        log::info!("[sysaudio] system audio capture not supported on this platform");
        clear_mixer();
        None
    }
}

fn clear_mixer() {
    if let Ok(mut g) = mixer_slot().lock() {
        *g = None;
    }
}

impl Drop for SystemAudio {
    fn drop(&mut self) {
        clear_mixer();
        let total = TOTAL_SAMPLES.load(Ordering::Relaxed);
        let voiced = VOICED_SAMPLES.load(Ordering::Relaxed);
        if total > 0 && voiced == 0 {
            log::warn!(
                "[sysaudio] system audio stayed silent for the whole session ({}ms) — \
                 nothing played, or system audio recording permission denied",
                total * 1000 / mixer::SAMPLE_RATE as u64
            );
        } else {
            log::info!(
                "[sysaudio] stopped: received {}ms, voiced {}ms",
                total * 1000 / mixer::SAMPLE_RATE as u64,
                voiced * 1000 / mixer::SAMPLE_RATE as u64
            );
        }
    }
}

#[cfg(all(test, target_os = "macos"))]
mod device_tests {
    use super::*;

    // 真机验证：开 tap → 放一段系统提示音 → 必须收到非静音的系统声音，且能混进麦克风帧。
    // 需要扬声器输出与「系统音频录制」授权（首次运行会弹授权），CI 上跳过：
    // cargo test --lib captures_system_audio_on_device -- --ignored --nocapture
    #[test]
    #[ignore]
    fn captures_system_audio_on_device() {
        let cap = start().expect("system audio capture should start on macOS 14.4+");
        std::thread::sleep(std::time::Duration::from_millis(300));
        let status = std::process::Command::new("afplay")
            .args(["-v", "0.3", "/System/Library/Sounds/Glass.aiff"])
            .status()
            .expect("afplay");
        assert!(status.success());

        let voiced = VOICED_SAMPLES.load(Ordering::Relaxed);
        let total = TOTAL_SAMPLES.load(Ordering::Relaxed);
        println!("received {total} samples, voiced {voiced}");
        assert!(total > 0, "tap delivered no data at all");
        assert!(
            voiced > 0,
            "tap delivered only silence (permission denied?)"
        );

        let mut frame = vec![0u8; 320];
        mix_into_pcm16(&mut frame);
        drop(cap);
    }
}
