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

use rdev::{Event, EventType, Key};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use crate::hotkey::{BindingId, HOTKEY_EVENT, HotkeyBinding, HotkeyEventPayload, HotkeyMode};

/// 录入模式下，HotkeyField 订阅此事件拿到 press/release，代替 WebView DOM keydown
/// （macOS 上 Fn 键不会产生 DOM 事件，所以 DOM 监听器录不到）。
pub const HOTKEY_RECORDING_EVENT: &str = "openspeech://hotkey-recording";

/// 无条件的按键预览通道。**每次** rdev 收到 press/release 都会 emit，不参与 binding
/// 匹配、不受录入模式影响。用途：让前端（Home 页）给 Fn 等 DOM 拿不到的键也能做
/// 视觉反馈（按下时 Kbd 亮一下）。payload 与 RECORDING 事件同形。
pub const KEY_PREVIEW_EVENT: &str = "openspeech://key-preview";

/// 全局标志：前端进入录入态时 set true，退出时 set false。listen 线程每次
/// callback 读一次（Relaxed 足够，无多线程一致性要求）。开启时 callback 只
/// pass-through 给录入 UI，不参与 binding 匹配——避免录入期间误触发录音。
static RECORDING_ACTIVE: AtomicBool = AtomicBool::new(false);

pub fn set_recording(enabled: bool) {
    RECORDING_ACTIVE.store(enabled, Ordering::SeqCst);
    eprintln!("[modifier_only] recording mode → {enabled}");
}

#[derive(Debug, Clone, Serialize)]
struct RecordingEvent {
    code: String,
    phase: &'static str, // "pressed" | "released"
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
        KeyA => "KeyA", KeyB => "KeyB", KeyC => "KeyC", KeyD => "KeyD",
        KeyE => "KeyE", KeyF => "KeyF", KeyG => "KeyG", KeyH => "KeyH",
        KeyI => "KeyI", KeyJ => "KeyJ", KeyK => "KeyK", KeyL => "KeyL",
        KeyM => "KeyM", KeyN => "KeyN", KeyO => "KeyO", KeyP => "KeyP",
        KeyQ => "KeyQ", KeyR => "KeyR", KeyS => "KeyS", KeyT => "KeyT",
        KeyU => "KeyU", KeyV => "KeyV", KeyW => "KeyW", KeyX => "KeyX",
        KeyY => "KeyY", KeyZ => "KeyZ",
        // Digits (top row)
        Num0 => "Digit0", Num1 => "Digit1", Num2 => "Digit2", Num3 => "Digit3",
        Num4 => "Digit4", Num5 => "Digit5", Num6 => "Digit6", Num7 => "Digit7",
        Num8 => "Digit8", Num9 => "Digit9",
        // Function keys
        F1 => "F1", F2 => "F2", F3 => "F3", F4 => "F4", F5 => "F5", F6 => "F6",
        F7 => "F7", F8 => "F8", F9 => "F9", F10 => "F10", F11 => "F11", F12 => "F12",
        F13 => "F13", F14 => "F14", F15 => "F15", F16 => "F16", F17 => "F17",
        F18 => "F18", F19 => "F19", F20 => "F20", F21 => "F21", F22 => "F22",
        F23 => "F23", F24 => "F24",
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
    mode: HotkeyMode,
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
        _ => None,
    }
}

