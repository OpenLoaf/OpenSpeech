import i18n from "@/i18n";
import { detectPlatform, type Platform } from "@/lib/platform";

export type HotkeyMod = "ctrl" | "alt" | "shift" | "meta" | "fn";

/**
 * 绑定形态：
 * - `combo`         —— 至少 1 修饰键 + 1 主键（`code` 非空），例：`Ctrl + Shift + Space`
 * - `modifierOnly`  —— 1 到 N 个修饰键，无主键（`code === ""`），例：`Fn` 单按
 * - `doubleTap`     —— 双击单个修饰键（`mods.length === 1`，`code === ""`）
 */
export type BindingKind = "combo" | "modifierOnly" | "doubleTap";

/**
 * 全系统统一为 toggle 语义（按一下开始 · 再按一下结束），不再有 hold（长按）模式。
 */
export interface HotkeyBinding {
  kind: BindingKind;
  mods: HotkeyMod[];
  code: string;
}

export const MOD_ORDER: readonly HotkeyMod[] = [
  "fn",
  "ctrl",
  "alt",
  "shift",
  "meta",
];

// 听写 PTT + 翻译听写 + 唤起主窗口 + 跳到 AI 工具页。`dictate_ptt` 名称沿用 v1 数据兼容；
// `translate` 与 dictate_ptt 同走 modifierOnly，按下后启动一次听写并把转写结果走翻译 prompt
// 替换文本注入；show_main_window / open_toolbox 走 combo，只在 pressed 边沿触发一次。
export const BINDING_IDS = [
  "dictate_ptt",
  "translate",
  "show_main_window",
  "open_toolbox",
] as const;
export type BindingId = (typeof BINDING_IDS)[number];

/**
 * 平台感知的默认快捷键：
 * - macOS:   PTT = `Fn + Control`（modifier-only，组合键避免 Intel Mac / 外接键盘
 *            上单 Fn 不可达 + 减少与系统 Fn 行为的歧义）
 * - Windows: PTT = `Ctrl + Win`（modifier-only，Win 键在内部抽象为 `meta`）
 * - Linux:   PTT = `Ctrl + Super`（modifier-only）
 *
 * 唤起主窗口统一 `Ctrl + Alt + O`（macOS = ⌃⌥O）。三平台无系统占用，O 对应
 * OpenSpeech 助记，不与 PTT 默认（Fn+Ctrl / Ctrl+Meta）冲突。
 */
export function getDefaultBindings(
  platform: Platform,
): Record<BindingId, HotkeyBinding | null> {
  const ptt: HotkeyBinding =
    platform === "macos"
      ? { kind: "modifierOnly", mods: ["fn", "ctrl"], code: "" }
      : { kind: "modifierOnly", mods: ["ctrl", "meta"], code: "" };

  // 翻译：默认 macOS = Fn + Shift；Windows = Win + Alt；Linux = Super + Alt（meta + alt）。
  const translate: HotkeyBinding =
    platform === "macos"
      ? { kind: "modifierOnly", mods: ["fn", "shift"], code: "" }
      : { kind: "modifierOnly", mods: ["alt", "meta"], code: "" };

  const showMainWindow: HotkeyBinding = {
    kind: "combo",
    mods: ["ctrl", "alt"],
    code: "KeyO",
  };

  const openToolbox: HotkeyBinding = {
    kind: "combo",
    mods: ["ctrl", "alt"],
    code: "KeyT",
  };

  return {
    dictate_ptt: ptt,
    translate,
    show_main_window: showMainWindow,
    open_toolbox: openToolbox,
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

const MOD_FROM_CODE: Record<string, HotkeyMod> = {
  ControlLeft: "ctrl",
  ControlRight: "ctrl",
  AltLeft: "alt",
  AltRight: "alt",
  ShiftLeft: "shift",
  ShiftRight: "shift",
  MetaLeft: "meta",
  MetaRight: "meta",
  OSLeft: "meta",
  OSRight: "meta",
  // Fn 在 macOS KeyboardEvent.code 无稳定映射；此处接受自定义 "Fn" token，
  // 由 Rust 侧 CGEventTap / rdev fork 事件归一化后传入
  Fn: "fn",
};

export function codeToMod(code: string): HotkeyMod | null {
  return MOD_FROM_CODE[code] ?? null;
}

export function isModifierCode(code: string): boolean {
  return code in MOD_FROM_CODE;
}

const DISALLOWED_BARE: readonly string[] = [
  "Escape",
  "Tab",
  "Enter",
  "Backspace",
  "Delete",
  "CapsLock",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
];

const ALWAYS_ALLOWED_BARE_PREFIX: readonly string[] = ["F"];

export function isLegalMainKey(
  code: string,
  mods: HotkeyMod[],
  allowSpecialKeys = false,
): { ok: boolean; reason?: string } {
  if (isModifierCode(code)) {
    return { ok: false, reason: i18n.t("hotkey:validation.needs_main_key") };
  }
  if (!allowSpecialKeys && DISALLOWED_BARE.includes(code)) {
    return { ok: false, reason: i18n.t("hotkey:validation.special_keys_locked") };
  }
  const isFnKey = ALWAYS_ALLOWED_BARE_PREFIX.some(
    (p) => code.startsWith(p) && /^F\d+$/.test(code),
  );
  if (mods.length === 0 && !isFnKey) {
    return { ok: false, reason: i18n.t("hotkey:validation.needs_modifier") };
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
    if (binding.mods.length === 0) {
      return { ok: false, reason: i18n.t("hotkey:validation.modifier_only_min") };
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
    return { ok: true };
  }
  return isLegalMainKey(binding.code, binding.mods, allowSpecialKeys);
}

const MOD_LABEL_MAC: Record<HotkeyMod, string> = {
  ctrl: "⌃ Ctrl",
  alt: "⌥ Option",
  shift: "⇧ Shift",
  meta: "⌘ Cmd",
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
  return a.mods.every((m, i) => m === b.mods[i]);
}

export function findConflict(
  bindings: Record<BindingId, HotkeyBinding | null>,
  candidate: HotkeyBinding,
  excludeId: BindingId,
): BindingId | null {
  for (const id of BINDING_IDS) {
    if (id === excludeId) continue;
    const b = bindings[id];
    if (b && bindingsEqual(b, candidate)) return id;
  }
  return null;
}
