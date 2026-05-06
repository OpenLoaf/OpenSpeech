import { Fragment, useCallback, useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Command, Diamond } from "lucide-react";
import { cn } from "@/lib/utils";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useRecordingStore } from "@/stores/recording";
import {
  codeToMod,
  formatCode,
  normalizeMods,
  type BindingId,
  type HotkeyBinding,
  type HotkeyMod,
} from "@/lib/hotkey";
import { detectPlatform, type Platform } from "@/lib/platform";

// 听写快捷键的视觉预览：渲染当前 binding 的 token 序列；按键时高亮匹配的 token，
// 不匹配时显示用户实际按下的键。Home 页与 Onboarding Step 1 共用。

type KeyToken = { id: string; label: string };

type HotkeyToken =
  | { kind: "mod"; mod: HotkeyMod; label: string; icon: ReactNode | null }
  | { kind: "main"; code: string; label: string; icon: ReactNode | null }
  | { kind: "prefix"; label: string };

function modLabel(mod: HotkeyMod, platform: Platform): string {
  if (mod === "fn") return "Fn";
  if (mod === "shift") return "Shift";
  if (mod === "alt") return platform === "macos" ? "Option" : "Alt";
  if (mod === "ctrl") return "Ctrl";
  if (platform === "macos") return "Cmd";
  if (platform === "windows") return "Win";
  return "Super";
}

function WinIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M1 3.5l5.5-.75v5.5H1V3.5z" />
      <path d="M7.5 2.5L15 1v7H7.5V2.5z" />
      <path d="M1 9h5.5v5.5L1 13.5V9z" />
      <path d="M7.5 9H15v7l-7.5-1.5V9z" />
    </svg>
  );
}

function modIcon(mod: HotkeyMod, platform: Platform): ReactNode | null {
  if (mod === "fn") return null;
  if (mod === "ctrl") return "⌃";
  if (mod === "shift") return "⇧";
  if (mod === "alt") return "⌥";
  if (platform === "macos") return <Command size={14} strokeWidth={2.5} />;
  if (platform === "windows") return <WinIcon />;
  return <Diamond size={12} strokeWidth={2.5} />;
}

const MAIN_ICON: Record<string, ReactNode> = {
  Enter: "↵",
  Escape: "⎋",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Space: "␣",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
};

function mainIcon(code: string): ReactNode | null {
  return MAIN_ICON[code] ?? null;
}

export function tokensFromBinding(
  binding: HotkeyBinding | null,
  platform: Platform,
): HotkeyToken[] {
  if (!binding) return [];
  const tokens: HotkeyToken[] = [];
  if (binding.kind === "doubleTap") {
    tokens.push({ kind: "prefix", label: "2×" });
  }
  for (const mod of normalizeMods(binding.mods)) {
    tokens.push({
      kind: "mod",
      mod,
      label: modLabel(mod, platform),
      icon: modIcon(mod, platform),
    });
  }
  if (binding.kind === "combo" && binding.code) {
    tokens.push({
      kind: "main",
      code: binding.code,
      label: formatCode(binding.code),
      icon: mainIcon(binding.code),
    });
  }
  return tokens;
}

function tokenMatches(token: HotkeyToken, pressed: KeyToken | null): boolean {
  if (!pressed) return false;
  if (token.kind === "mod") return codeToMod(pressed.id) === token.mod;
  if (token.kind === "main") return token.code === pressed.id;
  return false;
}

const CODE_LABEL: Record<string, string> = {
  ControlLeft: "Left Ctrl",
  ControlRight: "Right Ctrl",
  ShiftLeft: "Left Shift",
  ShiftRight: "Right Shift",
  AltLeft: "Left Alt",
  AltRight: "Right Alt",
  MetaLeft: "Left Cmd",
  MetaRight: "Right Cmd",
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

function keyFromEvent(e: KeyboardEvent): KeyToken {
  if (e.key === "Fn") return { id: "Fn", label: "Fn" };
  const code = e.code;
  if (CODE_LABEL[code]) return { id: code, label: CODE_LABEL[code] };
  if (/^Key[A-Z]$/.test(code)) return { id: code, label: code.slice(3) };
  if (/^Digit\d$/.test(code)) return { id: code, label: code.slice(5) };
  if (/^F\d+$/.test(code)) return { id: code, label: code };
  if (/^Numpad(.+)$/.test(code)) return { id: code, label: `Num${code.slice(6)}` };
  const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
  return { id: code || k, label: k || code };
}

// rdev 0.5 对未映射硬件键 fallback 成 Unknown(u32) / RawKey(...)；DOM 在 IME / 媒体键也会
// 给 Unidentified。这些不该作为视觉反馈显示给用户。
// CapsLock / NumLock / ScrollLock 是 toggle 键：macOS 只发 keydown 不发 keyup，
// 一旦进入 held 就再也出不来，会把 binding 预览永久卡在"按下回显"模式。
const TOGGLE_LOCK_CODES = new Set(["CapsLock", "NumLock", "ScrollLock"]);
function isDisplayableKey(token: KeyToken): boolean {
  const id = token.id || "";
  const label = token.label || "";
  if (!id || !label) return false;
  if (id === "Unidentified" || label === "Unidentified") return false;
  if (id.startsWith("Unknown(") || id.startsWith("RawKey(")) return false;
  if (TOGGLE_LOCK_CODES.has(id)) return false;
  return true;
}

export function Kbd({
  children,
  highlight,
  size = "md",
}: {
  children: React.ReactNode;
  highlight?: boolean;
  size?: "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border bg-te-bg font-mono transition-colors",
        size === "lg"
          ? "px-[clamp(0.75rem,2.5cqw,1.5rem)] py-[clamp(0.4rem,1.6cqw,1rem)] text-[clamp(0.875rem,3cqw,1.75rem)]"
          : "px-3 py-1.5 text-sm",
        highlight
          ? "border-te-accent text-te-accent shadow-[inset_0_-2px_0_0_var(--te-accent)]"
          : "border-te-gray text-te-fg shadow-[inset_0_-2px_0_0_var(--te-gray)]",
      )}
    >
      {children}
    </span>
  );
}

