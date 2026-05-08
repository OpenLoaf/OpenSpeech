import i18n from "@/i18n";
import { detectPlatform, type Platform } from "@/lib/platform";

export type HotkeyMod = "ctrl" | "alt" | "shift" | "meta" | "fn";

/** 物理修饰键的左右；fn 没有左右概念，所以从此类型排除。 */
export type Side = "left" | "right";

/** 各修饰键实际左右选择；fn 永远不在内。缺失项视为 `"left"`（旧数据兼容）。 */
export type ModSides = Partial<Record<Exclude<HotkeyMod, "fn">, Side>>;

/**
 * 绑定形态：
 * - `combo`         —— 至少 1 修饰键 + 1 主键（`code` 非空），例：`Ctrl + Shift + Space`
 * - `modifierOnly`  —— 至少 2 个修饰键，无主键（`code === ""`）；单修饰键已在 isLegalBinding 拦截
 * - `doubleTap`     —— 双击单个修饰键（`mods.length === 1`，`code === ""`）
 */
export type BindingKind = "combo" | "modifierOnly" | "doubleTap";

/**
 * 全系统统一为 toggle 语义（按一下开始 · 再按一下结束），不再有 hold（长按）模式。
 *
 * `modSides` 在 v3 schema 引入：录入时按用户实际按下的物理键写左/右；旧数据 migrate
 * 阶段全部填 left。fn 不出现在此对象。匹配时缺失的 mod 当作 left。
 */
export interface HotkeyBinding {
  kind: BindingKind;
  mods: HotkeyMod[];
  code: string;
  modSides?: ModSides;
}

export const MOD_ORDER: readonly HotkeyMod[] = [
  "fn",
  "ctrl",
  "alt",
  "shift",
  "meta",
];

// 听写 PTT + 翻译听写 + 唤起主窗口 + 跳到 AI 工具页 + 打开 quick panel。`dictate_ptt` 名称沿用
// v1 数据兼容；`translate` 与 dictate_ptt 同走 modifierOnly；show_main_window / open_toolbox /
// edit_last_record 走 combo，只在 pressed 边沿触发一次。edit_last_record 拉起 quick panel 的
// edit-last-record 模式（Spotlight 风格独立小窗，主窗口完全不动）。
export const BINDING_IDS = [
  "dictate_ptt",
  "translate",
  "show_main_window",
  "open_toolbox",
  "edit_last_record",
] as const;
export type BindingId = (typeof BINDING_IDS)[number];

/**
 * 平台感知的默认快捷键：
 * - macOS:   PTT = `Fn + Control`（modifier-only，组合键避免 Intel Mac / 外接键盘
 *            上单 Fn 不可达 + 减少与系统 Fn 行为的歧义）
 * - Windows: PTT = `LAlt + Win`（modifier-only，Win 键在内部抽象为 `meta`）
 * - Linux:   PTT = `Ctrl + Super`（modifier-only）
 *
 * 唤起主窗口统一 `Ctrl + Alt + O`（macOS = ⌃⌥O）。三平台无系统占用，O 对应
 * OpenSpeech 助记，不与 PTT 默认冲突。
 */
