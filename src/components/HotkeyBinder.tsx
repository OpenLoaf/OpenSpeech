import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { X, AlertCircle, RotateCcw } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { toast } from "sonner";
import {
  BINDING_IDS,
  BINDING_LABELS,
  codeToMod,
  findConflict,
  formatCode,
  formatMod,
  isLegalMainKey,
  isModifierCode,
  normalizeMods,
  type BindingId,
  type HotkeyBinding,
  type HotkeyMod,
} from "@/lib/hotkey";
import { detectPlatform, type Platform } from "@/lib/platform";
import { cn } from "@/lib/utils";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useUIStore } from "@/stores/ui";

const RECORDING_EVENT = "openspeech://hotkey-recording";
const RECORDING_TIMEOUT_MS = 4000;
const UNDO_WINDOW_MS = 8000;

interface RecordingPayload {
  code: string;
  phase: "pressed" | "released";
}

// recording 子态只存 everPressedMods——视觉上只增不减；当前按住的集合 + 主键标志
// 保留在 ref 里，避免松开过程中触发无谓 setState / re-render。
type RowState =
  | { kind: "idle" }
  | { kind: "recording"; everPressedMods: HotkeyMod[] }
  | { kind: "error"; message: string }
  | { kind: "conflict"; with: BindingId; candidate: HotkeyBinding };

type BinderSize = "comfortable" | "compact";

interface BinderProps {
  filterIds?: readonly BindingId[];
  /** 在每个 row 之间渲染的分隔线开关（Dialog 模式可关）。 */
  divided?: boolean;
  /** Settings tab 用 comfortable（高、宽、明显）；Dialog 用 compact。 */
  size?: BinderSize;
}

const SIZING: Record<
  BinderSize,
  {
    row: string;
    label: string;
    /** 仅 comfortable 渲染——hint 文字让左列有上下两行内容，与右列 chip
     * 高度更对得上，避免"按钮和单行标题互相浮空"。 */
    hint: string | null;
    button: string;
    chip: string;
    chipSep: string;
    placeholder: string;
  }
> = {
  comfortable: {
    row: "py-5",
    label: "text-sm",
    hint: "mt-1 text-[11px] text-te-light-gray/70",
    button: "h-[44px] min-w-[15rem]",
    chip: "h-7 min-w-[1.75rem] px-2 text-xs",
    chipSep: "text-xs",
    placeholder: "text-xs tracking-[0.18em]",
  },
  compact: {
    row: "py-3",
    label: "text-sm",
    hint: null,
    button: "h-[34px] min-w-[12rem]",
    chip: "h-5 min-w-[1.4rem] px-1.5 text-[11px]",
    chipSep: "text-[10px]",
    placeholder: "text-[11px] tracking-[0.15em]",
  },
};

export function HotkeyBinder({
  filterIds,
  divided = true,
  size = "compact",
}: BinderProps) {
  const ids = filterIds && filterIds.length > 0 ? filterIds : BINDING_IDS;
  return (
    <div className={cn(divided && "divide-y divide-te-gray/30")}>
      {ids.map((id) => (
        <BinderRow key={id} id={id} size={size} />
      ))}
    </div>
  );
}

