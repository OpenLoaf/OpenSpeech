// Modifier-only 与（未来的）double-tap 绑定的事件驱动实现。
//
// 为什么存在：
//   `tauri-plugin-global-shortcut` 只接受"修饰键 + 主键"的组合，对 `Fn` 单按 /
//   `Ctrl + Win` 按住 这类纯修饰键绑定直接 return Err。Handy 的同名 reject：
//   src-tauri/src/shortcut/tauri_impl.rs:54。
//
// 实现要点：
//   - 在启动时 spawn 一个线程跑 `rdev::listen`（阻塞 API），订阅全局
//     `KeyPress` / `KeyRelease`。依赖 `rustdesk-org/rdev` fork —— 修了上游
//     crates.io 0.5.3 的 macOS 致命 bug（子线程跑 listen 遇到第一个 key event
//     就让进程静默 abort）。见 Cargo.toml 的 rdev 依赖注释。
//   - 维护 `pressed: HashSet<Mod>` 追踪当前按住的修饰键集合；每次变化后
//     对所有已注册的 modifier-only bindings 做精确匹配（修饰键集合完全相等）。
//   - 通过 `active_ids` 记录"已经触发过 pressed 但还没触发 released"的绑定，
//     确保每次状态转移恰好 emit 一次（state-transition debounce，对齐 FreeFlow
//     `ShortcutMatcher.swift:159-176` 的做法）。
//   - 与 tauri-plugin-global-shortcut 的 combo 路径 emit 相同的 `HOTKEY_EVENT`
//     payload，前端 FSM 不需要区分两个来源。

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

use rdev::{Event, EventType, Key};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::hotkey::{BindingId, HOTKEY_EVENT, HotkeyBinding, HotkeyEventPayload};

/// 录入模式下，HotkeyField 订阅此事件拿到 press/release，代替 WebView DOM keydown
/// （macOS 上 Fn 键不会产生 DOM 事件，所以 DOM 监听器录不到）。
pub const HOTKEY_RECORDING_EVENT: &str = "openspeech://hotkey-recording";

/// 按键预览通道——仅修饰键（Ctrl/Alt/Shift/Meta/Fn）和 Esc 会跨 IPC 边界。
///
/// **隐私收紧**（2026-04 改）：原先无条件 emit 每一次 press/release，意味着用户在
/// 任何 app 里输入的字母 / 数字 / 中文都会经过 Rust → JS 的 IPC 序列化——尽管
/// 我们没有写盘 / 上传，对隐私敏感用户和第三方审计来说这个 surface 不可接受。
///
/// 现在只 emit 我们真的会用的两类键：
///   - 修饰键 + Fn：HotkeyPreview 给 DOM 拿不到的 Fn 键做视觉反馈
///   - Esc：recording.ts 的双击确认取消 + overlay toast 关闭
/// 字母 / 数字 / 标点 / 方向键 / 功能键等**不再越过进程边界**，rdev 回调里直接
/// 丢弃。HotkeyField 录入模式仍走独立的 HOTKEY_RECORDING_EVENT（用户主动开启
/// 时才全量），不受此过滤影响。
pub const KEY_PREVIEW_EVENT: &str = "openspeech://key-preview";

/// 决定一个 rdev key 是否可以越过 IPC。修饰键 + Fn + Esc 之外一律丢弃。
fn should_emit_preview(key: Key) -> bool {
    use Key::*;
    matches!(
        key,
        ControlLeft
            | ControlRight
            | ShiftLeft
            | ShiftRight
            | Alt
            | AltGr
            | MetaLeft
            | MetaRight
            | Function
            | Escape
    )
}

/// 全局标志：前端进入录入态时 set true，退出时 set false。listen 线程每次
/// callback 读一次（Relaxed 足够，无多线程一致性要求）。开启时 callback 只
/// pass-through 给录入 UI，不参与 binding 匹配——避免录入期间误触发录音。
static RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_recording(enabled: bool) {
    RECORDING_ACTIVE.store(enabled, Ordering::SeqCst);
    log::warn!("[modifier_only] recording mode → {enabled}");
}