/// 启动全局键盘订阅线程。整个进程生命周期只应调一次——`rdev::listen` 只能
/// 被调一次，多次调用会 panic 或无效。失败（如 macOS Accessibility 权限
/// 未授予）时只打日志不 panic，后续 apply 调用也不会崩，只是 Fn /
/// modifier-only 绑定不工作。
pub fn init<R: Runtime>(app: AppHandle<R>) -> SharedModifierOnlyState {
    let state: SharedModifierOnlyState = Arc::new(Mutex::new(ModifierOnlyState::default()));
    let state_clone = Arc::clone(&state);
    let app_clone = app.clone();

    std::thread::spawn(move || {
        eprintln!("[modifier_only] starting rdev::listen thread");
        let result = rdev::listen(move |event: Event| {
            let (key, is_press) = match event.event_type {
                EventType::KeyPress(k) => (k, true),
                EventType::KeyRelease(k) => (k, false),
                _ => return,
            };

            // 预览通道：无条件向前端发送每一个 press/release，让 Home 页给 Fn 等
            // DOM 拿不到的键也能做视觉反馈。与录入 / binding 匹配完全独立。
            let preview = RecordingEvent {
                code: rdev_key_to_code(key),
                phase: if is_press { "pressed" } else { "released" },
            };
            let _ = app_clone.emit(KEY_PREVIEW_EVENT, preview.clone());

            // 录入模式：额外 pass-through 给录入 UI（HotkeyField 用的），同时
            // short-circuit binding 匹配——否则录入时按下 Fn 会顺带触发原 dictate_ptt。
            if RECORDING_ACTIVE.load(Ordering::Relaxed) {
                if let Err(e) = app_clone.emit(HOTKEY_RECORDING_EVENT, preview) {
                    eprintln!("[modifier_only] emit recording failed: {e:?}");
                }
                return;
            }

            let Some(m) = rdev_key_to_mod(key) else {
                return;
            };

            let (newly_pressed_ids, newly_released_ids): (
                Vec<(BindingId, HotkeyMode, String)>,
                Vec<(BindingId, HotkeyMode, String)>,
            ) = {
                let mut s = match state_clone.lock() {
                    Ok(s) => s,
                    Err(_) => return, // poisoned
                };
                if is_press {
                    s.pressed.insert(m);
                } else {
                    s.pressed.remove(&m);
                }

                let mut matching: HashSet<BindingId> = HashSet::new();
                for b in &s.bindings {
                    if b.mods == s.pressed {
                        matching.insert(b.id);
                    }
                }

                let mut newly_pressed: Vec<(BindingId, HotkeyMode, String)> = Vec::new();
                let mut newly_released: Vec<(BindingId, HotkeyMode, String)> = Vec::new();

                for b in &s.bindings {
                    let was_active = s.active_ids.contains(&b.id);
                    let is_active = matching.contains(&b.id);
                    if !was_active && is_active {
                        newly_pressed.push((b.id, b.mode, b.id_str.clone()));
                    } else if was_active && !is_active {
                        newly_released.push((b.id, b.mode, b.id_str.clone()));
                    }
                }

                s.active_ids = matching;
                (newly_pressed, newly_released)
            };

            for (id, mode, id_str) in newly_pressed_ids {
                eprintln!("[modifier_only] pressed: {id_str} id={id:?} mode={mode:?}");
                // 与 combo 路径一致：按下立即 show overlay 消除感知延迟
                if let Err(e) = crate::overlay::show(&app_clone) {
                    eprintln!("[overlay] show failed: {e:?}");
                }
                let payload = HotkeyEventPayload {
                    id,
                    mode,
                    phase: "pressed",
                };
                if let Err(e) = app_clone.emit(HOTKEY_EVENT, payload) {
                    eprintln!("[modifier_only] emit pressed failed: {e:?}");
                }
            }
            for (id, mode, id_str) in newly_released_ids {
                eprintln!("[modifier_only] released: {id_str} id={id:?} mode={mode:?}");
                let payload = HotkeyEventPayload {
                    id,
                    mode,
                    phase: "released",
                };
                if let Err(e) = app_clone.emit(HOTKEY_EVENT, payload) {
                    eprintln!("[modifier_only] emit released failed: {e:?}");
                }
            }
        });
        if let Err(e) = result {
            eprintln!(
                "[modifier_only] rdev::listen exited with error: {e:?}. \
                 modifier-only / Fn bindings will not work this session. \
                 Check macOS Accessibility / Input Monitoring permissions."
            );
        }
    });

    state
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
            eprintln!(
                "[modifier_only]   skip {id_str}: kind=modifierOnly but code={:?} (must be empty)",
                b.code
            );
            continue;
        }
        let Some(id) = parse_binding_id(id_str) else {
            eprintln!("[modifier_only]   skip unknown id: {id_str}");
            continue;
        };
        let mods: HashSet<Mod> = b.mods.iter().filter_map(|s| str_to_mod(s)).collect();
        if mods.is_empty() {
            eprintln!("[modifier_only]   skip {id_str}: empty mods after parse");
            continue;
        }
        new_bindings.push(ModBinding {
            id,
            id_str: id_str.clone(),
            mods,
            mode: b.mode,
        });
    }

    let mut s = state.lock().map_err(|e| e.to_string())?;
    eprintln!(
        "[modifier_only] apply: {} binding(s) registered",
        new_bindings.len()
    );
    for b in &new_bindings {
        eprintln!("[modifier_only]   - {} mods={:?} mode={:?}", b.id_str, b.mods, b.mode);
    }
    s.bindings = new_bindings;
    s.active_ids.clear();
    Ok(())
}