// 多键并发预览：用 Map<id, KeyToken> 跟踪当前所有按住的键。
// 每个键的释放有独立 180ms debounce，所以快速连按 / 同时释放也能平滑过渡，
// 而不会因某一个 keyup 把整组高亮一起清掉（旧版本 bug：onkeyup 一发就 clear all）。
export function useKeyPreview(): KeyToken[] {
  const [held, setHeld] = useState<Map<string, KeyToken>>(() => new Map());
  const releaseTimersRef = useRef<Map<string, number>>(new Map());

  const press = useCallback((tok: KeyToken) => {
    const timers = releaseTimersRef.current;
    const t = timers.get(tok.id);
    if (t !== undefined) {
      window.clearTimeout(t);
      timers.delete(tok.id);
    }
    setHeld((prev) => {
      if (prev.has(tok.id)) return prev;
      const next = new Map(prev);
      next.set(tok.id, tok);
      return next;
    });
  }, []);

  const release = useCallback((id: string) => {
    const timers = releaseTimersRef.current;
    if (timers.has(id)) return;
    const handle = window.setTimeout(() => {
      timers.delete(id);
      setHeld((prev) => {
        if (!prev.has(id)) return prev;
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
    }, 180);
    timers.set(id, handle);
  }, []);

  const clearAll = useCallback(() => {
    releaseTimersRef.current.forEach((t) => window.clearTimeout(t));
    releaseTimersRef.current.clear();
    setHeld(new Map());
  }, []);

  useEffect(
    () => () => {
      releaseTimersRef.current.forEach((t) => window.clearTimeout(t));
      releaseTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    const onDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tok = keyFromEvent(e);
      if (!isDisplayableKey(tok)) return;
      press(tok);
    };
    const onUp = (e: KeyboardEvent) => {
      const tok = keyFromEvent(e);
      release(tok.id);
    };
    window.addEventListener("keydown", onDown);
    window.addEventListener("keyup", onUp);
    // 失焦时所有 key 都视为释放（系统快捷键、切窗等场景 keyup 可能丢）
    window.addEventListener("blur", clearAll);
    return () => {
      window.removeEventListener("keydown", onDown);
      window.removeEventListener("keyup", onUp);
      window.removeEventListener("blur", clearAll);
    };
  }, [press, release, clearAll]);

  useEffect(() => {
    let cancelled = false;
    let unsub: UnlistenFn | null = null;
    listen<{ code: string; phase: "pressed" | "released" }>(
      "openspeech://key-preview",
      (ev) => {
        const { code, phase } = ev.payload;
        if (phase === "pressed") {
          const tok: KeyToken = {
            id: code,
            label: CODE_LABEL[code] ?? formatCode(code),
          };
          if (!isDisplayableKey(tok)) return;
          press(tok);
        } else {
          release(code);
        }
      },
    ).then((un) => {
      if (cancelled) un();
      else unsub = un;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [press, release]);

  return Array.from(held.values());
}

export function HotkeyPreview({
  hint,
  index = "01",
  title,
  stack = false,
  hintPlacement = "row",
  fillHeight = false,
  bindingIds = ["dictate_ptt"],
  headerExtra,
  hideHeader = false,
}: {
  hint?: string;
  index?: string;
  title?: string;
  /** 强制纵向排版（hint 在快捷键下方换行）。默认 false，宽松容器里走横向。 */
  stack?: boolean;
  /** "row" = hint 在底部黄字行；"header" = hint 替换右上角 index 位置。 */
  hintPlacement?: "row" | "header";
  /** 撑满父容器高度，header 顶到顶、按键行垂直居中。Home 页用。 */
  fillHeight?: boolean;
  /** 显示哪些 binding——多个时按 `/` 分隔成"组1 / 组2"。默认仅听写。 */
  bindingIds?: BindingId[];
  /** 替代 hint 在 header 右侧的自定义节点（如 Tab 控件）。优先级高于 hint。 */
  headerExtra?: React.ReactNode;
  /** 不渲染 header 行（title / hint / index）。调用方已在外部承担 section 标题时用。 */
  hideHeader?: boolean;
}) {
  const { t } = useTranslation();
  const allBindings = useHotkeysStore((s) => s.bindings);
  const platform = detectPlatform();
  const groups = useMemo(
    () =>
      bindingIds.map((id) => ({
        id,
        tokens: tokensFromBinding(allBindings[id], platform),
      })),
    [bindingIds, allBindings, platform],
  );
  const pressed = useKeyPreview();
  const recState = useRecordingStore((s) => s.state);
  const sessionActive =
    recState === "preparing" ||
    recState === "recording" ||
    recState === "transcribing";
  const tokenIsHeld = (token: HotkeyToken) =>
    sessionActive || pressed.some((p) => tokenMatches(token, p));
  const anyMatchAcrossGroups = groups.some((g) => g.tokens.some(tokenIsHeld));
  // 多组模式下不再走 "pressed.slice(-4)" 按错回显——一组都不命中时无法决定回显
  // 挂在哪组旁边，强制保持绑定行视图避免歧义。
  const multiGroup = groups.length > 1;
  const showBindingRow =
    multiGroup || pressed.length === 0 || anyMatchAcrossGroups || sessionActive;
  const resolvedTitle = title ?? t("dialogs:hotkey_preview.default_title");
  const modeHint = hint ?? t("dialogs:hotkey_preview.default_hint");

  const hintInHeader = hintPlacement === "header";

  const renderTokens = (tokens: HotkeyToken[]) =>
    tokens.length === 0 ? (
      <Kbd size={fillHeight ? "lg" : "md"}>
        {t("dialogs:hotkey_preview.unbound")}
      </Kbd>
    ) : (
      tokens.map((tok, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <span
              className={cn(
                "font-mono text-te-light-gray",
                fillHeight ? "text-[clamp(1rem,3cqw,2rem)]" : "text-xl",
              )}
            >
              +
            </span>
          )}
          <Kbd highlight={tokenIsHeld(tok)} size={fillHeight ? "lg" : "md"}>
            {tok.kind !== "prefix" && tok.icon ? (
              <span aria-hidden className="mr-1.5 opacity-60">
                {tok.icon}
              </span>
            ) : null}
            {tok.label}
          </Kbd>
        </Fragment>
      ))
    );

  return (
    <div className={cn(fillHeight && "flex h-full min-h-0 flex-col")}>
      {hideHeader ? null : (
        <div className="flex shrink-0 items-start justify-between gap-3">
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
            {resolvedTitle}
          </span>
          {headerExtra ? (
            headerExtra
          ) : hintInHeader ? (
            <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
              {modeHint}
            </span>
          ) : (
            <span className="font-mono text-[10px] text-te-light-gray md:text-xs">
              {index}
            </span>
          )}
        </div>
      )}

      <div
        className={cn(
          "flex flex-col gap-3",
          !hideHeader && "mt-3",
          !stack && !hintInHeader && "md:flex-row md:items-center md:justify-between",
          fillHeight && "min-h-0 flex-1 justify-center [container-type:inline-size]",
        )}
      >
        <div
          className={cn(
            "flex flex-wrap items-center",
            fillHeight ? "gap-[clamp(0.5rem,2cqw,1.25rem)]" : "gap-3",
          )}
        >
          {showBindingRow ? (
            groups.map((g, gi) => (
              <Fragment key={g.id}>
                {gi > 0 && (
                  <span
                    className={cn(
                      "font-mono text-te-light-gray",
                      fillHeight
                        ? "text-[clamp(1rem,3cqw,2rem)]"
                        : "text-xl",
                    )}
                  >
                    /
                  </span>
                )}
                <div
                  className={cn(
                    "flex items-center",
                    fillHeight ? "gap-[clamp(0.5rem,2cqw,1.25rem)]" : "gap-3",
                  )}
                >
                  {renderTokens(g.tokens)}
                </div>
              </Fragment>
            ))
          ) : (
            // 同时按住超过 4 个键时只显示最近按下的 4 个，避免快速打字时
            // debounce 窗口内 pressed 数组膨胀导致 UI 出现 5+ 个 Kbd。
            pressed.slice(-4).map((p, i) => (
              <Fragment key={p.id}>
                {i > 0 && (
                  <span
                    className={cn(
                      "font-mono text-te-light-gray",
                      fillHeight
                        ? "text-[clamp(1rem,3cqw,2rem)]"
                        : "text-xl",
                    )}
                  >
                    +
                  </span>
                )}
                <Kbd size={fillHeight ? "lg" : "md"}>{p.label}</Kbd>
              </Fragment>
            ))
          )}
        </div>

        {!hintInHeader && (
          <div className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
            {modeHint}
          </div>
        )}
      </div>
    </div>
  );
}