#[derive(Debug, Clone, Serialize)]
struct RecordingEvent {
    code: String,
    phase: &'static str, // "pressed" | "released"
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct KeyPreviewEvent {
    code: String,
    phase: &'static str,
    // macOS Esc 等非修饰键有 auto-repeat（~30ms 间隔），第二次 KeyPress 没有 release
    // 介于其间。前端 ESC 双击窗口仅 500/1500ms，长按必触发误判。is_repeat=true 让前端
    // 状态机直接丢弃 repeat 事件。修饰键无 auto-repeat，is_repeat 始终 false。
    is_repeat: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum Mod {
    Ctrl,
    Alt,
    Shift,
    Meta,
    Fn,
}

fn rdev_key_to_mod(k: Key) -> Option<Mod> {
    match k {
        Key::ControlLeft | Key::ControlRight => Some(Mod::Ctrl),
        Key::Alt | Key::AltGr => Some(Mod::Alt),
        Key::ShiftLeft | Key::ShiftRight => Some(Mod::Shift),
        Key::MetaLeft | Key::MetaRight => Some(Mod::Meta),
        Key::Function => Some(Mod::Fn),
        _ => None,
    }
}

/// 用 OS 同步 API 查当前**真实**按下的修饰键集合，用来在每个 rdev 事件入口
/// 校准内部 `pressed` 状态——根治 rdev 漏报 release 导致 modifier 永久卡住
/// （日志特征：连续多事件 `pressed_before={Meta}` 不消失，下一次 Ctrl press
/// 立即被算成 Ctrl+Meta 触发 PTT）。
///
/// Windows：`GetAsyncKeyState` 返回最近一次查询以来的物理按键状态，无关 hook
/// 是否漏报；高位 1 = 当前按下。VK_CONTROL/VK_SHIFT/VK_MENU 已合并左右键，
/// VK_LWIN/VK_RWIN 需要分别查。
///
/// Fn 键 Windows 没标准 VK，跳过：返回的集合不含 Fn，调用方需保留原 pressed
/// 里 Fn 的状态（`Fn` 仅 macOS 实际可用，Windows 上从不进入 pressed）。
///
/// 非 Windows 平台返回 None，调用方走原 ghost 兜底逻辑。macOS 后续可加
/// CGEventSourceFlagsState 的实现。
#[cfg(target_os = "windows")]
fn query_real_modifier_state() -> Option<HashSet<Mod>> {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
    };
    fn down(vk: i32) -> bool {
        // i16 的高位（0x8000）= 当前按下；低位（0x0001）= 自上次查询以来按过，
        // 我们只关心当前是否按住，所以只看高位。
        (unsafe { GetAsyncKeyState(vk) } as u16 & 0x8000) != 0
    }
    let mut s: HashSet<Mod> = HashSet::new();
    if down(VK_CONTROL as i32) {
        s.insert(Mod::Ctrl);
    }
    if down(VK_SHIFT as i32) {
        s.insert(Mod::Shift);
    }
    if down(VK_MENU as i32) {
        s.insert(Mod::Alt);
    }
    if down(VK_LWIN as i32) || down(VK_RWIN as i32) {
        s.insert(Mod::Meta);
    }
    Some(s)
}

#[cfg(not(target_os = "windows"))]
fn query_real_modifier_state() -> Option<HashSet<Mod>> {
    None
}

/// 把 rdev `Key` 归一化成 UI Events KeyboardEvent.code 兼容的字符串，让前端
/// 录入组件不用再区分"事件源是 DOM 还是 Rust"。Fn 用约定 token `"Fn"`（DOM 里
/// 不存在这个 code，我们自定义）。未知键 fallback 到 Debug 表示，录入 UI 会拒绝。
fn rdev_key_to_code(k: Key) -> String {
    use Key::*;
    match k {
        // Modifiers — 注意 rdev 0.5 的"左 Alt"叫 `Alt`，右 Alt 叫 `AltGr`
        ControlLeft => "ControlLeft",
        ControlRight => "ControlRight",
        ShiftLeft => "ShiftLeft",
        ShiftRight => "ShiftRight",
        Alt => "AltLeft",
        AltGr => "AltRight",
        MetaLeft => "MetaLeft",
        MetaRight => "MetaRight",
        Function => "Fn",
        // Specials
        Space => "Space",
        Return => "Enter",
        Escape => "Escape",
        Tab => "Tab",
        Backspace => "Backspace",
        Delete => "Delete",
        CapsLock => "CapsLock",
        UpArrow => "ArrowUp",
        DownArrow => "ArrowDown",
        LeftArrow => "ArrowLeft",
        RightArrow => "ArrowRight",
        Home => "Home",
        End => "End",
        PageUp => "PageUp",
        PageDown => "PageDown",
        Insert => "Insert",
        // Letters
        KeyA => "KeyA",
        KeyB => "KeyB",
        KeyC => "KeyC",
        KeyD => "KeyD",
        KeyE => "KeyE",
        KeyF => "KeyF",
        KeyG => "KeyG",
        KeyH => "KeyH",
        KeyI => "KeyI",
        KeyJ => "KeyJ",
        KeyK => "KeyK",
        KeyL => "KeyL",
        KeyM => "KeyM",
        KeyN => "KeyN",
        KeyO => "KeyO",
        KeyP => "KeyP",
        KeyQ => "KeyQ",
        KeyR => "KeyR",
        KeyS => "KeyS",
        KeyT => "KeyT",
        KeyU => "KeyU",
        KeyV => "KeyV",
        KeyW => "KeyW",
        KeyX => "KeyX",
        KeyY => "KeyY",
        KeyZ => "KeyZ",
        // Digits (top row)
        Num0 => "Digit0",
        Num1 => "Digit1",
        Num2 => "Digit2",
        Num3 => "Digit3",
        Num4 => "Digit4",
        Num5 => "Digit5",
        Num6 => "Digit6",
        Num7 => "Digit7",
        Num8 => "Digit8",
        Num9 => "Digit9",
        // Function keys
        F1 => "F1",
        F2 => "F2",
        F3 => "F3",
        F4 => "F4",
        F5 => "F5",
        F6 => "F6",
        F7 => "F7",
        F8 => "F8",
        F9 => "F9",
        F10 => "F10",
        F11 => "F11",
        F12 => "F12",
        F13 => "F13",
        F14 => "F14",
        F15 => "F15",
        F16 => "F16",
        F17 => "F17",
        F18 => "F18",
        F19 => "F19",
        F20 => "F20",
        F21 => "F21",
        F22 => "F22",
        F23 => "F23",
        F24 => "F24",
        // Punctuation（覆盖常见的，录入 UI 主要期望字母/F 键/修饰键）
        Minus => "Minus",
        Equal => "Equal",
        LeftBracket => "BracketLeft",
        RightBracket => "BracketRight",
        BackSlash => "Backslash",
        SemiColon => "Semicolon",
        Quote => "Quote",
        Comma => "Comma",
        Dot => "Period",
        Slash => "Slash",
        BackQuote => "Backquote",
        _ => return format!("{:?}", k),
    }
    .to_string()
}

fn str_to_mod(s: &str) -> Option<Mod> {
    match s {
        "ctrl" => Some(Mod::Ctrl),
        "alt" => Some(Mod::Alt),
        "shift" => Some(Mod::Shift),
        "meta" => Some(Mod::Meta),
        "fn" => Some(Mod::Fn),
        _ => None,
    }
}

#[derive(Debug, Clone)]
struct ModBinding {
    id: BindingId,
    id_str: String,
    mods: HashSet<Mod>,
}

pub struct ModifierOnlyState {
    bindings: Vec<ModBinding>,
    pressed: HashSet<Mod>,
    active_ids: HashSet<BindingId>,
}

impl Default for ModifierOnlyState {
    fn default() -> Self {
        Self {
            bindings: Vec::new(),
            pressed: HashSet::new(),
            active_ids: HashSet::new(),
        }
    }
}

pub type SharedModifierOnlyState = Arc<Mutex<ModifierOnlyState>>;

fn parse_binding_id(s: &str) -> Option<BindingId> {
    match s {
        "dictate_ptt" => Some(BindingId::DictatePtt),
        "dictate_toggle" => Some(BindingId::DictateToggle),
        "ask_ai" => Some(BindingId::AskAi),
        "translate" => Some(BindingId::Translate),
        "show_main_window" => Some(BindingId::ShowMainWindow),
        "open_toolbox" => Some(BindingId::OpenToolbox),
        _ => None,
    }
}

/// 进程生命周期内 `rdev::listen` 是否已启动的幂等标志——`rdev::listen` 只能
/// 被调一次，多次调用会 panic 或无效。前端 booted 后通过 invoke 触发启动，
/// 后续重复触发（HMR / 用户操作）必须 short-circuit。
static LISTEN_STARTED: AtomicBool = AtomicBool::new(false);

/// Esc 当前是否处于物理 pressed 状态。macOS 长按 Esc 会触发连续 KeyPress（无 release
/// 介于其间），靠这个标志计算 is_repeat 让前端能丢弃 auto-repeat 帧。
static ESC_PRESSED: AtomicBool = AtomicBool::new(false);

/// 创建空的 `SharedModifierOnlyState`，**不启动** rdev::listen 线程。在 setup
/// 阶段调用，把空 state 注册到 Tauri Manager 让后续 `apply_bindings` 能安全
/// no-op。真正的 listen 启动由 `start_listener` 做。
///
/// **为什么拆开**：`rdev::listen` 内部首次访问全局键盘流时，macOS 会立即
/// 弹「Keystroke Receiving」授权对话框（IM 未授权时）或在已授权下重新校验。
/// setup 阶段立即弹会被随后 show 的主窗口遮挡。改为前端 booted（主窗口完全
/// 显示、loading 结束）后通过 `hotkey_init_listener` invoke 触发——此时弹框
/// 会正常叠在主窗口之上。
pub fn create_state() -> SharedModifierOnlyState {
    Arc::new(Mutex::new(ModifierOnlyState::default()))
}

/// 启动 rdev::listen 线程。幂等：通过 `LISTEN_STARTED` AtomicBool 保证整个进程
/// 生命周期内最多只启一次。
///
/// **macOS 注册策略（关键）**：rdev 内部用 `CGEventTapCreate(kCGSessionEventTap, ...)`，
/// 此 API 是把 App 写入「输入监控」系统设置列表的**最可靠路径**——首次访问时
/// macOS 会自动弹「Keystroke Receiving」授权对话框 + 把 App 注册到列表。
/// 反观 `IOHIDRequestAccess` 在某些条件下（dev 模式裸二进制 / 签名状态）会静默
/// 失败既不弹框也不注册（这是用户报"输入监控列表里没有 OpenSpeech"的根源）。
///
/// 因此**无条件启动 listen**：未授权时 listen 会失败，但失败的副作用——把 App
/// 注册到列表 + 弹弹框——正是我们要的。用户允许后下次启动 listen 即可工作；
/// 拒绝后用户至少能在系统设置里看到 OpenSpeech 并手动勾选。
///
/// 失败（如 listen 返回 Err）时只打日志不 panic，后续 apply 调用也不会崩，
/// 只是 modifier-only 绑定本会话不工作。
///
/// **遮挡问题**：之前担心 setup 阶段启动 listen 时弹框被主窗口遮挡——已通过
/// 把启动时机推迟到 `hotkey_init_listener` invoke（前端 booted=true 后，主窗口
/// 完全可见）解决。
pub fn start_listener<R: Runtime>(app: AppHandle<R>, state: SharedModifierOnlyState) {
    if LISTEN_STARTED.swap(true, Ordering::SeqCst) {
        log::warn!("[modifier_only] start_listener: already started, skip");
        return;
    }

    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();

    // App 长时间空闲后 macOS 会让 CGEventTap 进入低功耗模式，恢复时常会丢一个事件
    // （典型是漏 release）——`s.active_ids` 残留导致下一次按下被判为"未变化"，
    // 用户感知"必须按两下才能激活"。+ cmd-tab 切窗口期间偶发漏发 modifier release
    // 也会卡死同一 binding。统一用空闲时长门槛 reset：本次事件距上次 > 阈值就先
    // 清掉 pressed / active_ids，让下一帧从干净状态重新匹配。
    let last_event_at: Arc<Mutex<Option<Instant>>> = Arc::new(Mutex::new(None));
    const IDLE_RESET: std::time::Duration = std::time::Duration::from_secs(30);

    std::thread::spawn(move || {
        log::warn!("[modifier_only] starting rdev::listen thread");
        let result = rdev::listen(move |event: Event| {
            let (key, is_press) = match event.event_type {
                EventType::KeyPress(k) => (k, true),
                EventType::KeyRelease(k) => (k, false),
                _ => return,
            };

            // 诊断 trace：每个进入 rdev callback 的修饰键事件都打一行，方便用户复现
            // "按某个键导致主窗激活"时，回看日志判断到底是 binding 命中、ghost 路径，
            // 还是根本没进 hotkey 子系统。仅修饰键 + Fn 进 trace（与 should_emit_preview
            // 同集合），其它键不打——按 KeyPreview 注释的隐私 / 噪声原则。
            if rdev_key_to_mod(key).is_some() {
                let pressed_snapshot = state_clone
                    .lock()
                    .ok()
                    .map(|s| format!("{:?}", s.pressed))
                    .unwrap_or_else(|| "<lock-poisoned>".to_string());
                log::debug!(
                    "[modifier_only] event key={key:?} phase={} pressed_before={pressed_snapshot}",
                    if is_press { "press" } else { "release" },
                );
            }

            // 空闲超阈值则视为状态可能与系统不同步，先 reset 再处理本次事件。
            let stale = {
                let mut last = match last_event_at.lock() {
                    Ok(g) => g,
                    Err(_) => return,
                };
                let now = Instant::now();
                let stale = last.map_or(false, |t| now.duration_since(t) > IDLE_RESET);
                *last = Some(now);
                stale
            };
            if stale {
                if let Ok(mut s) = state_clone.lock() {
                    if !s.pressed.is_empty() || !s.active_ids.is_empty() {
                        log::warn!(
                            "[modifier_only] idle > {}s → reset stale state (pressed={}, active={})",
                            IDLE_RESET.as_secs(),
                            s.pressed.len(),
                            s.active_ids.len()
                        );
                        s.pressed.clear();
                        s.active_ids.clear();
                    }
                }
            }

            // 录入模式：额外 pass-through 给录入 UI（HotkeyField 用的），同时
            // short-circuit binding 匹配——否则录入时按下 Fn 会顺带触发原 dictate_ptt。
            // 录入是用户主动开启的有限窗口，需要全量按键以让用户能为任意键设绑定，
            // 所以这条通道不做过滤；KEY_PREVIEW 走过滤后的版本。
            let recording = RECORDING_ACTIVE.load(Ordering::Relaxed);
            if recording {
                let evt = RecordingEvent {
                    code: rdev_key_to_code(key),
                    phase: if is_press { "pressed" } else { "released" },
                };
                if let Err(e) = app_clone.emit(HOTKEY_RECORDING_EVENT, evt) {
                    log::warn!("[modifier_only] emit recording failed: {e:?}");
                }
                return;
            }

            // 预览通道：仅修饰键 / Fn / Esc 跨 IPC，其余按键**不离开 Rust**。
            // 见 KEY_PREVIEW_EVENT 注释（隐私收紧）。
            if should_emit_preview(key) {
                let is_repeat = if key == Key::Escape {
                    if is_press {
                        ESC_PRESSED.swap(true, Ordering::SeqCst)
                    } else {
                        ESC_PRESSED.store(false, Ordering::SeqCst);
                        false
                    }
                } else {
                    false
                };
                let preview = KeyPreviewEvent {
                    code: rdev_key_to_code(key),
                    phase: if is_press { "pressed" } else { "released" },
                    is_repeat,
                };
                let _ = app_clone.emit(KEY_PREVIEW_EVENT, preview);
            }

            let Some(m) = rdev_key_to_mod(key) else {
                return;
            };

            let (newly_pressed_ids, newly_released_ids): (
                Vec<(BindingId, String)>,
                Vec<(BindingId, String)>,
            ) = {
                let mut s = match state_clone.lock() {
                    Ok(s) => s,
                    Err(_) => return, // poisoned
                };

                let mut newly_pressed: Vec<(BindingId, String)> = Vec::new();
                let mut newly_released: Vec<(BindingId, String)> = Vec::new();

                // 优先用 OS 同步 API 校准 pressed（目前 Windows 实现，macOS/Linux 后续）。
                // 校准能根治 rdev 漏报带来的"幽灵 modifier 卡住"——典型症状：日志里
                // 连续多个事件 `pressed_before={Meta}` 不消失，下一次 Ctrl press 立刻
                // 被算成 Ctrl+Meta 命中 PTT 错误响声。校准后 pressed 直接等于 OS 真实
                // 物理状态（含本次事件之后的结果），无需 ghost 检测 + insert/remove。
                let os_synced = if let Some(real) = query_real_modifier_state() {
                    // Fn 仅 macOS 走 rdev::Key::Function 路径，Windows 永远不会进入
                    // pressed；此处保留 had_fn 是面向"将来 macOS 也接入校准"的预留。
                    let had_fn = s.pressed.contains(&Mod::Fn);
                    let prev = s.pressed.clone();
                    s.pressed = real;
                    if had_fn {
                        s.pressed.insert(Mod::Fn);
                    }
                    if prev != s.pressed {
                        // chord 中第二个键尚未到达 rdev 时，OS 先于 rdev 知道全集，
                        // correction 表现为"补进"——这是预期视角差，非 rdev bug。
                        // 真信号是反向：内部有键但 OS 已无 → rdev 漏报 release，
                        // 幽灵 modifier 被纠正掉。只在这种情况打 WARN。
                        let removed: HashSet<Mod> =
                            prev.difference(&s.pressed).cloned().collect();
                        if !removed.is_empty() {
                            log::warn!(
                                "[modifier_only] OS sync removed stale modifier(s): {:?} (prev={:?} → {:?}, event {:?} {})",
                                removed,
                                prev,
                                s.pressed,
                                key,
                                if is_press { "press" } else { "release" },
                            );
                        } else {
                            log::debug!(
                                "[modifier_only] OS sync filled in: {:?} → {:?} (event {:?} {})",
                                prev,
                                s.pressed,
                                key,
                                if is_press { "press" } else { "release" },
                            );
                        }
                    }
                    true
                } else {
                    false
                };

                if !os_synced {
                    // rdev 在 enigo 合成事件 / cmd-tab / 空间切换 / CGEventTap 短暂掉线
                    // 期间会丢事件。两类不一致信号 + 各自的恢复策略：
                    //
                    //   1) ghost release（release 但 pressed 不含此键）—— 漏了 press。
                    //   2) ghost press（press 但 pressed 已含此键）—— 漏了 release。
                    //
                    // 仅在没有 OS 校准时走此分支（macOS/Linux 当前路径）。
                    let ghost_release = !is_press && !s.pressed.contains(&m);
                    let ghost_press = is_press && s.pressed.contains(&m);
                    let is_ghost = ghost_release || ghost_press;

                    if is_ghost {
                        log::warn!(
                            "[modifier_only] ghost {phase} on {key:?} \
                             (pressed={:?}, active={:?}) — preserving state",
                            s.pressed,
                            s.active_ids,
                            phase = if ghost_press { "press" } else { "release" },
                        );
                    }

                    if ghost_release {
                        // 合成"丢失的 press"：临时把 m insert 进 pressed，subset 匹配
                        // bindings——任何 mods ⊆ pressed 的 binding 都算命中。pressed 里
                        // 已有的其他真实 modifier 留着，让多键 binding 能正确命中。
                        s.pressed.insert(m);
                        let virtual_matching: HashSet<BindingId> = s
                            .bindings
                            .iter()
                            .filter(|b| !b.mods.is_empty() && b.mods.is_subset(&s.pressed))
                            .map(|b| b.id)
                            .collect();
                        let to_synth: Vec<(BindingId, String)> = s
                            .bindings
                            .iter()
                            .filter(|b| {
                                virtual_matching.contains(&b.id)
                                    && !s.active_ids.contains(&b.id)
                            })
                            .map(|b| (b.id, b.id_str.clone()))
                            .collect();
                        for (id, _) in &to_synth {
                            s.active_ids.insert(*id);
                        }
                        let synth_count = to_synth.len();
                        newly_pressed.extend(to_synth);
                        let bindings_dump: Vec<String> = s
                            .bindings
                            .iter()
                            .map(|b| format!("{}:{:?}", b.id_str, b.mods))
                            .collect();
                        log::warn!(
                            "[modifier_only] ghost release recovery on {key:?} → \
                             synthesized {synth_count} press (pressed={:?}, active={:?}, \
                             bindings_count={}, bindings=[{}])",
                            s.pressed,
                            s.active_ids,
                            bindings_dump.len(),
                            bindings_dump.join(", "),
                        );
                        // pressed.insert 已经做了，跳过下面的"正常 pressed 更新"——
                        // 直接做 release：从 pressed 移除让 release 路径正常执行。
                    }

                    if is_press {
                        s.pressed.insert(m);
                    } else {
                        s.pressed.remove(&m);
                    }
                }

                // 正常路径用 exact match 保留"修饰键集合完全相等"的语义；ghost 路径
                // 已经把 pressed 清干净，subset 与 exact 等价。
                let matching: HashSet<BindingId> = s
                    .bindings
                    .iter()
                    .filter(|b| b.mods == s.pressed)
                    .map(|b| b.id)
                    .collect();

                for b in &s.bindings {
                    let was_active = s.active_ids.contains(&b.id);
                    let is_active = matching.contains(&b.id);
                    if !was_active && is_active {
                        newly_pressed.push((b.id, b.id_str.clone()));
                    } else if was_active && !is_active {
                        newly_released.push((b.id, b.id_str.clone()));
                    }
                }

                s.active_ids = matching;
                (newly_pressed, newly_released)
            };

            for (id, id_str) in newly_pressed_ids {
                log::warn!("[modifier_only] pressed: {id_str} id={id:?}");
                // 与 combo 路径一致：按下立即 show overlay 消除感知延迟
                if let Err(e) = crate::overlay::show(&app_clone) {
                    log::warn!("[overlay] show failed: {e:?}");
                }
                crate::cue::play_start();
                let payload = HotkeyEventPayload {
                    id,
                    phase: "pressed",
                };
                if let Err(e) = app_clone.emit(HOTKEY_EVENT, payload) {
                    log::warn!("[modifier_only] emit pressed failed: {e:?}");
                }
            }
            for (id, id_str) in newly_released_ids {
                log::warn!("[modifier_only] released: {id_str} id={id:?}");
                let payload = HotkeyEventPayload {
                    id,
                    phase: "released",
                };
                if let Err(e) = app_clone.emit(HOTKEY_EVENT, payload) {
                    log::warn!("[modifier_only] emit released failed: {e:?}");
                }
            }
        });
        if let Err(e) = result {
            log::warn!(
                "[modifier_only] rdev::listen exited with error: {e:?}. \
                 modifier-only / Fn bindings will not work this session. \
                 Check macOS Accessibility / Input Monitoring permissions."
            );
        }
    });
}

/// 从 apply_bindings 调用：用当前快照替换已注册的 modifier-only bindings。
/// 同时清掉 `active_ids`（但不清 `pressed`），避免切换绑定时漏发 released。
pub fn apply(
    state: &SharedModifierOnlyState,
    bindings: &[(String, HotkeyBinding)],
) -> Result<(), String> {
    let mut new_bindings: Vec<ModBinding> = Vec::new();
    for (id_str, b) in bindings {
        if b.kind != "modifierOnly" {
            continue;
        }
        if !b.code.is_empty() {
            log::warn!(
                "[modifier_only]   skip {id_str}: kind=modifierOnly but code={:?} (must be empty)",
                b.code
            );
            continue;
        }
        let Some(id) = parse_binding_id(id_str) else {
            log::warn!("[modifier_only]   skip unknown id: {id_str}");
            continue;
        };
        let mods: HashSet<Mod> = b.mods.iter().filter_map(|s| str_to_mod(s)).collect();
        if mods.is_empty() {
            log::warn!("[modifier_only]   skip {id_str}: empty mods after parse");
            continue;
        }
        new_bindings.push(ModBinding {
            id,
            id_str: id_str.clone(),
            mods,
        });
    }

    let mut s = state.lock().map_err(|e| e.to_string())?;
    log::warn!(
        "[modifier_only] apply: {} binding(s) registered",
        new_bindings.len()
    );
    for b in &new_bindings {
        log::warn!("[modifier_only]   - {} mods={:?}", b.id_str, b.mods);
    }
    s.bindings = new_bindings;
    s.active_ids.clear();
    Ok(())
}
