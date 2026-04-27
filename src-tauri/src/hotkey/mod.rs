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

#[derive(Debug, Clone, Deserialize)]
pub struct HotkeyBinding {
    /// `"combo"` | `"modifierOnly"` | `"doubleTap"`。v1 老数据没有此字段，
    /// 反序列化时回退到 `"combo"`，与 tauri-plugin-global-shortcut 现有路径兼容。
    #[serde(default = "default_kind")]
    pub kind: String,
    pub mods: Vec<String>,
    pub code: String,
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
    pub phase: &'static str, // "pressed" | "released"
}

// 当前已注册的 shortcut → BindingId 的映射
pub struct HotkeyState {
    active: HashMap<Shortcut, BindingId>,
}

impl Default for HotkeyState {
    fn default() -> Self {
        Self {
            active: HashMap::new(),
        }
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
    log::warn!(
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
            log::warn!("[hotkey] modifier_only apply failed: {e}");
        }
    } else {
        log::warn!(
            "[hotkey] SharedModifierOnlyState missing; skip {} modifier-only binding(s)",
            modifier_only_bindings.len()
        );
    }

    // 1. 先计算 combo 目标集合，便于幂等判断。
    let mut desired: HashMap<Shortcut, (String, BindingId)> = HashMap::new();
    for (id_str, maybe) in &payload.bindings {
        let Some(id) = parse_binding_id(id_str) else {
            log::warn!("[hotkey]   skip unknown id: {id_str}");
            continue;
        };
        let Some(binding) = maybe else {
            log::warn!("[hotkey]   skip null binding: {id_str}");
            continue;
        };
        // modifierOnly 已在上方分流；doubleTap 待实现，先 skip。
        if binding.kind != "combo" {
            if binding.kind != "modifierOnly" {
                log::warn!(
                    "[hotkey]   skip non-combo binding {id_str}: kind={} (not yet implemented)",
                    binding.kind
                );
            }
            continue;
        }
        let Some(sc) = build_shortcut(binding) else {
            log::warn!(
                "[hotkey]   failed to parse shortcut for {id_str}: mods={:?} code={}",
                binding.mods, binding.code
            );
            continue;
        };
        if desired.contains_key(&sc) {
            log::warn!("[hotkey]   duplicate shortcut skipped for {id_str}: {sc:?}");
            continue;
        }
        desired.insert(sc, (id_str.clone(), id));
    }

    // 幂等：如果目标与当前激活完全一致，跳过所有 OS 调用。
    let same = desired.len() == s.active.len()
        && desired
            .iter()
            .all(|(sc, (_, id))| s.active.get(sc).is_some_and(|aid| aid == id));
    if same {
        log::warn!(
            "[hotkey] apply_bindings: no-op, already at target ({} active)",
            s.active.len()
        );
        return Ok(());
    }

    // 2. unregister 当前激活的全部 shortcut
    for sc in s.active.keys() {
        log::warn!("[hotkey]   unregister previous: {sc:?}");
        let _ = plugin.unregister(*sc);
    }
    s.active.clear();

    // 3. register 新的
    let mut next: HashMap<Shortcut, BindingId> = HashMap::new();
    for (sc, (id_str, id)) in desired {
        let result = plugin.register(sc).or_else(|first_err| {
            // OS 层可能残留（上次 crash / HMR 残留）；先 unregister 再重试一次。
            log::warn!(
                "[hotkey]   first register failed for {id_str}: {first_err:?}; retry after unregister"
            );
            let _ = plugin.unregister(sc);
            plugin.register(sc)
        });

        match result {
            Ok(()) => {
                log::warn!("[hotkey]   registered {id_str} -> {sc:?}");
                next.insert(sc, id);
            }
            Err(e) => {
                log::warn!("[hotkey]   REGISTER FAILED for {id_str} -> {sc:?}: {e:?}");
                let _ = app.emit(
                    "openspeech://hotkey/register-failed",
                    serde_json::json!({ "id": id_str, "error": format!("{e:?}") }),
                );
            }
        }
    }

    let total = next.len();
    s.active = next;
    log::warn!("[hotkey] apply_bindings done: {total} active shortcuts");

    Ok(())
}

pub fn handler<R: Runtime>(app: &AppHandle<R>, shortcut: &Shortcut, event: ShortcutEvent) {
    // ESC 注册仅用于"吞键"，业务逻辑走 rdev 的 key-preview 通道（已有 ARM/双击确认）。
    // 这里 short-circuit 避免 "unrecognized shortcut" 噪声日志。
    if *shortcut == esc_shortcut() {
        return;
    }
    let Some(state) = app.try_state::<SharedHotkeyState>() else {
        log::warn!("[hotkey] handler: SharedHotkeyState missing");
        return;
    };
    let Ok(s) = state.lock() else {
        log::warn!("[hotkey] handler: lock poisoned");
        return;
    };
    let Some(&id) = s.active.get(shortcut) else {
        log::warn!("[hotkey] handler: unrecognized shortcut {shortcut:?}");
        return;
    };
    drop(s);

    let phase = match event.state() {
        ShortcutState::Pressed => "pressed",
        ShortcutState::Released => "released",
    };

    log::warn!("[hotkey] handler: {shortcut:?} id={id:?} phase={phase}");

    // 按下立即 show overlay（不等前端事件往返，消除 50-100ms 感知延迟）；
    // hide 交给 overlay 窗口自己——进入 idle 状态时 invoke overlay_hide。
    if phase == "pressed" {
        if let Err(e) = crate::overlay::show(app) {
            log::warn!("[overlay] show failed: {e:?}");
        }
    }

    let payload = HotkeyEventPayload { id, phase };
    if let Err(e) = app.emit(HOTKEY_EVENT, payload) {
        log::warn!("[hotkey] emit failed: {e:?}");
    }
}

