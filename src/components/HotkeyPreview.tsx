import { Fragment, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { useHotkeysStore } from "@/stores/hotkeys";
import {
  codeToMod,
  formatCode,
  normalizeMods,
  type HotkeyBinding,
  type HotkeyMod,
} from "@/lib/hotkey";
import { detectPlatform, type Platform } from "@/lib/platform";

// 听写快捷键的视觉预览：渲染当前 binding 的 token 序列；按键时高亮匹配的 token，
// 不匹配时显示用户实际按下的键。Home 页与 Onboarding Step 1 共用。

type KeyToken = { id: string; label: string };

type HotkeyToken =
  | { kind: "mod"; mod: HotkeyMod; label: string; icon: string | null }
  | { kind: "main"; code: string; label: string; icon: string | null }
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

function modIcon(mod: HotkeyMod, platform: Platform): string | null {
  if (mod === "fn") return null;
  if (mod === "ctrl") return "⌃";
  if (mod === "shift") return "⇧";
  if (mod === "alt") return "⌥";
  if (platform === "macos") return "⌘";
  if (platform === "windows") return "⊞";
  return "◆";
}

const MAIN_ICON: Record<string, string> = {
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

function mainIcon(code: string): string | null {
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
function isDisplayableKey(token: KeyToken): boolean {
  const id = token.id || "";
  const label = token.label || "";
  if (!id || !label) return false;
  if (id === "Unidentified" || label === "Unidentified") return false;
  if (id.startsWith("Unknown(") || id.startsWith("RawKey(")) return false;
  return true;
}

export function Kbd({
  children,
  highlight,
}: {
  children: React.ReactNode;
  highlight?: boolean;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border bg-te-bg px-3 py-1.5 font-mono text-sm transition-colors",
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
          const tok: KeyToken = { id: code, label: CODE_LABEL[code] ?? code };
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
  title = "听写快捷键 / PUSH-TO-TALK",
}: {
  hint?: string;
  index?: string;
  title?: string;
}) {
  const binding = useHotkeysStore((s) => s.bindings.dictate_ptt);
  const platform = detectPlatform();
  const tokens = useMemo(
    () => tokensFromBinding(binding, platform),
    [binding, platform],
  );
  const pressed = useKeyPreview();
  // 任何被按下的键命中 binding token → 渲染 binding 行（每个 token 各自高亮）；
  // 没有命中（用户按了 binding 之外的键）→ 把按下的键以 Kbd 列表回显。
  const tokenIsHeld = (token: HotkeyToken) =>
    pressed.some((p) => tokenMatches(token, p));
  const anyMatch = tokens.some(tokenIsHeld);
  const showBindingRow = pressed.length === 0 || anyMatch;
  const modeHint =
    hint ??
    (binding?.mode === "toggle" ? "单击切换 · 再按停止" : "按住说话 · 松开插入");

  return (
    <div>
      <div className="flex items-start justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
          {title}
        </span>
        <span className="font-mono text-[10px] text-te-light-gray md:text-xs">
          {index}
        </span>
      </div>

      <div className="mt-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div className="flex items-center gap-3">
          {tokens.length === 0 ? (
            <Kbd>未绑定</Kbd>
          ) : showBindingRow ? (
            tokens.map((t, i) => (
              <Fragment key={i}>
                {i > 0 && (
                  <span className="font-mono text-xl text-te-light-gray">+</span>
                )}
                <Kbd highlight={tokenIsHeld(t)}>
                  {t.kind !== "prefix" && t.icon ? (
                    <span aria-hidden className="mr-1.5 opacity-60">
                      {t.icon}
                    </span>
                  ) : null}
                  {t.label}
                </Kbd>
              </Fragment>
            ))
          ) : (
            pressed.map((p, i) => (
              <Fragment key={p.id}>
                {i > 0 && (
                  <span className="font-mono text-xl text-te-light-gray">+</span>
                )}
                <Kbd>{p.label}</Kbd>
              </Fragment>
            ))
          )}
        </div>

        <div className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
          {modeHint}
        </div>
      </div>
    </div>
  );
}
