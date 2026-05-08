import { Fragment, useCallback, useEffect, useRef, useState, useMemo, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { cn } from "@/lib/utils";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useRecordingStore } from "@/stores/recording";
import {
  codeToMod,
  codeToSide,
  formatCode,
  formatMod as modLabel,
  getModSide,
  normalizeMods,
  type BindingId,
  type HotkeyBinding,
  type HotkeyMod,
  type Side,
} from "@/lib/hotkey";
import { detectPlatform, type Platform } from "@/lib/platform";
import { keyEventLabel, mainIcon, modIcon, displaySide } from "@/lib/hotkeyVisual";

// 听写快捷键的视觉预览：渲染当前 binding 的 token 序列；按键时高亮匹配的 token，
// 不匹配时显示用户实际按下的键。Home 页与 Onboarding Step 1 共用。

type KeyToken = { id: string; label: string };

type HotkeyToken =
  | {
      kind: "mod";
      mod: HotkeyMod;
      side: Side | null;
      label: string;
      icon: ReactNode | null;
    }
  | { kind: "main"; code: string; label: string; icon: ReactNode | null }
  | { kind: "prefix"; label: string };


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
      side: getModSide(binding, mod),
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
  if (token.kind === "mod") {
    if (codeToMod(pressed.id) !== token.mod) return false;
    // fn 无左右概念；其他 mod 必须左右一致才算命中
    if (token.side === null) return true;
    return codeToSide(pressed.id) === token.side;
  }
  if (token.kind === "main") return token.code === pressed.id;
  return false;
}

