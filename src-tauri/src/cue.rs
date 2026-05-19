// 听写提示音播放：rodio + 嵌入的三段 WAV。
//
// 为什么搬到 Rust：原 JS 端走 Web Audio 合成，macOS WebView 长时间空闲后
// AudioContext 会被 suspend，按下激活键那一瞬 resume() 是异步的，schedule
// 出去的 oscillator 必须等 resume 完成才发声（实测 50–200ms），听感是
// "悬浮条已经出现，0.x 秒后才响"。Rust 侧用一条常驻线程持有 cpal 输出
// stream，按下时 mixer.add 立即排进设备 callback，零 IPC 零冷启动。
//
// Sink 健康度模型（2026-05 改）：旧实现把 MixerDeviceSink 在线程里 park
// 永久持有，**进程生命周期内只 open 一次 default sink**。生产实测：跑 1 小时
// 后 mixer.add 仍成功打日志、但用户听不到——CoreAudio HAL 在长时间无音输出
// 后会默默把 stream pause（macOS Sequoia 15+ 起更激进），rodio 这一层没有
// 暴露 stream error callback，上层完全不知道 sink 已死，直到用户重启 App。
// 同样的失声也可能由系统休眠唤醒 / 默认输出设备切换（蓝牙、AirPlay）触发。
//
// 新实现：sink 完全封装在 cue 线程局部变量里，外部通过 mpsc channel 发
// `CueCommand::Play` 请求。线程在处理 Play 之前做一次健康检查：
//   1) 当前 default output device name 与缓存的 device_name 不一致 → 重建
//   2) sink 持有时间 > SINK_MAX_AGE_MS（10 分钟）→ 重建（兜底 HAL pause）
// 健康检查 + 一次 device.description() 查询在 macOS 上 ~1–3ms，对按键响应
// 的可感知延迟可以忽略；真正触发重建时阻塞 ~50–200ms（rodio open default
// sink 的代价），仅在 sink 真的过期 / 设备真的换了那一次发生。
//
// cpal::Stream 在 macOS 是 !Send，所以 MixerDeviceSink 也 !Send——sink 不能
// 跨线程暴露，只能让 cue 线程做唯一持有者。这正好对齐 channel 设计：mixer
// 不再外露，外部只发消息。

use std::io::Cursor;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use cpal::traits::{DeviceTrait, HostTrait};
use rodio::Decoder;
use rodio::MixerDeviceSink;

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

/// sink 持有时间到达此阈值后，下一次播放强制重建——覆盖 macOS CoreAudio HAL
/// 在长时间 idle 后默默 pause output stream 这类"看不见的死亡"。
const SINK_MAX_AGE_MS: u64 = 10 * 60 * 1000;

/// cue 线程至少成功 open 过一次 sink 后置 true，给 diagnose 命令查询。
static SINK_READY: AtomicBool = AtomicBool::new(false);

enum CueCommand {
    Play(&'static [u8], &'static str),
}

static CUE_TX: OnceLock<mpsc::Sender<CueCommand>> = OnceLock::new();

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn current_default_output_name() -> Option<String> {
    let host = cpal::default_host();
    let device = host.default_output_device()?;
    // 与 audio/mod.rs 的 device_label 一致：用 description().name() 取代 deprecated
    // 的 DeviceTrait::name()。
    device.description().ok().map(|d| d.name().to_string())
}

struct SinkState {
    sink: Option<MixerDeviceSink>,
    device_name: Option<String>,
    opened_at_ms: u64,
}

fn open_sink(state: &mut SinkState) {
    // 启动竞争 CoreAudio 偶发失败，间隔 200ms retry 一次。
    let new_sink = match rodio::DeviceSinkBuilder::open_default_sink() {
        Ok(s) => Some(s),
        Err(first_err) => {
            log::warn!("[cue] open default sink failed: {first_err:?}, retrying in 200ms");
            std::thread::sleep(Duration::from_millis(200));
            match rodio::DeviceSinkBuilder::open_default_sink() {
                Ok(s) => Some(s),
                Err(e) => {
                    log::warn!("[cue] open default sink failed twice: {e:?}");
                    None
                }
            }
        }
    };

    if new_sink.is_some() {
        let device_name = current_default_output_name();
        state.device_name = device_name.clone();
        state.opened_at_ms = now_ms();
        state.sink = new_sink;
        SINK_READY.store(true, Ordering::Relaxed);
        log::info!("[cue] sink opened: device={device_name:?}");
    } else {
        state.device_name = None;
        // 不更新 opened_at_ms——下次 Play 时仍判断为 stale 触发 retry
        state.sink = None;
    }
}

