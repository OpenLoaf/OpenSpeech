// 听写提示音播放：rodio + 嵌入的三段 WAV。
//
// 为什么搬到 Rust：原 JS 端走 Web Audio 合成，macOS WebView 长时间空闲后
// AudioContext 会被 suspend，按下激活键那一瞬 resume() 是异步的，schedule
// 出去的 oscillator 必须等 resume 完成才发声（实测 50–200ms），听感是
// "悬浮条已经出现，0.x 秒后才响"。Rust 侧用一条常驻线程持有 cpal 输出
// stream，按下时 mixer.add 立即排进设备 callback，零 IPC 零冷启动。

use std::io::Cursor;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use rodio::Decoder;
use rodio::mixer::Mixer;

static START_WAV: &[u8] = include_bytes!("../resources/cues/start.wav");
static STOP_WAV: &[u8] = include_bytes!("../resources/cues/stop.wav");
static CANCEL_WAV: &[u8] = include_bytes!("../resources/cues/cancel.wav");
// "再按一下取消"提示进入 armed 阶段时的双声短 beep。
static ARMED_WAV: &[u8] = include_bytes!("../resources/cues/armed.wav");

static ENABLED: AtomicBool = AtomicBool::new(true);
// 录音活跃中。hotkey 按下时若 active=true，说明这是 toggle off 路径，
// 不该播 start cue（前端会在状态进 transcribing/idle 时调对应 stop/cancel）。
static ACTIVE: AtomicBool = AtomicBool::new(false);
// ACTIVE 上一次被置 true 的毫秒时戳。play_start_internal 命中守卫时若超
// ACTIVE_STALE_MS 视为 FSM 没复位的脏状态，强制 reset 并照常播——否则一旦
// 异常路径让 ACTIVE 卡 true，所有后续 hotkey 都静默无日志。
static ACTIVE_SET_AT_MS: AtomicU64 = AtomicU64::new(0);
const ACTIVE_STALE_MS: u64 = 30_000;

