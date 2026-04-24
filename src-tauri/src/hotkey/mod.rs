// OpenSpeech 全局快捷键编排
//
// 职责：
// 1. 接收前端传来的 canonical binding（mods + code + mode），注册到 tauri-plugin-global-shortcut
// 2. 监听 Pressed / Released 事件，emit 到前端 FSM
// 3. 热重载：前端改快捷键 → unregister(old) → register(new)
//
// 非本模块职责（见 task #13）：
// - Esc 取消 / PTT 松开 keystate 轮询：走 rdev 全局监听，在录音模块实现
// - 实际录音 / 注入：录音模块

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

pub mod modifier_only;
pub use modifier_only::SharedModifierOnlyState;

pub const HOTKEY_EVENT: &str = "openspeech://hotkey";

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BindingId {
    DictatePtt,
    DictateToggle,
    AskAi,
    Translate,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HotkeyMode {
    Hold,
    Toggle,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HotkeyBinding {
    /// `"combo"` | `"modifierOnly"` | `"doubleTap"`。v1 老数据没有此字段，
    /// 反序列化时回退到 `"combo"`，与 tauri-plugin-global-shortcut 现有路径兼容。
    #[serde(default = "default_kind")]
    pub kind: String,
    pub mods: Vec<String>,
    pub code: String,
    pub mode: HotkeyMode,
}

fn default_kind() -> String {
    "combo".to_string()
}

#[derive(Debug, Clone, Deserialize)]
pub struct HotkeyConfigPayload {
    pub bindings: HashMap<String, Option<HotkeyBinding>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct HotkeyEventPayload {
    pub id: BindingId,
    pub mode: HotkeyMode,
    pub phase: &'static str, // "pressed" | "released"
}

// 当前已注册的 shortcut → BindingId 的映射
pub struct HotkeyState {
    active: HashMap<Shortcut, (BindingId, HotkeyMode)>,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self { active: HashMap::new() }
    }
}

pub type SharedHotkeyState = Mutex<HotkeyState>;

fn parse_binding_id(s: &str) -> Option<BindingId> {
    match s {
        "dictate_ptt" => Some(BindingId::DictatePtt),
        "dictate_toggle" => Some(BindingId::DictateToggle),
        "ask_ai" => Some(BindingId::AskAi),
        "translate" => Some(BindingId::Translate),
        _ => None,
    }
}

fn parse_mods(mods: &[String]) -> Modifiers {
    let mut m = Modifiers::empty();
    for s in mods {
        match s.as_str() {
            "ctrl" => m |= Modifiers::CONTROL,
            "alt" => m |= Modifiers::ALT,
            "shift" => m |= Modifiers::SHIFT,
            "meta" => m |= Modifiers::SUPER,
            _ => {}
        }
    }
    m
}

fn parse_code(code: &str) -> Option<Code> {
    // UI Events KeyboardEvent.code 到 Code 枚举
    // 覆盖常见情形；不全时返回 None，由上层拒绝注册。
    use std::str::FromStr;
    // tauri-plugin-global-shortcut 的 Code 来自 keyboard-types 并实现了 FromStr
    Code::from_str(code).ok()
}

fn build_shortcut(binding: &HotkeyBinding) -> Option<Shortcut> {
    let mods = parse_mods(&binding.mods);
    let code = parse_code(&binding.code)?;
    Some(Shortcut::new(Some(mods), code))
}

pub fn apply_bindings<R: Runtime>(
    app: &AppHandle<R>,
    payload: &HotkeyConfigPayload,
) -> Result<(), String> {
    eprintln!(
        "[hotkey] apply_bindings: {} entries",
        payload.bindings.len()
    );
    let state = app
        .try_state::<SharedHotkeyState>()
        .ok_or_else(|| "HotkeyState not initialized".to_string())?;
    let plugin = app.global_shortcut();

    // 整个 unregister→register 流程独占锁，避免并发 apply 交错造成系统层重复注册。
    let mut s = state.lock().map_err(|e| e.to_string())?;

    // 先把 modifier-only 路径分流出去（走 rdev 订阅，不占用系统快捷键注册名额）。
    let modifier_only_bindings: Vec<(String, HotkeyBinding)> = payload
        .bindings
        .iter()
        .filter_map(|(id_str, maybe)| {
            let b = maybe.as_ref()?;
            if b.kind == "modifierOnly" {
                Some((id_str.clone(), b.clone()))
            } else {
                None
            }
        })
        .collect();
    if let Some(mo_state) = app.try_state::<SharedModifierOnlyState>() {
        if let Err(e) = modifier_only::apply(&mo_state, &modifier_only_bindings) {
            eprintln!("[hotkey] modifier_only apply failed: {e}");
        }
    } else {
        eprintln!(
            "[hotkey] SharedModifierOnlyState missing; skip {} modifier-only binding(s)",
            modifier_only_bindings.len()
        );
    }

    // 1. 先计算 combo 目标集合，便于幂等判断。
    let mut desired: HashMap<Shortcut, (String, BindingId, HotkeyMode)> = HashMap::new();
    for (id_str, maybe) in &payload.bindings {
        let Some(id) = parse_binding_id(id_str) else {
            eprintln!("[hotkey]   skip unknown id: {id_str}");
            continue;
        };
        let Some(binding) = maybe else {
            eprintln!("[hotkey]   skip null binding: {id_str}");
            continue;
        };
        // modifierOnly 已在上方分流；doubleTap 待实现，先 skip。
        if binding.kind != "combo" {
            if binding.kind != "modifierOnly" {
                eprintln!(
                    "[hotkey]   skip non-combo binding {id_str}: kind={} (not yet implemented)",
                    binding.kind
                );
            }
            continue;
        }
        let Some(sc) = build_shortcut(binding) else {
            eprintln!(
                "[hotkey]   failed to parse shortcut for {id_str}: mods={:?} code={}",
                binding.mods, binding.code
            );
            continue;
        };
        if desired.contains_key(&sc) {
            eprintln!("[hotkey]   duplicate shortcut skipped for {id_str}: {sc:?}");
            continue;
        }
        desired.insert(sc, (id_str.clone(), id, binding.mode));
    }

    // 幂等：如果目标与当前激活完全一致，跳过所有 OS 调用。
    let same = desired.len() == s.active.len()
        && desired.iter().all(|(sc, (_, id, mode))| {
            s.active.get(sc).is_some_and(|(aid, amode)| aid == id && amode == mode)
        });
    if same {
        eprintln!(
            "[hotkey] apply_bindings: no-op, already at target ({} active)",
            s.active.len()
        );
        return Ok(());
    }

    // 2. unregister 当前激活的全部 shortcut
    for sc in s.active.keys() {
        eprintln!("[hotkey]   unregister previous: {sc:?}");
        let _ = plugin.unregister(*sc);
    }
    s.active.clear();

    // 3. register 新的
    let mut next: HashMap<Shortcut, (BindingId, HotkeyMode)> = HashMap::new();
    for (sc, (id_str, id, mode)) in desired {
        let result = plugin.register(sc).or_else(|first_err| {
            // OS 层可能残留（上次 crash / HMR 残留）；先 unregister 再重试一次。
            eprintln!(
                "[hotkey]   first register failed for {id_str}: {first_err:?}; retry after unregister"
            );
            let _ = plugin.unregister(sc);
            plugin.register(sc)
        });

        match result {
            Ok(()) => {
                eprintln!("[hotkey]   registered {id_str} -> {sc:?} (mode={mode:?})");
                next.insert(sc, (id, mode));
            }
            Err(e) => {
                eprintln!("[hotkey]   REGISTER FAILED for {id_str} -> {sc:?}: {e:?}");
                let _ = app.emit(
                    "openspeech://hotkey/register-failed",
                    serde_json::json!({ "id": id_str, "error": format!("{e:?}") }),
                );
            }
        }
    }

    let total = next.len();
    s.active = next;
    eprintln!("[hotkey] apply_bindings done: {total} active shortcuts");

    Ok(())
}

pub fn handler<R: Runtime>(
    app: &AppHandle<R>,
    shortcut: &Shortcut,
    event: ShortcutEvent,
) {
    let Some(state) = app.try_state::<SharedHotkeyState>() else {
        eprintln!("[hotkey] handler: SharedHotkeyState missing");
        return;
    };
    let Ok(s) = state.lock() else {
        eprintln!("[hotkey] handler: lock poisoned");
        return;
    };
    let Some(&(id, mode)) = s.active.get(shortcut) else {
        eprintln!("[hotkey] handler: unrecognized shortcut {shortcut:?}");
        return;
    };
    drop(s);

    let phase = match event.state() {
        ShortcutState::Pressed => "pressed",
        ShortcutState::Released => "released",
    };

    eprintln!("[hotkey] handler: {shortcut:?} id={id:?} phase={phase}");

    // 按下立即 show overlay（不等前端事件往返，消除 50-100ms 感知延迟）；
    // hide 交给 overlay 窗口自己——进入 idle 状态时 invoke overlay_hide。
    if phase == "pressed" {
        if let Err(e) = crate::overlay::show(app) {
            eprintln!("[overlay] show failed: {e:?}");
        }
    }

    let payload = HotkeyEventPayload { id, mode, phase };
    if let Err(e) = app.emit(HOTKEY_EVENT, payload) {
        eprintln!("[hotkey] emit failed: {e:?}");
    }
}

#[tauri::command]
pub async fn apply_hotkey_config<R: Runtime>(
    app: AppHandle<R>,
    payload: HotkeyConfigPayload,
) -> Result<(), String> {
    apply_bindings(&app, &payload)
}

/// 录入期间从 OS 层反注册所有 combo——避免用户在录入框里按到 `Ctrl+Shift+Space`
/// 时原听写快捷键同时被系统触发。`HotkeyState.active` 保留不动，作为"目标快照"
/// 供 `resume_combos` 恢复。
fn pause_combos<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<SharedHotkeyState>()
        .ok_or_else(|| "HotkeyState missing".to_string())?;
    let plugin = app.global_shortcut();
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut count = 0;
    for sc in s.active.keys() {
        if plugin.unregister(*sc).is_ok() {
            count += 1;
        }
    }
    eprintln!("[hotkey] pause_combos: unregistered {count} shortcut(s)");
    Ok(())
}

fn resume_combos<R: Runtime>(app: &AppHandle<R>) -> Result<(), String> {
    let state = app
        .try_state::<SharedHotkeyState>()
        .ok_or_else(|| "HotkeyState missing".to_string())?;
    let plugin = app.global_shortcut();
    let s = state.lock().map_err(|e| e.to_string())?;
    let mut count = 0;
    for sc in s.active.keys() {
        match plugin.register(*sc) {
            Ok(()) => count += 1,
            Err(e) => eprintln!("[hotkey] resume_combos: register {sc:?} failed: {e:?}"),
        }
    }
    eprintln!("[hotkey] resume_combos: re-registered {count} shortcut(s)");
    Ok(())
}

/// 前端 HotkeyField 进入/退出录入态时调用。两件事必须成对：
/// 1. `modifier_only::set_recording` —— rdev 事件 pass-through 到
///    `openspeech://hotkey-recording`，让 Fn 等 DOM 收不到的键可录入
/// 2. `pause_combos` / `resume_combos` —— 反/重注册 OS 层的 combo 快捷键，
///    避免用户按到已绑定的组合时误触发原功能
#[tauri::command]
pub fn set_hotkey_recording<R: Runtime>(app: AppHandle<R>, enabled: bool) {
    modifier_only::set_recording(enabled);
    let res = if enabled {
        pause_combos(&app)
    } else {
        resume_combos(&app)
    };
    if let Err(e) = res {
        eprintln!("[hotkey] set_hotkey_recording({enabled}) combo toggle failed: {e}");
    }
}
