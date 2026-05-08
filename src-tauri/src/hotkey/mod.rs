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

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutEvent, ShortcutState,
};

pub mod modifier_only;
pub use modifier_only::SharedModifierOnlyState;

pub const HOTKEY_EVENT: &str = "openspeech://hotkey";
pub const HOTKEY_BLOCKED_BY_MEETING_EVENT: &str = "openspeech://hotkey-blocked-by-meeting";

/// 会议录制中需要拦的录音类绑定。
fn is_recording_binding(id: BindingId) -> bool {
    matches!(
        id,
        BindingId::DictatePtt | BindingId::DictateToggle | BindingId::AskAi | BindingId::Translate
    )
}

/// 记录被会议拦掉的"按下"——release 时一起吞掉，避免前端 FSM 收到孤立 release。
fn meeting_blocked_set() -> &'static Mutex<HashSet<BindingId>> {
    static SET: OnceLock<Mutex<HashSet<BindingId>>> = OnceLock::new();
    SET.get_or_init(|| Mutex::new(HashSet::new()))
}

/// 录制中按下听写/翻译/AskAI → emit 提示并返回 true，由调用方 return 跳过 overlay/cue/HOTKEY_EVENT。
/// release 阶段只判 set 再吞掉，不重复 emit toast。
pub fn maybe_block_for_meeting<R: Runtime>(
    app: &AppHandle<R>,
    id: BindingId,
    phase: &'static str,
) -> bool {
    if !is_recording_binding(id) {
        return false;
    }
    if phase == "released" {
        if let Ok(mut s) = meeting_blocked_set().lock() {
            return s.remove(&id);
        }
        return false;
    }
    if !crate::meetings::has_active() {
        return false;
    }
    if let Ok(mut s) = meeting_blocked_set().lock() {
        s.insert(id);
    }
    let _ = app.emit(HOTKEY_BLOCKED_BY_MEETING_EVENT, id);
    true
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "snake_case")]
pub enum BindingId {
    DictatePtt,
    DictateToggle,
    AskAi,
    Translate,
    ShowMainWindow,
    OpenToolbox,
    /// 拉起 quick panel 的「编辑上一条」模式（默认 Cmd/Ctrl+Shift+E）。
    /// 后续翻译 / 问答等 mode 会复用 quick panel 但用各自的 BindingId。
    EditLastRecord,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    Left,
    Right,
}

/// 修饰键 + 左右组合。fn 没有左右概念，单独占一项。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ModSide {
    Ctrl(Side),
    Alt(Side),
    Shift(Side),
    Meta(Side),
    Fn,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HotkeyBinding {
    /// `"combo"` | `"modifierOnly"` | `"doubleTap"`。v1 老数据没有此字段，
    /// 反序列化时回退到 `"combo"`，与 tauri-plugin-global-shortcut 现有路径兼容。
    #[serde(default = "default_kind")]
    pub kind: String,
    pub mods: Vec<String>,
    pub code: String,
    /// v3 新增：每个非 fn 修饰键的左右选择。fn 永远不在内。缺失项视为 "left"。
    /// 反序列化时接受 camelCase（`modSides`）字段。前端缺省时 None，匹配走"全 left"兜底。
    #[serde(rename = "modSides", default)]
    pub mod_sides: Option<HashMap<String, String>>,
}

fn default_kind() -> String {
    "combo".to_string()
}