static MIXER: OnceLock<Option<Mixer>> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn ensure_mixer() -> Option<&'static Mixer> {
    MIXER
        .get_or_init(|| {
            let (tx, rx) = std::sync::mpsc::channel::<Option<Mixer>>();
            let spawn_result = std::thread::Builder::new()
                .name("openspeech-cue".into())
                .spawn(move || {
                    // 启动竞争 CoreAudio 偶发失败，间隔 200ms retry 一次。
                    let sink = match rodio::DeviceSinkBuilder::open_default_sink() {
                        Ok(s) => s,
                        Err(first_err) => {
                            log::warn!(
                                "[cue] open default sink failed: {first_err:?}, retrying in 200ms"
                            );
                            std::thread::sleep(std::time::Duration::from_millis(200));
                            match rodio::DeviceSinkBuilder::open_default_sink() {
                                Ok(s) => s,
                                Err(e) => {
                                    log::warn!("[cue] open default sink failed twice: {e:?}");
                                    let _ = tx.send(None);
                                    return;
                                }
                            }
                        }
                    };
                    let mixer = sink.mixer().clone();
                    log::info!("[cue] mixer ready");
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

fn play_bytes(bytes: &'static [u8], kind: &'static str) {
    let Some(mixer) = ensure_mixer() else {
        log::warn!("[cue] play kind={kind} skipped: mixer unavailable");
        return;
    };
    // new_wav 直接走 hound 解码，比 try_from 走 symphonia probe 路径快
    // 几 ms（每次按下都付一次的代价）。
    match Decoder::new_wav(Cursor::new(bytes)) {
        Ok(source) => {
            mixer.add(source);
            log::info!("[cue] played kind={kind} bytes={}", bytes.len());
        }
        Err(e) => log::warn!("[cue] decode failed kind={kind}: {e:?}"),
    }
}

/// 内部统一播 start：`respect_active=true` 时遵守 ACTIVE 守卫（hotkey 自动
/// 派发用，避免 toggle off 路径重播 start）；`false` 时无视 ACTIVE，给前端
/// "录音中跨模式切换"这类显式声学反馈用。
fn play_start_internal(respect_active: bool) {
    if !ENABLED.load(Ordering::Relaxed) {
        log::info!("[cue] start suppressed: enabled=false");
        return;
    }
    if respect_active && ACTIVE.load(Ordering::Relaxed) {
        let age = now_ms().saturating_sub(ACTIVE_SET_AT_MS.load(Ordering::Relaxed));
        if age <= ACTIVE_STALE_MS {
            log::info!("[cue] start suppressed: active guard (age={age}ms)");
            return;
        }
        log::warn!("[cue] active guard stale (age={age}ms) → force reset and play");
        ACTIVE.store(false, Ordering::Relaxed);
    }
    play_bytes(START_WAV, "start");
}

/// hotkey 按下瞬间从 Rust 侧直接调；ACTIVE/ENABLED 守卫由本函数承担，
/// 调用方不必判断。
pub fn play_start() {
    play_start_internal(true);
}

pub fn play_stop() {
    if !ENABLED.load(Ordering::Relaxed) {
        log::info!("[cue] stop suppressed: enabled=false");
        return;
    }
    play_bytes(STOP_WAV, "stop");
}

pub fn play_cancel() {
    if !ENABLED.load(Ordering::Relaxed) {
        log::info!("[cue] cancel suppressed: enabled=false");
        return;
    }
    play_bytes(CANCEL_WAV, "cancel");
}

pub fn play_armed() {
    if !ENABLED.load(Ordering::Relaxed) {
        log::info!("[cue] armed suppressed: enabled=false");
        return;
    }
    play_bytes(ARMED_WAV, "armed");
}

#[tauri::command]
pub fn cue_set_enabled(enabled: bool) {
    let prev = ENABLED.swap(enabled, Ordering::Relaxed);
    if prev != enabled {
        log::info!("[cue] set_enabled prev={prev} next={enabled}");
    }
}

#[tauri::command]
pub fn cue_set_active(active: bool) {
    let prev = ACTIVE.swap(active, Ordering::Relaxed);
    if prev != active {
        log::info!("[cue] set_active prev={prev} next={active}");
    }
    if active {
        ACTIVE_SET_AT_MS.store(now_ms(), Ordering::Relaxed);
    }
}

/// 兜底：前端进 idle 状态时调一次，清残留的 ACTIVE=true（如果有的话）。
#[tauri::command]
pub fn cue_reset_active() {
    let prev = ACTIVE.swap(false, Ordering::Relaxed);
    if prev {
        log::info!("[cue] reset_active: was true, now false");
    }
}

#[derive(serde::Serialize)]
pub struct CueDiagnose {
    pub enabled: bool,
    pub active: bool,
    pub active_age_ms: u64,
    pub mixer_ready: bool,
}

/// 设置页"测试提示音"按钮调用：返回当前状态 + 强制播一声 start。
#[tauri::command]
pub fn cue_diagnose_and_test() -> CueDiagnose {
    let enabled = ENABLED.load(Ordering::Relaxed);
    let active = ACTIVE.load(Ordering::Relaxed);
    let active_age_ms = if active {
        now_ms().saturating_sub(ACTIVE_SET_AT_MS.load(Ordering::Relaxed))
    } else {
        0
    };
    let mixer_ready = ensure_mixer().is_some();
    log::info!(
        "[cue] diagnose enabled={enabled} active={active} age={active_age_ms}ms mixer_ready={mixer_ready}"
    );
    // 测试播放：无视 ACTIVE 守卫，但仍受 ENABLED 控制——开关关了应该静默。
    play_start_internal(false);
    CueDiagnose {
        enabled,
        active,
        active_age_ms,
        mixer_ready,
    }
}

#[tauri::command]
pub fn cue_play(kind: String) {
    log::info!("[cue] cue_play invoke kind={kind}");
    match kind.as_str() {
        // 显式 invoke 来源（subscribe 状态边沿 + 跨模式切换）意图明确，绕开
        // ACTIVE 守卫直接播——否则录音中"听写↔翻译"切换会因 ACTIVE=true 静音。
        "start" => play_start_internal(false),
        "stop" => play_stop(),
        "cancel" => play_cancel(),
        "armed" => play_armed(),
        other => log::warn!("[cue] unknown kind: {other}"),
    }
}

/// boot 时调一次预热：spawn 出 cue 线程并打开默认输出 stream。
/// 否则首次按激活键时还要付 cpal 设备 enumerate + open 的 ~50ms。
pub fn warm_up() {
    let _ = ensure_mixer();
}
