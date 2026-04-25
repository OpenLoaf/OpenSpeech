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

// 听写为单一 binding（id 名沿用 "dictate_ptt"，Rust 侧解析与历史 hotkeys.json
// 都用此名）。统一为 toggle 行为：按一下开始、再按一下结束。
export const BINDING_IDS = ["dictate_ptt", "ask_ai", "translate"] as const;
export type BindingId = (typeof BINDING_IDS)[number];

/**
 * 平台感知的默认快捷键。对齐行业标杆（Wispr Flow / TypeLess / FreeFlow）：
 * - macOS:   PTT = `Fn`（modifier-only）
 * - Windows: PTT = `Ctrl + Win`（modifier-only，Win 键在内部抽象为 `meta`）
 * - Linux:   PTT = `Ctrl + Super`（modifier-only）
 *
 * Ask AI / Translate 继续使用跨平台安全的 `Ctrl + Shift + 字母` combo，冲突概率最低。
 */
export function getDefaultBindings(
  platform: Platform,
): Record<BindingId, HotkeyBinding | null> {
  const ptt: HotkeyBinding =
    platform === "macos"
      ? { kind: "modifierOnly", mods: ["fn"], code: "" }
      : { kind: "modifierOnly", mods: ["ctrl", "meta"], code: "" };

  return {
    dictate_ptt: ptt,
    ask_ai: { kind: "combo", mods: ["ctrl", "shift"], code: "KeyA" },
    translate: { kind: "combo", mods: ["ctrl", "shift"], code: "KeyT" },
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

export const BINDING_LABELS: Record<BindingId, string> = {
  dictate_ptt: "听写",
  ask_ai: "问 AI",
  translate: "翻译",
};

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
    return { ok: false, reason: "需要配合主键使用" };
  }
  if (!allowSpecialKeys && DISALLOWED_BARE.includes(code)) {
    return { ok: false, reason: "Esc / Tab / Enter 等特殊键需在高级设置开启后使用" };
  }
  const isFnKey = ALWAYS_ALLOWED_BARE_PREFIX.some(
    (p) => code.startsWith(p) && /^F\d+$/.test(code),
  );
  if (mods.length === 0 && !isFnKey) {
    return { ok: false, reason: "需要配合修饰键使用" };
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
      reason: "Fn 键仅在 macOS 可靠可用；请用 Ctrl + Win 或 Right Alt",
    };
  }
  if (binding.kind === "modifierOnly") {
    if (binding.code !== "") {
      return { ok: false, reason: "modifier-only 绑定不能包含主键" };
    }
    if (binding.mods.length === 0) {
      return { ok: false, reason: "至少需要一个修饰键" };
    }
    return { ok: true };
  }
  if (binding.kind === "doubleTap") {
    if (binding.code !== "") {
      return { ok: false, reason: "双击绑定不能包含主键" };
    }
    if (binding.mods.length !== 1) {
      return { ok: false, reason: "双击只支持单个修饰键" };
    }
    return { ok: true };
  }
  return isLegalMainKey(binding.code, binding.mods, allowSpecialKeys);
}

const MOD_LABEL_MAC: Record<HotkeyMod, string> = {
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  meta: "⌘",
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
  if (!binding) return "未绑定";
  const sep = platform === "macos" ? " " : " + ";

  if (binding.kind === "modifierOnly") {
    return binding.mods.map((m) => formatMod(m, platform)).join(sep);
  }
  if (binding.kind === "doubleTap") {
    return `2× ${formatMod(binding.mods[0]!, platform)}`;
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