export function getDefaultBindings(
  platform: Platform,
): Record<BindingId, HotkeyBinding | null> {
  let ptt: HotkeyBinding;
  let translate: HotkeyBinding;

  if (platform === "macos") {
    ptt = {
      kind: "modifierOnly",
      mods: ["fn", "ctrl"],
      code: "",
      modSides: { ctrl: "left" },
    };
    translate = {
      kind: "modifierOnly",
      mods: ["fn", "shift"],
      code: "",
      modSides: { shift: "left" },
    };
  } else if (platform === "windows") {
    // Windows 键只有一个，无需区分左右；这里 modSides 仍写 left 仅用于 Rust matcher 兜底
    ptt = {
      kind: "modifierOnly",
      mods: ["alt", "meta"],
      code: "",
      modSides: { alt: "left", meta: "left" },
    };
    translate = {
      kind: "modifierOnly",
      mods: ["shift", "meta"],
      code: "",
      modSides: { shift: "left", meta: "left" },
    };
  } else {
    ptt = {
      kind: "modifierOnly",
      mods: ["ctrl", "meta"],
      code: "",
      modSides: { ctrl: "left", meta: "left" },
    };
    translate = {
      kind: "modifierOnly",
      mods: ["alt", "meta"],
      code: "",
      modSides: { alt: "left", meta: "left" },
    };
  }

  const showMainWindow: HotkeyBinding = {
    kind: "combo",
    mods: ["ctrl", "alt"],
    code: "KeyO",
    modSides: { ctrl: "left", alt: "left" },
  };

  const openToolbox: HotkeyBinding = {
    kind: "combo",
    mods: ["ctrl", "alt"],
    code: "KeyT",
    modSides: { ctrl: "left", alt: "left" },
  };

  // macOS 用 Cmd+Shift+E（meta+shift），其它平台用 Ctrl+Shift+E：与各自系统的快速操作
  // 类快捷键习惯一致，且 E 对应 "Edit" 助记。
  const editLastRecord: HotkeyBinding =
    platform === "macos"
      ? {
          kind: "combo",
          mods: ["shift", "meta"],
          code: "KeyE",
          modSides: { shift: "left", meta: "left" },
        }
      : {
          kind: "combo",
          mods: ["ctrl", "shift"],
          code: "KeyE",
          modSides: { ctrl: "left", shift: "left" },
        };

  return {
    dictate_ptt: ptt,
    translate,
    show_main_window: showMainWindow,
    open_toolbox: openToolbox,
    edit_last_record: editLastRecord,
  };
}

/**
 * 兼容导出：老代码路径 `import { DEFAULT_BINDINGS }` 依然工作。
 * 通过 Proxy 延迟到首次访问时按 `detectPlatform()` 选定值，避免模块初始化阶段 `navigator` 未就绪。
 */