/// 把 binding 的 mods + modSides 解析为精确的 (mod, side) 集合。
/// 每个 mod 的 side：先看 modSides，没填就视为 left；fn 走 ModSide::Fn 单独项。
/// 未识别的 mod 字符串会被静默忽略（log warn 由调用方做）。
pub fn binding_to_mod_sides(b: &HotkeyBinding) -> std::collections::HashSet<ModSide> {
    let sides = b.mod_sides.as_ref();
    let mut out = std::collections::HashSet::new();
    for m in &b.mods {
        let side = sides
            .and_then(|h| h.get(m.as_str()))
            .map(|s| s.as_str())
            .unwrap_or("left");
        let side_enum = match side {
            "right" => Side::Right,
            _ => Side::Left,
        };
        let item = match m.as_str() {
            "ctrl" => Some(ModSide::Ctrl(side_enum)),
            "alt" => Some(ModSide::Alt(side_enum)),
            "shift" => Some(ModSide::Shift(side_enum)),
            "meta" => Some(ModSide::Meta(side_enum)),
            "fn" => Some(ModSide::Fn),
            _ => None,
        };
        if let Some(it) = item {
            out.insert(it);
        }
    }
    out
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

/// active 表里每条 combo 同时携带"用户实际期望的 (mod, side) 集合"，handler
/// 触发时用 modifier_only::current_pressed() 二次校验，命中错误左右就丢弃事件。
/// expected 不含 fn（B3 已拦 fn 进 combo）。
#[derive(Debug, Clone)]
struct ActiveCombo {
    id: BindingId,
    id_str: String,
    expected: HashSet<ModSide>,
}

pub struct HotkeyState {
    active: HashMap<Shortcut, ActiveCombo>,
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
        "show_main_window" => Some(BindingId::ShowMainWindow),
        "open_toolbox" => Some(BindingId::OpenToolbox),
        "edit_last_record" => Some(BindingId::EditLastRecord),
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
    // B3: combo 路径不支持 fn——Carbon RegisterEventHotKey / Win RegisterHotKey 都
    // 不接受 Fn 修饰位。前端 isLegalBinding 已拦，这里再拒一次防御。
    if binding.mods.iter().any(|m| m == "fn") {
        log::warn!(
            "[hotkey]   refuse combo with fn modifier: mods={:?} code={}",
            binding.mods,
            binding.code
        );
        return None;
    }
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
    let mut desired: HashMap<Shortcut, ActiveCombo> = HashMap::new();
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
        let expected = binding_to_mod_sides(binding);
        desired.insert(
            sc,
            ActiveCombo {
                id,
                id_str: id_str.clone(),
                expected,
            },
        );
    }

    // 幂等：如果目标与当前激活完全一致，跳过所有 OS 调用。
    let same = desired.len() == s.active.len()
        && desired.iter().all(|(sc, want)| {
            s.active
                .get(sc)
                .is_some_and(|cur| cur.id == want.id && cur.expected == want.expected)
        });
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
    let mut next: HashMap<Shortcut, ActiveCombo> = HashMap::new();
    for (sc, combo) in desired {
        let result = plugin.register(sc).or_else(|first_err| {
            // OS 层可能残留（上次 crash / HMR 残留）；先 unregister 再重试一次。
            log::warn!(
                "[hotkey]   first register failed for {}: {first_err:?}; retry after unregister",
                combo.id_str
            );
            let _ = plugin.unregister(sc);
            plugin.register(sc)
        });

        match result {
            Ok(()) => {
                log::warn!(
                    "[hotkey]   registered {} -> {sc:?} expected={:?}",
                    combo.id_str,
                    combo.expected
                );
                next.insert(sc, combo);
            }
            Err(e) => {
                log::warn!(
                    "[hotkey]   REGISTER FAILED for {} -> {sc:?}: {e:?}",
                    combo.id_str
                );
                let _ = app.emit(
                    "openspeech://hotkey/register-failed",
                    serde_json::json!({ "id": combo.id_str, "error": format!("{e:?}") }),
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
    let (id, expected) = {
        let Ok(s) = state.lock() else {
            log::warn!("[hotkey] handler: lock poisoned");
            return;
        };
        let Some(combo) = s.active.get(shortcut) else {
            log::warn!("[hotkey] handler: unrecognized shortcut {shortcut:?}");
            return;
        };
        (combo.id, combo.expected.clone())
    };

    // D2 二次校验：OS Carbon / Win API 触发时不区分左右，rdev 维护着真实物理按键
    // 状态。expected 必须是当前真实按下集合的子集（用户允许多按其它键，但绑定要求
    // 的左右必须全在）。校验失败时静默丢弃事件，不 emit / 不 overlay / 不 cue，
    // 跟用户感知一致。
    if let Some(mo_state) = app.try_state::<SharedModifierOnlyState>() {
        let actual = modifier_only::current_pressed(&mo_state);
        if !expected.is_subset(&actual) {
            log::debug!(
                "[hotkey] handler: side mismatch on {shortcut:?} id={id:?} \
                 expected={expected:?} actual={actual:?} — drop"
            );
            return;
        }
    }

    let phase = match event.state() {
        ShortcutState::Pressed => "pressed",
        ShortcutState::Released => "released",
    };

    log::warn!("[hotkey] handler: {shortcut:?} id={id:?} phase={phase}");

    // ShowMainWindow 是 toggle：当前已可见且聚焦 → 隐藏；否则 show + focus。
    // 不进 overlay show、也不 emit 给前端 recording listener，避免 activeId 串扰。
    if matches!(id, BindingId::ShowMainWindow) {
        if phase == "pressed" {
            crate::toggle_main_window(app);
        }
        return;
    }

    // OpenToolbox 是 toggle：是否 hide 取决于「当前路由 + 主窗聚焦」，后端拿不到路由——
    // 只把事件抛给前端，由 Layout 监听后决定 show+navigate 还是 hide_to_tray。
    if matches!(id, BindingId::OpenToolbox) {
        if phase == "pressed" {
            let _ = app.emit("openspeech://hotkey-open-toolbox", ());
        }
        return;
    }

    // EditLastRecord：直接拉起 quick panel 的 edit-last-record 模式。
    // 不进 overlay show / cue / HOTKEY_EVENT —— 这是非录音类操作，与主窗口完全解耦，
    // 主窗口隐藏在托盘也照样工作。
    if matches!(id, BindingId::EditLastRecord) {
        if phase == "pressed" {
            if let Err(e) = crate::quick_panel::show(app, "edit-last-record") {
                log::warn!("[quick-panel] show failed: {e:?}");
            }
        }
        return;
    }

    // 按下立即 show overlay（不等前端事件往返，消除 50-100ms 感知延迟）；
    // hide 交给 overlay 窗口自己——进入 idle 状态时 invoke overlay_hide。
    // 即使会议录制中也照样弹一下：让用户看到视觉反馈，前端 FSM 没收到 pressed
    // 会自动把 overlay 收起来。
    if phase == "pressed" {
        if let Err(e) = crate::overlay::show(app) {
            log::warn!("[overlay] show failed: {e:?}");
        }
    }

    // 会议录制中拦下听写/翻译/Ask 的录音类绑定——不播开录音 cue、不进 FSM、emit toast。
    if maybe_block_for_meeting(app, id, phase) {
        return;
    }

    if phase == "pressed" {
        // 与 overlay::show 同帧触发 start cue。cue 模块自己判 ENABLED + ACTIVE，
        // 录音中再按一次（toggle off）不会重复播 start。stop / cancel 由前端
        // 在 state 过渡时通过 cue_play 命令补播。
        crate::cue::play_start();
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
    log::debug!("[hotkey] esc_capture_start: Esc swallowed from foreground app");
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
    log::debug!("[hotkey] esc_capture_stop: Esc returned to foreground");
    Ok(())
}
