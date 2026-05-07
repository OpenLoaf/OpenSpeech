import { type ReactNode } from "react";
import { Command, Diamond } from "lucide-react";
import {
  codeToMod,
  codeToSide,
  formatCode,
  formatMod,
  type HotkeyMod,
  type Side,
} from "@/lib/hotkey";
import type { Platform } from "@/lib/platform";

// Windows 键物理上有左右，但 Windows 平台键盘上 RWin 极少见且与 LWin 等价，
// 在 UI 上加 L/R 角标只会让用户困惑——meta 键在 Windows 下展示时丢掉 side。
export function shouldShowSide(mod: HotkeyMod, platform: Platform): boolean {
  if (mod === "fn") return false;
  if (mod === "meta" && platform === "windows") return false;
  return true;
}

export function displaySide(
  mod: HotkeyMod,
  platform: Platform,
  side: Side | null | undefined,
): Side | null {
  if (!side) return null;
  return shouldShowSide(mod, platform) ? side : null;
}

// 共用快捷键渲染模块。HotkeyBinder（chip 风格）/ HotkeyPreview（Kbd 风格）/ DemoSection
// 统一从此处取 icon、main key glyph 与"用户实际按下键"的 label，避免符号 / 文案
// 在多个组件里漂移（典型坑：macOS 把 ⌥ 显示成 Alt 而非 Option）。

export function WinIcon({ size = 14 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path d="M1 3.5l5.5-.75v5.5H1V3.5z" />
      <path d="M7.5 2.5L15 1v7H7.5V2.5z" />
      <path d="M1 9h5.5v5.5L1 13.5V9z" />
      <path d="M7.5 9H15v7l-7.5-1.5V9z" />
    </svg>
  );
}

/**
 * 修饰键视觉图标。`size` 像素仅作用于 SVG 类图标（⌘ / Win / Diamond）；
 * Unicode 符号 ⌃ ⌥ ⇧ 由父级字号控制大小。fn 不渲染图标——文本即可。
 *
 * macOS 沿用系统符号 ⌃ ⌥ ⇧ ⌘；Windows / Linux 仅 meta 键带 logo——
 * 在这两个平台上把 ⌃⌥ 强加给用户反而显得不专业。
 */
export function modIcon(
  mod: HotkeyMod,
  platform: Platform,
  size: number = 14,
): ReactNode {
  if (mod === "fn") return null;
  if (platform === "macos") {
    if (mod === "ctrl") return "⌃";
    if (mod === "shift") return "⇧";
    if (mod === "alt") return "⌥";
    if (mod === "meta") return <Command size={size} strokeWidth={2.5} />;
    return null;
  }
  if (mod === "meta") {
    return platform === "windows" ? (
      <WinIcon size={size} />
    ) : (
      <Diamond size={Math.max(size - 2, 8)} strokeWidth={2.5} />
    );
  }
  return null;
}

// 仅当 icon 与 formatCode 返回的 label 字符不同时才在此登记——否则 chip / Kbd
// 会同时把同一个字符既作 icon prefix 又作 label，视觉上重复一遍。
// formatCode 已经把 Backspace/ArrowUp/ArrowDown/ArrowLeft/ArrowRight 渲染成
// ⌫ ↑ ↓ ← →，无需再加 icon。
export const MAIN_ICON: Record<string, ReactNode> = {
  Enter: "↵",
  Escape: "⎋",
  Tab: "⇥",
  Delete: "⌦",
  Space: "␣",
};

export function mainIcon(code: string): ReactNode | null {
  return MAIN_ICON[code] ?? null;
}

const SPECIAL_KEY_LABELS: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Del",
  CapsLock: "Caps",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

/**
 * 把 KeyboardEvent.code（含 ControlLeft/AltLeft/MetaLeft 等左右物理键）翻译成
 * 显示用 label。修饰键走 `formatMod`，自动得到 platform-aware 名称——这是修复
 * "macOS 按 Option 显示 Alt"的关键路径：先前 HotkeyPreview.CODE_LABEL 把
 * AltLeft 硬编码成 "Left Alt"，于是 Mac 用户在 fallback 显示里看到 Alt。
 */
export function keyEventLabel(code: string, platform: Platform): string {
  const mod = codeToMod(code);
  if (mod) {
    const name = formatMod(mod, platform);
    const side = codeToSide(code);
    if (side && shouldShowSide(mod, platform)) {
      return `${side === "left" ? "Left" : "Right"} ${name}`;
    }
    return name;
  }
  if (SPECIAL_KEY_LABELS[code]) return SPECIAL_KEY_LABELS[code];
  return formatCode(code);
}