fn health_check_and_rebuild(state: &mut SinkState) {
    let current = current_default_output_name();
    let age = now_ms().saturating_sub(state.opened_at_ms);

    let none = state.sink.is_none();
    let device_changed = state.device_name != current;
    let aged = age > SINK_MAX_AGE_MS;

    if !(none || device_changed || aged) {
        return;
    }

    if !none {
        log::info!(
            "[cue] sink stale: device={:?} current={:?} age={age}ms (max={SINK_MAX_AGE_MS}ms) → rebuild",
            state.device_name,
            current,
        );
    }
    // 显式 drop 旧 sink，让 cpal stream 完整 stop + dispose，避免新 sink 与
    // 旧 stream 在 CoreAudio HAL 抢同一物理设备出现短暂的双 stream 状态。
    drop(state.sink.take());
    open_sink(state);
}

fn cue_thread_main(rx: mpsc::Receiver<CueCommand>, ready_tx: mpsc::Sender<()>) {
    let mut state = SinkState {
        sink: None,
        device_name: None,
        opened_at_ms: 0,
    };

    open_sink(&mut state);
    log::info!("[cue] thread ready");
    let _ = ready_tx.send(());

    while let Ok(cmd) = rx.recv() {
        match cmd {
            CueCommand::Play(bytes, kind) => {
                health_check_and_rebuild(&mut state);
                let Some(ref sink) = state.sink else {
                    log::warn!("[cue] play kind={kind} skipped: sink unavailable");
                    continue;
                };
                match Decoder::new_wav(Cursor::new(bytes)) {
                    Ok(source) => {
                        sink.mixer().add(source);
                        log::info!("[cue] played kind={kind} bytes={}", bytes.len());
                    }
                    Err(e) => log::warn!("[cue] decode failed kind={kind}: {e:?}"),
                }
            }
        }
    }
}

fn ensure_thread() {
    CUE_TX.get_or_init(|| {
        let (tx, rx) = mpsc::channel::<CueCommand>();
        let (ready_tx, ready_rx) = mpsc::channel::<()>();
        match std::thread::Builder::new()
            .name("openspeech-cue".into())
            .spawn(move || cue_thread_main(rx, ready_tx))
        {
            Ok(_) => {
                // 等首次 sink open 完成，最多 500ms。超时不致命——首次 play 仍
                // 能正常工作，只是付一次 open_default_sink 的延迟。
                let _ = ready_rx.recv_timeout(Duration::from_millis(500));
            }
            Err(e) => {
                log::warn!("[cue] spawn cue thread failed: {e:?}");
            }
        }
        tx
    });
}

fn play_bytes(bytes: &'static [u8], kind: &'static str) {
    ensure_thread();
    let Some(tx) = CUE_TX.get() else {
        log::warn!("[cue] play kind={kind} skipped: thread unavailable");
        return;
    };
    if tx.send(CueCommand::Play(bytes, kind)).is_err() {
        log::warn!("[cue] play kind={kind} skipped: send failed");
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

/// 录音活跃期由 audio level emit 路径（20Hz）持续调用以续约 ACTIVE_SET_AT_MS。
/// 否则一旦单次录音超过 ACTIVE_STALE_MS（30s），结束时再按一下 PTT/toggle
/// 会被 play_start_internal 的"脏状态"分支误判，导致先播 start 再播 stop（两声）。
/// ACTIVE=false 时本函数 no-op，对设置页的电平表预览路径无副作用。
pub fn keepalive_active() {
    if ACTIVE.load(Ordering::Relaxed) {
        ACTIVE_SET_AT_MS.store(now_ms(), Ordering::Relaxed);
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
    ensure_thread();
    let mixer_ready = SINK_READY.load(Ordering::Relaxed);
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

/// boot 时调一次预热：spawn cue 线程并打开默认输出 stream。
/// 否则首次按激活键时还要付 cpal 设备 enumerate + open 的 ~50ms。
pub fn warm_up() {
    ensure_thread();
}
