// 听写提示音播放：rodio + 嵌入的三段 WAV。
//
// 为什么搬到 Rust：原 JS 端走 Web Audio 合成，macOS WebView 长时间空闲后
// AudioContext 会被 suspend，按下激活键那一瞬 resume() 是异步的，schedule
// 出去的 oscillator 必须等 resume 完成才发声（实测 50–200ms），听感是
// "悬浮条已经出现，0.x 秒后才响"。Rust 侧用一条常驻线程持有 cpal 输出
// stream，按下时 mixer.add 立即排进设备 callback，零 IPC 零冷启动。

use std::io::Cursor;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, Ordering};

use rodio::Decoder;
use rodio::mixer::Mixer;

static START_WAV: &[u8] = include_bytes!("../resources/cues/start.wav");
static STOP_WAV: &[u8] = include_bytes!("../resources/cues/stop.wav");
static CANCEL_WAV: &[u8] = include_bytes!("../resources/cues/cancel.wav");

static ENABLED: AtomicBool = AtomicBool::new(true);
// 录音活跃中。hotkey 按下时若 active=true，说明这是 toggle off 路径，
// 不该播 start cue（前端会在状态进 transcribing/idle 时调对应 stop/cancel）。
static ACTIVE: AtomicBool = AtomicBool::new(false);

static MIXER: OnceLock<Option<Mixer>> = OnceLock::new();

fn ensure_mixer() -> Option<&'static Mixer> {
    MIXER
        .get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<Option<Mixer>>();
            let spawn_result = std::thread::Builder::new()
                .name("openspeech-cue".into())
                .spawn(move || {
                    let sink = match rodio::DeviceSinkBuilder::open_default_sink() {
                        Ok(s) => s,
                        Err(e) => {
                            log::warn!("[cue] open default sink failed: {e:?}");
                            let _ = tx.send(None);
                            return;
                        }
                    };
                    let mixer = sink.mixer().clone();
                    if tx.send(Some(mixer)).is_err() {
                        return;
                    }
                    // sink 必须在线程里持续存活，drop 即停止整个输出流。
                    // park forever，进程退出时整个线程随之回收。
                    loop {
                        std::thread::park();
                    }
                });
            if spawn_result.is_err() {
                log::warn!("[cue] spawn cue thread failed");
                return None;
            }
            rx.recv().ok().flatten()
        })
        .as_ref()
}

fn play_bytes(bytes: &'static [u8]) {
    let Some(mixer) = ensure_mixer() else {
        return;
    };
    // new_wav 直接走 hound 解码，比 try_from 走 symphonia probe 路径快
    // 几 ms（每次按下都付一次的代价）。
    match Decoder::new_wav(Cursor::new(bytes)) {
        Ok(source) => mixer.add(source),
        Err(e) => log::warn!("[cue] decode failed: {e:?}"),
    }
}

/// hotkey 按下瞬间从 Rust 侧直接调；ACTIVE/ENABLED 守卫由本函数承担，
/// 调用方不必判断。
pub fn play_start() {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    if ACTIVE.load(Ordering::Relaxed) {
        return;
    }
    play_bytes(START_WAV);
}

pub fn play_stop() {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    play_bytes(STOP_WAV);
}

pub fn play_cancel() {
    if !ENABLED.load(Ordering::Relaxed) {
        return;
    }
    play_bytes(CANCEL_WAV);
}

#[tauri::command]
pub fn cue_set_enabled(enabled: bool) {
    ENABLED.store(enabled, Ordering::Relaxed);
}

#[tauri::command]
pub fn cue_set_active(active: bool) {
    ACTIVE.store(active, Ordering::Relaxed);
}

#[tauri::command]
pub fn cue_play(kind: String) {
    match kind.as_str() {
        "start" => play_start(),
        "stop" => play_stop(),
        "cancel" => play_cancel(),
        other => log::warn!("[cue] unknown kind: {other}"),
    }
}

/// boot 时调一次预热：spawn 出 cue 线程并打开默认输出 stream。
/// 否则首次按激活键时还要付 cpal 设备 enumerate + open 的 ~50ms。
pub fn warm_up() {
    let _ = ensure_mixer();
}