function keyFromEvent(e: KeyboardEvent, platform: Platform): KeyToken {
  if (e.key === "Fn") return { id: "Fn", label: "Fn" };
  const code = e.code;
  // 修饰键 / 已知特殊键走 platform-aware 标签——确保 Mac 上 Alt 物理键显示为 Option
  if (code) {
    const labeled = keyEventLabel(code, platform);
    if (labeled && labeled !== code) return { id: code, label: labeled };
  }
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
  error,
  size = "md",
}: {
  children: React.ReactNode;
  highlight?: boolean;
  error?: boolean;
  size?: "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border bg-te-bg font-mono transition-colors",
        size === "lg"
          ? "px-[clamp(0.75rem,2.5cqw,1.5rem)] py-[clamp(0.4rem,1.6cqw,1rem)] text-[clamp(0.875rem,3cqw,1.75rem)]"
          : "px-3 py-1.5 text-sm",
        error
          ? "border-red-700/70 text-red-500/80 shadow-[inset_0_-2px_0_0_#b91c1c]"
          : highlight
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
  const platform = detectPlatform();
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
      const tok = keyFromEvent(e, platform);
      if (!isDisplayableKey(tok)) return;
      press(tok);
    };
    const onUp = (e: KeyboardEvent) => {
      const tok = keyFromEvent(e, platform);
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
  }, [press, release, clearAll, platform]);

  // 主窗失焦时丢弃 Tauri key-preview（rdev 全局回调），否则用户在别的 app 按 Cmd
  // 也会让首页 Kbd 高亮，看上去像被"远程操控"。DOM 监听器只在 webview 聚焦才发
  // 事件，本身不受影响。
  const focusedRef = useRef(true);
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    const w = getCurrentWebviewWindow();
    void w
      .isFocused()
      .then((f) => {
        if (!cancelled) focusedRef.current = f;
      })
      .catch(() => {});
    void w
      .onFocusChanged(({ payload }) => {
        focusedRef.current = payload;
        if (!payload) clearAll();
      })
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [clearAll]);

  useEffect(() => {
    let cancelled = false;
    let unsub: UnlistenFn | null = null;
    listen<{ code: string; phase: "pressed" | "released" }>(
      "openspeech://key-preview",
      (ev) => {
        if (!focusedRef.current) return;
        const { code, phase } = ev.payload;
        if (phase === "pressed") {
          const tok: KeyToken = {
            id: code,
            label: keyEventLabel(code, platform),
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
  }, [press, release, platform]);

  return Array.from(held.values());
}

// 主窗口聚焦态。webview 失焦 → onFocusChanged(false)，视觉上把绑定 Kbd 抹成 •
// 防止旁观者看屏知道触发键。show_main_window 全键命中时短暂揭开，覆盖按下激活键
// 到 OS 真正切焦那一小段时间。
function useMainWindowFocus(): boolean {
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    const w = getCurrentWebviewWindow();
    void w
      .isFocused()
      .then((f) => {
        if (!cancelled) setFocused(f);
      })
      .catch(() => {});
    void w
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((un) => {
        if (cancelled) un();
        else unlisten = un;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);
  return focused;
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
  trailing,
  swapToActivatorWhenUnfocused = false,
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
  /** 替换默认 modeHint 行尾文字的自定义节点（按键预览右边那段）。 */
  trailing?: React.ReactNode;
  /** 主窗口失焦时把 Kbd 内容换成 show_main_window 的按键，提示用户先把窗口唤起。 */
  swapToActivatorWhenUnfocused?: boolean;
}) {
  const { t } = useTranslation();
  const allBindings = useHotkeysStore((s) => s.bindings);
  const platform = detectPlatform();
  const baseGroups = useMemo(
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
  const focused = useMainWindowFocus();
  const showActivator = swapToActivatorWhenUnfocused && !focused;
  const showMainTokens = useMemo(
    () => tokensFromBinding(allBindings["show_main_window"], platform),
    [allBindings, platform],
  );
  // 失焦时把按键替换成 show_main_window 整组，引导用户先唤起窗口。
  const groups = showActivator
    ? [{ id: "show_main_window" as BindingId, tokens: showMainTokens }]
    : baseGroups;
  // showActivator 状态下不让 sessionActive（dictate 录音中）把激活键 Kbd 也点亮，
  // 那不是当前展示的 binding。
  const tokenIsHeld = (token: HotkeyToken) =>
    (!showActivator && sessionActive) ||
    pressed.some((p) => tokenMatches(token, p));
  const anyMatchAcrossGroups = groups.some((g) => g.tokens.some(tokenIsHeld));
  // 多组模式下不再走 "pressed.slice(-4)" 按错回显——一组都不命中时无法决定回显
  // 挂在哪组旁边，强制保持绑定行视图避免歧义。
  const multiGroup = groups.length > 1;
  const showBindingRow =
    multiGroup ||
    pressed.length === 0 ||
    anyMatchAcrossGroups ||
    sessionActive;
  const resolvedTitle = title ?? t("dialogs:hotkey_preview.default_title");
  const modeHint = hint ?? t("dialogs:hotkey_preview.default_hint");

  const hintInHeader = hintPlacement === "header";

  const renderTokens = (tokens: HotkeyToken[], error = false) =>
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
                "font-mono",
                error ? "text-red-500/70" : "text-te-light-gray",
                fillHeight ? "text-[clamp(1rem,3cqw,2rem)]" : "text-xl",
              )}
            >
              +
            </span>
          )}
          <Kbd
            highlight={!error && tokenIsHeld(tok)}
            error={error}
            size={fillHeight ? "lg" : "md"}
          >
            {tok.kind !== "prefix" && tok.icon ? (
              <span aria-hidden className="mr-1.5 opacity-60">
                {tok.icon}
              </span>
            ) : null}
            {tok.kind === "mod" && displaySide(tok.mod, platform, tok.side) ? (
              <span aria-hidden className="mr-1 text-[0.7em] font-bold opacity-70">
                {tok.side === "left" ? "L" : "R"}
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
            // 统一走 renderTokens，让 fallback 的图标 + L/R 角标 + 文字与 binding
            // 行完全一致——避免按错键时只显示纯文字、跟绑定预览视觉割裂。
            renderTokens(
              pressed.slice(-4).map<HotkeyToken>((p) => {
                const mod = codeToMod(p.id);
                if (mod) {
                  return {
                    kind: "mod",
                    mod,
                    side: mod === "fn" ? null : codeToSide(p.id),
                    label: modLabel(mod, platform),
                    icon: modIcon(mod, platform),
                  };
                }
                return {
                  kind: "main",
                  code: p.id,
                  label: p.label || formatCode(p.id),
                  icon: mainIcon(p.id),
                };
              }),
              true,
            )
          )}
        </div>

        {!hintInHeader &&
          (trailing ?? (
            <div className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
              {modeHint}
            </div>
          ))}
      </div>
    </div>
  );
}