#[tauri::command]
pub async fn apply_hotkey_config<R: Runtime>(
    app: AppHandle<R>,
    payload: HotkeyConfigPayload,
) -> Result<(), String> {
    apply_bindings(&app, &payload)
}

/// 前端 booted=true 后调用一次，启动 rdev::listen 全局键盘订阅线程。
/// 幂等：模块内 `LISTEN_STARTED` AtomicBool 保证多次调用只启一次。
/// **为什么不在 setup 阶段启动**：rdev::listen 首次访问全局键盘流会触发
/// macOS「Keystroke Receiving」授权弹框，setup 阶段立即弹会被随后 show 的
/// 主窗口遮挡。前端等 LoadingScreen 退场、主窗口完全可见后再 invoke 这条
/// 命令——弹框正常叠在主窗口之上。
#[tauri::command]
pub fn hotkey_init_listener<R: Runtime>(app: AppHandle<R>) {
    let Some(state) = app.try_state::<SharedModifierOnlyState>() else {
        log::warn!("[hotkey] hotkey_init_listener: SharedModifierOnlyState missing");
        return;
    };
    let state_arc: SharedModifierOnlyState = state.inner().clone();
    modifier_only::start_listener(app.clone(), state_arc);
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
    log::warn!("[hotkey] pause_combos: unregistered {count} shortcut(s)");
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
            Err(e) => log::warn!("[hotkey] resume_combos: register {sc:?} failed: {e:?}"),
        }
    }
    log::warn!("[hotkey] resume_combos: re-registered {count} shortcut(s)");
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
        log::warn!("[hotkey] set_hotkey_recording({enabled}) combo toggle failed: {e}");
    }
}

/// 录音活跃期间临时把 Esc 注册为全局快捷键，**吞掉**前台应用对 Esc 的响应。
/// 默认 rdev::listen 是只读观察（CGEventTapCreate listenOnly），无法 swallow；
/// 用户在 Cursor / 编辑器里按 Esc 取消录音时，编辑器会同时退出 vim 模式 / 关 IME
/// candidate window —— 这是用户报"按 Esc 也会触发当前激活软件功能"的根源。
///
/// global-shortcut 用 Carbon RegisterEventHotKey（macOS）/ RegisterHotKey（Win），
/// 注册后 OS 直接 short-circuit 给我们的 handler，不再 dispatch 给前台。rdev 仍能
/// 观测到（不同层级），所以前端原本基于 `openspeech://key-preview` 的 ESC ARM
/// 逻辑保持不变；这里只解决"吞键"问题。
///
/// 幂等：重复 start / start 期间又 start 都安全。`esc_capture_stop` 在录音状态机
/// 离开 active 态（idle/error/cancelled）时调用，**必须保证最终调到**——否则
/// 用户在浏览器等 app 里 Esc 全失效，体验灾难。
fn esc_shortcut() -> Shortcut {
    Shortcut::new(None, Code::Escape)
}

#[tauri::command]
pub fn esc_capture_start<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let plugin = app.global_shortcut();
    let sc = esc_shortcut();
    if plugin.is_registered(sc) {
        return Ok(());
    }
    plugin
        .register(sc)
        .or_else(|first_err| {
            log::warn!("[hotkey] esc_capture_start: first register failed: {first_err:?}; retry");
            let _ = plugin.unregister(sc);
            plugin.register(sc)
        })
        .map_err(|e| {
            log::warn!("[hotkey] esc_capture_start failed: {e:?}");
            format!("esc_capture_start: {e}")
        })?;
    log::warn!("[hotkey] esc_capture_start: Esc swallowed from foreground app");
    Ok(())
}

#[tauri::command]
pub fn esc_capture_stop<R: Runtime>(app: AppHandle<R>) -> Result<(), String> {
    let plugin = app.global_shortcut();
    let sc = esc_shortcut();
    if !plugin.is_registered(sc) {
        return Ok(());
    }
    plugin.unregister(sc).map_err(|e| {
        log::warn!("[hotkey] esc_capture_stop failed: {e:?}");
        format!("esc_capture_stop: {e}")
    })?;
    log::warn!("[hotkey] esc_capture_stop: Esc returned to foreground");
    Ok(())
}