export const DEFAULT_BINDINGS: Record<BindingId, HotkeyBinding | null> =
  new Proxy({} as Record<BindingId, HotkeyBinding | null>, {
    get(_target, prop: string) {
      return getDefaultBindings(detectPlatform())[prop as BindingId];
    },
    has(_target, prop: string) {
      return (BINDING_IDS as readonly string[]).includes(prop);
    },
    ownKeys() {
      return [...BINDING_IDS];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  });

// 通过 Proxy 在每次访问时从 i18n 取值；切语言后下一次读取即生效。
export const BINDING_LABELS: Record<BindingId, string> = new Proxy(
  {} as Record<BindingId, string>,
  {
    get(_target, prop: string) {
      if (!(BINDING_IDS as readonly string[]).includes(prop)) return undefined;
      return i18n.t(`hotkey:binding.${prop}`);
    },
    has(_target, prop: string) {
      return (BINDING_IDS as readonly string[]).includes(prop);
    },
    ownKeys() {
      return [...BINDING_IDS];
    },
    getOwnPropertyDescriptor() {
      return { enumerable: true, configurable: true };
    },
  },
);

export function normalizeMods(mods: HotkeyMod[]): HotkeyMod[] {
  return [...new Set(mods)].sort(
    (a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b),
  );
}

const MOD_INFO_FROM_CODE: Record<
  string,
  { mod: HotkeyMod; side: Side | null }
> = {
  ControlLeft: { mod: "ctrl", side: "left" },
  ControlRight: { mod: "ctrl", side: "right" },
  AltLeft: { mod: "alt", side: "left" },
  AltRight: { mod: "alt", side: "right" },
  ShiftLeft: { mod: "shift", side: "left" },
  ShiftRight: { mod: "shift", side: "right" },
  MetaLeft: { mod: "meta", side: "left" },
  MetaRight: { mod: "meta", side: "right" },
  OSLeft: { mod: "meta", side: "left" },
  OSRight: { mod: "meta", side: "right" },
  // Fn 在 macOS KeyboardEvent.code 无稳定映射；此处接受自定义 "Fn" token，
  // 由 Rust 侧 CGEventTap / rdev fork 事件归一化后传入。fn 没有左右概念。
  Fn: { mod: "fn", side: null },
};

export function codeToMod(code: string): HotkeyMod | null {
  return MOD_INFO_FROM_CODE[code]?.mod ?? null;
}

export function codeToSide(code: string): Side | null {
  return MOD_INFO_FROM_CODE[code]?.side ?? null;
}

export function isModifierCode(code: string): boolean {
  return code in MOD_INFO_FROM_CODE;
}

/** 取 binding 中某 mod 的实际 side。fn 永远返回 null；缺失项默认 left。 */
export function getModSide(
  binding: Pick<HotkeyBinding, "modSides">,
  mod: HotkeyMod,
): Side | null {
  if (mod === "fn") return null;
  return binding.modSides?.[mod] ?? "left";
}

// 即使 allowSpecialKeys 也不放行：锁定类键的 release 在多平台不可靠（按一下 LED 切换，
// 释放事件可能不上报），Tab=焦点切换、Backspace/Delete=误删文本——误触代价过高且无替代
const ALWAYS_DISALLOWED_MAIN: readonly string[] = [
  "Tab",
  "Backspace",
  "Delete",
  "CapsLock",
  "NumLock",
  "ScrollLock",
];

// allowSpecialKeys=false 时拦截，开启后放行
const SPECIAL_KEYS_GATED: readonly string[] = [
  "Escape",
  "Enter",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

export function isLegalMainKey(
  code: string,
  mods: HotkeyMod[],
  allowSpecialKeys = false,
): { ok: boolean; reason?: string } {
  if (isModifierCode(code)) {
    return { ok: false, reason: i18n.t("hotkey:validation.needs_main_key") };
  }
  if (ALWAYS_DISALLOWED_MAIN.includes(code)) {
    return {
      ok: false,
      reason: i18n.t("hotkey:validation.combo_disallowed_main"),
    };
  }
  if (!allowSpecialKeys && SPECIAL_KEYS_GATED.includes(code)) {
    return { ok: false, reason: i18n.t("hotkey:validation.special_keys_locked") };
  }
  // 单按"输入键"会让每次敲字都触发——必须配修饰键。F1-F24 / 导航键 / 媒体键不在此列。
  if (mods.length === 0 && isTypingKey(code)) {
    return {
      ok: false,
      reason: i18n.t("hotkey:validation.typing_key_needs_modifier"),
    };
  }
  return { ok: true };
}

/**
 * 对整个 binding 做形态合法性校验。`combo` 内部走 `isLegalMainKey`；
 * `modifierOnly` / `doubleTap` 要求主键为空、修饰键数量合法。
 * `fn` 修饰键仅在 macOS 合法（Windows / Linux 硬件层就拦截）。
 */
export function isLegalBinding(
  binding: HotkeyBinding,
  platform: Platform,
  allowSpecialKeys = false,
): { ok: boolean; reason?: string } {
  if (binding.mods.includes("fn") && platform !== "macos") {
    return {
      ok: false,
      reason: i18n.t("hotkey:validation.fn_macos_only"),
    };
  }
  if (binding.kind === "modifierOnly") {
    if (binding.code !== "") {
      return { ok: false, reason: i18n.t("hotkey:validation.modifier_only_no_main") };
    }
    if (binding.mods.length < 1) {
      return {
        ok: false,
        reason: i18n.t("hotkey:validation.modifier_only_min"),
      };
    }
    return { ok: true };
  }
  if (binding.kind === "doubleTap") {
    if (binding.code !== "") {
      return { ok: false, reason: i18n.t("hotkey:validation.double_tap_no_main") };
    }
    if (binding.mods.length !== 1) {
      return { ok: false, reason: i18n.t("hotkey:validation.double_tap_single_mod") };
    }
    // B4: macOS 双击 Fn = 系统听写默认快捷键，会被系统先吞
    if (platform === "macos" && binding.mods[0] === "fn") {
      return {
        ok: false,
        reason: i18n.t("hotkey:validation.double_tap_fn_macos"),
      };
    }
    return { ok: true };
  }
  // combo 路径
  // B3: fn 在 combo 里被 Carbon RegisterEventHotKey 静默丢弃，等于"实际注册了
  // 不带 fn 的快捷键"——视觉欺骗用户，必须拦
  if (binding.mods.includes("fn")) {
    return { ok: false, reason: i18n.t("hotkey:validation.combo_no_fn") };
  }
  return isLegalMainKey(binding.code, binding.mods, allowSpecialKeys);
}

// 把 binding 的 (mod, side) 集合化用作子集判断；fn 单独序列化（无 side）
function modSideKey(mod: HotkeyMod, side: Side | null): string {
  return side ? `${mod}:${side}` : mod;
}

function bindingModSet(b: HotkeyBinding): Set<string> {
  const s = new Set<string>();
  for (const m of b.mods) s.add(modSideKey(m, getModSide(b, m)));
  return s;
}

function isStrictSubset(a: Set<string>, b: Set<string>): boolean {
  if (a.size >= b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * 跨 binding 冲突检测——比 `findConflict`（仅完全相等）更严格。
 *
 * 返回首个命中的冲突；调用方拿 i18n key 自行渲染。
 *
 * 检查项：
 *   C1 完全相等：现有 `findConflict` 行为，触发 replace flow
 *   C2 modifierOnly 互为真子集：递进激活会导致 A 释放 + B 触发的"幻影录音"
 *   C3 modifierOnly ⊊ combo.mods：按 modifierOnly 已 active，再按主键又触发 combo
 *   C4 doubleTap.mod 类型与 modifierOnly 任一 mod 类型相同：双击窗口与子集匹配冲突
 */
export type BindingConflict =
  | { kind: "equal"; with: BindingId }
  | { kind: "subset_modifier_only"; with: BindingId }
  | { kind: "subset_combo"; with: BindingId }
  | { kind: "double_tap_overlap_modifier"; with: BindingId };

export function findBindingConflict(
  bindings: Record<BindingId, HotkeyBinding | null>,
  candidate: HotkeyBinding,
  excludeId: BindingId,
): BindingConflict | null {
  const candSet = bindingModSet(candidate);
  const candModTypes = new Set(candidate.mods);

  for (const id of BINDING_IDS) {
    if (id === excludeId) continue;
    const other = bindings[id];
    if (!other) continue;

    if (bindingsEqual(other, candidate)) {
      return { kind: "equal", with: id };
    }

    const otherSet = bindingModSet(other);

    // C2: 两个都是 modifierOnly 且互为真子集
    if (candidate.kind === "modifierOnly" && other.kind === "modifierOnly") {
      if (isStrictSubset(candSet, otherSet) || isStrictSubset(otherSet, candSet)) {
        return { kind: "subset_modifier_only", with: id };
      }
    }

    // C3: modifierOnly ⊊ combo.mods（任意方向都拦）
    if (candidate.kind === "modifierOnly" && other.kind === "combo") {
      if (isStrictSubset(candSet, otherSet) || candSet.size === otherSet.size) {
        // size 相等已在 C1 等值分支或 mods 对比上处理；这里只看真子集
        if (isStrictSubset(candSet, otherSet)) {
          return { kind: "subset_combo", with: id };
        }
      }
    }
    if (candidate.kind === "combo" && other.kind === "modifierOnly") {
      if (isStrictSubset(otherSet, candSet)) {
        return { kind: "subset_combo", with: id };
      }
    }

    // C4: doubleTap 与 modifierOnly 共用同种 mod 类型（不看 side）
    if (candidate.kind === "doubleTap" && other.kind === "modifierOnly") {
      const dtMod = candidate.mods[0];
      if (dtMod && other.mods.includes(dtMod)) {
        return { kind: "double_tap_overlap_modifier", with: id };
      }
    }
    if (candidate.kind === "modifierOnly" && other.kind === "doubleTap") {
      const dtMod = other.mods[0];
      if (dtMod && candModTypes.has(dtMod)) {
        return { kind: "double_tap_overlap_modifier", with: id };
      }
    }
  }
  return null;
}

/**
 * 启动 / schema 升级后跑一遍：把不再合规的 binding 列出来，让 HotkeyConflictDialog
 * 立即弹给用户重录。返回每条违规的 id + 已渲染好的 i18n 文案——存量用户在新规则
 * 下可能违规（v2 历史数据里有单 Option modifierOnly、fn-combo、子集冲突等）。
 *
 * 一条 binding 同时违反多个规则时只报第一个；用户改完后下次启动重新自检会暴露
 * 后续问题，避免一次塞太多文案给用户。
 */
export function auditBindings(
  bindings: Record<BindingId, HotkeyBinding | null>,
  platform: Platform,
  allowSpecialKeys: boolean,
): { id: BindingId; error: string }[] {
  const out: { id: BindingId; error: string }[] = [];
  const reported = new Set<BindingId>();
  for (const id of BINDING_IDS) {
    const b = bindings[id];
    if (!b) continue;
    const legal = isLegalBinding(b, platform, allowSpecialKeys);
    if (!legal.ok) {
      out.push({ id, error: legal.reason ?? "" });
      reported.add(id);
      continue;
    }
    const conflict = findBindingConflict(bindings, b, id);
    if (conflict && !reported.has(id)) {
      const error = i18n.t(
        `dialogs:hotkey_field.conflict_reason.${conflict.kind}`,
        { name: BINDING_LABELS[conflict.with] },
      );
      out.push({ id, error });
      reported.add(id);
    }
  }
  return out;
}

/** 软提示（不阻断录入）—— W1 系统占用、W2 F1-F12 单按、W3 单修饰键 modifierOnly。 */
export function getBindingWarnings(
  binding: HotkeyBinding,
  platform: Platform,
): string[] {
  const warnings: string[] = [];

  // W2: 裸按 F1-F12 容易与系统亮度/音量冲突——只在 macOS 警告
  // （Windows / Linux 上 F-key 通常直接作为 F-key 触发，不冲突）
  if (
    platform === "macos" &&
    binding.kind === "combo" &&
    binding.mods.length === 0 &&
    /^F([1-9]|1[0-2])$/.test(binding.code)
  ) {
    warnings.push("hotkey:warning.f_key_bare");
  }

  // W3: 单修饰键 modifierOnly 会吞掉该键的全部原生组合，举例按平台不同
  if (binding.kind === "modifierOnly" && binding.mods.length === 1) {
    warnings.push(`hotkey:warning.modifier_only_single_${platform}`);
  }

  // W1: 命中常见系统快捷键
  if (binding.kind === "combo" && isSystemReservedCombo(binding, platform)) {
    warnings.push("hotkey:warning.system_shortcut");
  }

  return warnings;
}

// 判定"敲字时会输入的常见键"：字母 / 数字 / 空格 / 主键盘标点 / Numpad 数字。
// 单按这些键会让每次输入都触发快捷键——必须配修饰键，硬拦。
function isTypingKey(code: string): boolean {
  if (/^Key[A-Z]$/.test(code)) return true;
  if (/^Digit\d$/.test(code)) return true;
  if (/^Numpad\d$/.test(code)) return true;
  if (code === "Space") return true;
  return [
    "Backquote",
    "Minus",
    "Equal",
    "BracketLeft",
    "BracketRight",
    "Backslash",
    "Semicolon",
    "Quote",
    "Comma",
    "Period",
    "Slash",
    "IntlBackslash",
    "IntlRo",
    "IntlYen",
    "NumpadAdd",
    "NumpadSubtract",
    "NumpadMultiply",
    "NumpadDivide",
    "NumpadDecimal",
  ].includes(code);
}

// 系统占用快捷键表——常见、影响大、用户最容易踩。不求全。
function isSystemReservedCombo(b: HotkeyBinding, platform: Platform): boolean {
  const mods = new Set(b.mods);
  const has = (m: HotkeyMod) => mods.has(m);
  const only = (...need: HotkeyMod[]): boolean =>
    mods.size === need.length && need.every((m) => mods.has(m));

  if (platform === "macos") {
    // Cmd + (Q/W/H/M/Tab/Space)
    if (only("meta") && ["KeyQ", "KeyW", "KeyH", "KeyM", "Tab", "Space"].includes(b.code)) {
      return true;
    }
    // Cmd+Shift + (3/4/5)
    if (only("meta", "shift") && ["Digit3", "Digit4", "Digit5"].includes(b.code)) {
      return true;
    }
    // Ctrl+Cmd+Q (Lock)
    if (only("ctrl", "meta") && b.code === "KeyQ") return true;
    // Cmd+Option+Esc (Force Quit)
    if (only("meta", "alt") && b.code === "Escape") return true;
    return false;
  }
  if (platform === "windows") {
    // Win + (L/D/E/R/Tab/H/I/S)
    if (only("meta") && ["KeyL", "KeyD", "KeyE", "KeyR", "Tab", "KeyH", "KeyI", "KeyS"].includes(b.code)) {
      return true;
    }
    // Alt+F4
    if (only("alt") && b.code === "F4") return true;
    // Alt+Tab
    if (only("alt") && b.code === "Tab") return true;
    // Ctrl+Alt+Del
    if (only("ctrl", "alt") && b.code === "Delete") return true;
    return false;
  }
  // Linux: 桌面环境差异大，不做硬编码
  void has;
  return false;
}

const MOD_LABEL_MAC: Record<HotkeyMod, string> = {
  ctrl: "Ctrl",
  alt: "Option",
  shift: "Shift",
  meta: "Cmd",
  fn: "fn",
};

const MOD_LABEL_WIN: Record<HotkeyMod, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Win",
  fn: "Fn",
};

const MOD_LABEL_LINUX: Record<HotkeyMod, string> = {
  ctrl: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  meta: "Super",
  fn: "Fn",
};

export function formatMod(mod: HotkeyMod, platform: Platform): string {
  if (platform === "macos") return MOD_LABEL_MAC[mod];
  if (platform === "windows") return MOD_LABEL_WIN[mod];
  return MOD_LABEL_LINUX[mod];
}

const CODE_LABEL: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "⌫",
  Delete: "Del",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  // 标点物理键：W3C code 以英文命名（Comma / Period / Slash 等），
  // 用户看到的是键帽字符，统一回显成符号，避免出现 "Comma"、"Period" 字样。
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
  IntlBackslash: "\\",
  IntlRo: "\\",
  IntlYen: "¥",
};

export function formatCode(code: string): string {
  if (CODE_LABEL[code]) return CODE_LABEL[code];
  if (/^Key([A-Z])$/.test(code)) return code.slice(3);
  if (/^Digit(\d)$/.test(code)) return code.slice(5);
  if (/^Numpad(.+)$/.test(code)) return `Num${code.slice(6)}`;
  return code;
}

export function formatBinding(
  binding: HotkeyBinding | null,
  platform: Platform,
): string {
  if (!binding) return i18n.t("hotkey:format.unbound");
  const sep = platform === "macos" ? " " : " + ";

  if (binding.kind === "modifierOnly") {
    return binding.mods.map((m) => formatMod(m, platform)).join(sep);
  }
  if (binding.kind === "doubleTap") {
    return i18n.t("hotkey:format.double_tap", {
      mod: formatMod(binding.mods[0]!, platform),
    });
  }
  const parts = [
    ...binding.mods.map((m) => formatMod(m, platform)),
    formatCode(binding.code),
  ];
  return parts.join(sep);
}

export function bindingsEqual(
  a: HotkeyBinding | null,
  b: HotkeyBinding | null,
): boolean {
  if (a === null && b === null) return true;
  if (a === null || b === null) return false;
  if (a.kind !== b.kind) return false;
  if (a.code !== b.code) return false;
  if (a.mods.length !== b.mods.length) return false;
  if (!a.mods.every((m, i) => m === b.mods[i])) return false;
  for (const m of a.mods) {
    if (getModSide(a, m) !== getModSide(b, m)) return false;
  }
  return true;
}