function BinderRow({ id, size }: { id: BindingId; size: BinderSize }) {
  const sz = SIZING[size];
  const { t } = useTranslation();
  const platform = detectPlatform();
  const value = useHotkeysStore((s) => s.bindings[id]);
  const allowSpecialKeys = useHotkeysStore((s) => s.allowSpecialKeys);
  const setBinding = useHotkeysStore((s) => s.setBinding);
  const recordUndo = useHotkeysStore((s) => s.recordUndo);
  const applyUndo = useHotkeysStore((s) => s.applyUndo);
  const clearHotkeyConflict = useUIStore((s) => s.clearHotkeyConflict);

  const [state, setState] = useState<RowState>({ kind: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<number | null>(null);
  const errorTimeoutRef = useRef<number | null>(null);

  const pressedModsRef = useRef<HotkeyMod[]>([]);
  const everPressedModsRef = useRef<HotkeyMod[]>([]);
  const sawMainKeyRef = useRef<boolean>(false);
  const recordingActiveRef = useRef<boolean>(false);
  // DOM keydown/keyup 与 rdev message 是双路上报，同一次按键会被处理两次。
  // 该闸门在第一次完成（commit / 进入 conflict / 退出录入）后立即翻 true，
  // 后续重复事件直接 return，避免触发第二次 setState / setBinding。
  const finishedRef = useRef<boolean>(false);

  const startRustRecording = () => {
    if (recordingActiveRef.current) return;
    recordingActiveRef.current = true;
    invoke("set_hotkey_recording", { enabled: true }).catch((e) =>
      console.warn("[HotkeyBinder] set_hotkey_recording(true) failed:", e),
    );
  };

  const stopRustRecording = () => {
    if (!recordingActiveRef.current) return;
    recordingActiveRef.current = false;
    invoke("set_hotkey_recording", { enabled: false }).catch((e) =>
      console.warn("[HotkeyBinder] set_hotkey_recording(false) failed:", e),
    );
  };

  const enterRecording = () => {
    if (state.kind === "recording") return;
    pressedModsRef.current = [];
    everPressedModsRef.current = [];
    sawMainKeyRef.current = false;
    finishedRef.current = false;
    if (errorTimeoutRef.current) {
      window.clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    startRustRecording();
    setState({ kind: "recording", everPressedMods: [] });
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      stopRustRecording();
      setState({ kind: "idle" });
    }, RECORDING_TIMEOUT_MS);
  };

  const exitToIdle = () => {
    stopRustRecording();
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setState({ kind: "idle" });
  };

  // 卸载兜底：rdev 录入模式必须关，否则会持续吞 keys
  useEffect(() => {
    return () => {
      stopRustRecording();
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (errorTimeoutRef.current) window.clearTimeout(errorTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flashError = (message: string) => {
    stopRustRecording();
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    if (errorTimeoutRef.current) window.clearTimeout(errorTimeoutRef.current);
    setState({ kind: "error", message });
    errorTimeoutRef.current = window.setTimeout(() => {
      errorTimeoutRef.current = null;
      setState({ kind: "idle" });
    }, 2500);
  };

  // 录入态期间监听点击外部 / blur 退出
  useEffect(() => {
    if (state.kind !== "recording") return;
    const onClickOut = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        exitToIdle();
      }
    };
    const onBlur = () => {
      window.setTimeout(() => {
        if (document.visibilityState === "hidden") exitToIdle();
      }, 800);
    };
    window.addEventListener("mousedown", onClickOut);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onClickOut);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  const commit = async (next: HotkeyBinding | null) => {
    await setBinding(id, next);
    clearHotkeyConflict(id);
  };

  const handlePressRef = useRef<(code: string) => void>(() => {});
  const handleReleaseRef = useRef<(code: string) => void>(() => {});

  handlePressRef.current = (code: string) => {
    if (finishedRef.current) return;
    if (code === "Escape") {
      exitToIdle();
      return;
    }
    if (isModifierCode(code)) {
      const mod = codeToMod(code);
      if (!mod) return;
      const alreadyPressed = pressedModsRef.current.includes(mod);
      const alreadyEver = everPressedModsRef.current.includes(mod);
      if (alreadyPressed && alreadyEver) return;
      if (!alreadyPressed) {
        pressedModsRef.current = normalizeMods([
          ...pressedModsRef.current,
          mod,
        ]);
      }
      if (!alreadyEver) {
        everPressedModsRef.current = normalizeMods([
          ...everPressedModsRef.current,
          mod,
        ]);
        // 仅在 ever 集合变了时才 setState；release 路径完全不 setState。
        const next = everPressedModsRef.current;
        setState((s) =>
          s.kind === "recording" ? { kind: "recording", everPressedMods: next } : s,
        );
      }
      return;
    }
    if (sawMainKeyRef.current) return;
    sawMainKeyRef.current = true;
    const mods = normalizeMods(pressedModsRef.current);
    const legal = isLegalMainKey(code, mods, allowSpecialKeys);
    if (!legal.ok) {
      flashError(legal.reason ?? t("dialogs:hotkey_field.error_illegal_combo"));
      return;
    }
    const candidate: HotkeyBinding = { kind: "combo", mods, code };
    finishCandidate(candidate);
  };

  handleReleaseRef.current = (code: string) => {
    if (finishedRef.current) return;
    if (!isModifierCode(code)) return;
    const mod = codeToMod(code);
    if (!mod) return;
    if (!pressedModsRef.current.includes(mod)) return;
    pressedModsRef.current = pressedModsRef.current.filter((m) => m !== mod);
    if (
      pressedModsRef.current.length === 0 &&
      !sawMainKeyRef.current &&
      everPressedModsRef.current.length > 0
    ) {
      const candidate: HotkeyBinding = {
        kind: "modifierOnly",
        mods: everPressedModsRef.current,
        code: "",
      };
      finishCandidate(candidate);
    }
  };

  const finishCandidate = (candidate: HotkeyBinding) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    const conflictId = findConflict(
      useHotkeysStore.getState().bindings,
      candidate,
      id,
    );
    if (conflictId) {
      stopRustRecording();
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setState({ kind: "conflict", with: conflictId, candidate });
      return;
    }
    void commit(candidate);
    exitToIdle();
  };

  // DOM keyboard 监听（macOS Fn 键无 DOM 事件，由下方 rdev 通道补齐）。
  // 监听点选 document capture，比 base-ui Dialog 在 document bubble 注册的
  // useDismiss(escapeKey) 更早；同时调 stopImmediatePropagation，避免 Escape
  // 冒到 base-ui 把 Dialog 关掉——录入态只想退到 idle，不想关 Dialog。
  useEffect(() => {
    if (state.kind !== "recording") return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      handlePressRef.current(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      handleReleaseRef.current(e.code);
    };
    document.addEventListener("keydown", onKeyDown, { capture: true });
    document.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      document.removeEventListener("keydown", onKeyDown, { capture: true });
      document.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [state.kind]);

  // rdev 通道：macOS Fn 键唯一可达路径
  useEffect(() => {
    if (state.kind !== "recording") return;
    let cancelled = false;
    let unsub: UnlistenFn | null = null;
    listen<RecordingPayload>(RECORDING_EVENT, (ev) => {
      const { code, phase } = ev.payload;
      if (phase === "pressed") handlePressRef.current(code);
      else handleReleaseRef.current(code);
    }).then((un) => {
      if (cancelled) un();
      else unsub = un;
    });
    return () => {
      cancelled = true;
      unsub?.();
    };
  }, [state.kind]);

  const confirmReplace = async () => {
    if (state.kind !== "conflict") return;
    const conflictId = state.with;
    const candidate = state.candidate;
    const replacedOld = useHotkeysStore.getState().bindings[conflictId];
    await setBinding(conflictId, null);
    await setBinding(id, candidate);
    await recordUndo({
      replacedId: conflictId,
      oldValue: replacedOld,
      changedId: id,
      newValue: candidate,
      expiresAt: Date.now() + UNDO_WINDOW_MS,
    });
    clearHotkeyConflict(id);
    clearHotkeyConflict(conflictId);
    toast(
      t("dialogs:hotkey_field.replaced_toast", {
        name: BINDING_LABELS[conflictId],
      }),
      {
        duration: UNDO_WINDOW_MS,
        action: {
          label: t("dialogs:hotkey_field.undo"),
          onClick: () => {
            void applyUndo();
          },
        },
      },
    );
    exitToIdle();
  };

  const rebind = () => {
    setState({ kind: "idle" });
    requestAnimationFrame(() => enterRecording());
  };

  const cancelConflict = () => exitToIdle();

  const canClear = id !== "dictate_ptt";
  const showClear =
    canClear && !!value && state.kind !== "recording";

  return (
    <div className={cn("flex flex-col gap-1.5", sz.row)} ref={rootRef}>
      <div className="flex items-center justify-between gap-4">
        <div className="flex flex-col">
          <span className={cn("font-sans text-te-fg", sz.label)}>
            {BINDING_LABELS[id]}
          </span>
          {sz.hint ? (
            <span className={cn("font-sans", sz.hint)}>
              {t(`hotkey:binding_hint.${id}`)}
            </span>
          ) : null}
        </div>

        <div className="group relative">
          <AnimatePresence mode="wait" initial={false}>
            {state.kind === "recording" ? (
              <motion.div
                key="recording"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                className={cn(
                  "inline-flex items-center justify-center border px-3",
                  "border-te-accent bg-te-accent/8",
                  sz.button,
                )}
                aria-live="polite"
              >
                {state.everPressedMods.length === 0 ? (
                  <span
                    className={cn(
                      "font-mono uppercase text-te-accent opacity-80 animate-[pulse_1.4s_ease-in-out_infinite]",
                      sz.placeholder,
                    )}
                  >
                    {t("dialogs:hotkey_field.press_new")}
                  </span>
                ) : (
                  <ChipRow
                    items={state.everPressedMods.map((m) =>
                      formatMod(m, platform),
                    )}
                    tone="active"
                    size={size}
                  />
                )}
              </motion.div>
            ) : state.kind === "conflict" ? (
              <motion.button
                key="conflict"
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                onClick={rebind}
                className={cn(
                  "inline-flex items-center justify-center border border-te-accent/70 bg-te-accent/8 px-3",
                  sz.button,
                )}
              >
                <ChipRow
                  items={bindingToChips(state.candidate, platform)}
                  tone="active"
                  size={size}
                />
              </motion.button>
            ) : (
              <motion.button
                key="display"
                type="button"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                onClick={enterRecording}
                className={cn(
                  "inline-flex items-center justify-center border px-3 transition-colors",
                  "border-te-gray/40 bg-te-surface hover:border-te-gray",
                  state.kind === "error" &&
                    "border-te-accent/70 animate-[shake_0.25s]",
                  showClear && "px-7",
                  sz.button,
                )}
              >
                {value ? (
                  <ChipRow
                    items={bindingToChips(value, platform)}
                    tone="idle"
                    size={size}
                  />
                ) : (
                  <span
                    className={cn(
                      "font-mono uppercase text-te-light-gray",
                      sz.placeholder,
                    )}
                  >
                    {t("hotkey:format.unbound")}
                  </span>
                )}
              </motion.button>
            )}
          </AnimatePresence>

          {showClear ? (
            <button
              type="button"
              title={t("dialogs:hotkey_field.clear_title")}
              aria-label={t("dialogs:hotkey_field.clear_aria")}
              onClick={(e) => {
                e.stopPropagation();
                void commit(null);
              }}
              onMouseDown={(e) => e.stopPropagation()}
              className="absolute top-1/2 right-1.5 -translate-y-1/2 flex size-5 items-center justify-center text-te-light-gray opacity-0 transition-opacity group-hover:opacity-100 hover:text-te-fg focus-visible:opacity-100"
            >
              <X className="size-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <AnimatePresence initial={false}>
        {state.kind === "recording" ? (
          <motion.p
            key="hint"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="text-right font-mono text-[10px] tracking-[0.18em] text-te-light-gray/70 uppercase"
          >
            {t("dialogs:hotkey_field.recording_hint")}
          </motion.p>
        ) : null}
        {state.kind === "error" ? (
          <motion.div
            key="error"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center justify-end gap-1.5 font-mono text-[11px] text-te-accent"
          >
            <AlertCircle className="size-3" />
            <span>
              {t("dialogs:hotkey_field.error_prefix")}: {state.message}
            </span>
          </motion.div>
        ) : null}
        {state.kind === "conflict" ? (
          <motion.div
            key="conflict-bar"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-col items-end gap-1.5 font-mono text-[11px]"
          >
            <span className="text-te-light-gray">
              {t("dialogs:hotkey_field.conflict_with", {
                name: BINDING_LABELS[state.with],
              })}
            </span>
            <div className="flex items-center gap-1.5">
              <ActionBtn variant="ghost" onClick={cancelConflict}>
                {t("dialogs:hotkey_field.cancel")}
              </ActionBtn>
              <ActionBtn variant="ghost" onClick={rebind}>
                <RotateCcw className="size-3" aria-hidden />
                {t("dialogs:hotkey_field.rebind")}
              </ActionBtn>
              <ActionBtn variant="solid" onClick={() => void confirmReplace()}>
                {t("dialogs:hotkey_field.replace")}
              </ActionBtn>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// idle / active 两态共用 chip 视觉：仅边框 + 背景色不同，宽高 / 字号 / 留白完全
// 一致，让录入前后切换只表现为颜色淡入淡出，不再有"字符串 → chip 拼图"的格式断层。
function ModChip({
  label,
  tone,
  size,
}: {
  label: string;
  tone: "idle" | "active";
  size: BinderSize;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center justify-center border font-mono leading-none normal-case",
        tone === "active"
          ? "border-te-accent/50 bg-te-accent/12 text-te-accent"
          : "border-te-gray/50 bg-te-surface-hover text-te-fg",
        SIZING[size].chip,
      )}
    >
      {label}
    </span>
  );
}

function ChipRow({
  items,
  tone,
  size,
}: {
  items: string[];
  tone: "idle" | "active";
  size: BinderSize;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {items.map((label, i) => (
        <span key={i} className="inline-flex items-center gap-1.5">
          {i > 0 ? (
            <span
              className={cn(
                "font-mono leading-none",
                tone === "active" ? "text-te-accent/55" : "text-te-light-gray/60",
                SIZING[size].chipSep,
              )}
            >
              +
            </span>
          ) : null}
          <ModChip label={label} tone={tone} size={size} />
        </span>
      ))}
    </span>
  );
}

function bindingToChips(binding: HotkeyBinding, platform: Platform): string[] {
  if (binding.kind === "doubleTap" && binding.mods.length > 0) {
    return [`2× ${formatMod(binding.mods[0]!, platform)}`];
  }
  const out = binding.mods.map((m) => formatMod(m, platform));
  if (binding.kind === "combo" && binding.code) {
    out.push(formatCode(binding.code));
  }
  return out;
}

function ActionBtn({
  onClick,
  children,
  variant,
}: {
  onClick: () => void;
  children: React.ReactNode;
  variant: "solid" | "ghost";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      onMouseDown={(e) => e.stopPropagation()}
      className={cn(
        "inline-flex items-center gap-1 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.15em] transition-colors",
        variant === "solid"
          ? "border border-te-accent bg-te-accent text-te-accent-fg hover:bg-te-accent/90"
          : "border border-te-gray/40 text-te-light-gray hover:border-te-gray hover:text-te-fg",
      )}
    >
      {children}
    </button>
  );
}
