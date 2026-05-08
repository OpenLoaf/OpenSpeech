import { useEffect, useRef, useState, type ReactNode } from "react";
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
  codeToSide,
  findBindingConflict,
  formatCode,
  formatMod,
  getBindingWarnings,
  getModSide,
  isLegalBinding,
  isLegalMainKey,
  isModifierCode,
  normalizeMods,
  type BindingConflict,
  type BindingId,
  type HotkeyBinding,
  type HotkeyMod,
  type ModSides,
  type Side,
} from "@/lib/hotkey";
import { detectPlatform, type Platform } from "@/lib/platform";
import { MAIN_ICON, modIcon as sharedModIcon, displaySide } from "@/lib/hotkeyVisual";
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

// recording 子态只存 everPressedMods + 与之同序的 everPressedSides——视觉上只增不减；
// 当前按住的集合 + 主键标志保留在 ref 里，避免松开过程中触发无谓 setState / re-render。
type RowState =
  | { kind: "idle" }
  | {
      kind: "recording";
      everPressedMods: HotkeyMod[];
      everPressedSides: ModSides;
    }
  | { kind: "error"; message: string }
  | {
      kind: "conflict";
      with: BindingId;
      candidate: HotkeyBinding;
      reason: BindingConflict["kind"];
    };

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
    button: "h-[44px] w-[20rem]",
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
  // 与 everPressedMods 同步：每个非 fn mod 第一次按下时记录其物理键 side。
  // fn 不进此 map（无左右概念）。后续 isLegalBinding / findBindingConflict 都基于此。
  const everPressedSidesRef = useRef<ModSides>({});
  const sawMainKeyRef = useRef<boolean>(false);
  const recordingActiveRef = useRef<boolean>(false);
  // DOM keydown/keyup 与 rdev message 是双路上报，同一次按键会被处理两次。
  // 该闸门在第一次完成（commit / 进入 conflict / 退出录入）后立即翻 true，
  // 后续重复事件直接 return，避免触发第二次 setState / setBinding。
  const finishedRef = useRef<boolean>(false);

  // DOM listener 必须在 enterRecording 调用瞬间就挂上——之前放在 useEffect
  // [state.kind] 里有 React commit/调度的微小延迟窗口，用户在窗口内按 ESC 会
  // 漏到 base-ui useDismiss 的 document bubble listener，把整个 Dialog 关掉。
  // 同步注册彻底消除这个窗口。
  const domListenersRef = useRef<{
    down?: (e: KeyboardEvent) => void;
    up?: (e: KeyboardEvent) => void;
  }>({});

  const detachDomListeners = () => {
    const { down, up } = domListenersRef.current;
    if (down) document.removeEventListener("keydown", down, { capture: true });
    if (up) document.removeEventListener("keyup", up, { capture: true });
    domListenersRef.current = {};
  };

  const attachDomListeners = () => {
    detachDomListeners();
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
    domListenersRef.current = { down: onKeyDown, up: onKeyUp };
  };

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
    everPressedSidesRef.current = {};
    sawMainKeyRef.current = false;
    finishedRef.current = false;
    if (errorTimeoutRef.current) {
      window.clearTimeout(errorTimeoutRef.current);
      errorTimeoutRef.current = null;
    }
    // 必须在 setState 之前同步挂上 listener——否则 Dialog 内 base-ui useDismiss
    // 会先收到 ESC 把 Dialog 整个关掉
    attachDomListeners();
    startRustRecording();
    setState({ kind: "recording", everPressedMods: [], everPressedSides: {} });
    if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => {
      detachDomListeners();
      stopRustRecording();
      setState({ kind: "idle" });
    }, RECORDING_TIMEOUT_MS);
  };

  const exitToIdle = () => {
    detachDomListeners();
    stopRustRecording();
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setState({ kind: "idle" });
  };

  // 卸载兜底：rdev 录入模式必须关，否则会持续吞 keys；DOM listener 也要清掉
  useEffect(() => {
    return () => {
      detachDomListeners();
      stopRustRecording();
      if (timeoutRef.current) window.clearTimeout(timeoutRef.current);
      if (errorTimeoutRef.current) window.clearTimeout(errorTimeoutRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const flashError = (message: string) => {
    detachDomListeners();
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
      const side = codeToSide(code);
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
        if (mod !== "fn" && side) {
          everPressedSidesRef.current = {
            ...everPressedSidesRef.current,
            [mod]: side,
          };
        }
        // 仅在 ever 集合变了时才 setState；release 路径完全不 setState。
        const nextMods = everPressedModsRef.current;
        const nextSides = everPressedSidesRef.current;
        setState((s) =>
          s.kind === "recording"
            ? {
                kind: "recording",
                everPressedMods: nextMods,
                everPressedSides: nextSides,
              }
            : s,
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
    const candidate: HotkeyBinding = {
      kind: "combo",
      mods,
      code,
      modSides: pickSides(everPressedSidesRef.current, mods),
    };
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
        modSides: pickSides(
          everPressedSidesRef.current,
          everPressedModsRef.current,
        ),
      };
      finishCandidate(candidate);
    }
  };

  const finishCandidate = (candidate: HotkeyBinding) => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    // 形态校验（B1-B4）：先于跨 binding 冲突检查，错误信息更具体
    const legal = isLegalBinding(candidate, platform, allowSpecialKeys);
    if (!legal.ok) {
      finishedRef.current = false;
      flashError(legal.reason ?? t("dialogs:hotkey_field.error_illegal_combo"));
      return;
    }
    const conflict = findBindingConflict(
      useHotkeysStore.getState().bindings,
      candidate,
      id,
    );
    if (conflict) {
      detachDomListeners();
      stopRustRecording();
      if (timeoutRef.current) {
        window.clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      setState({
        kind: "conflict",
        with: conflict.with,
        candidate,
        reason: conflict.kind,
      });
      return;
    }
    void commit(candidate);
    exitToIdle();
  };

  // DOM keydown/keyup 监听由 enterRecording 同步注册（详见 attachDomListeners
  // 注释——避免 useEffect 调度延迟漏 ESC 给 base-ui useDismiss 关 Dialog）。

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

  // W1/W2 软提示：仅在 idle 态展示，避免覆盖 conflict / error / recording 自身的状态文案
  const warnings =
    state.kind === "idle" && value ? getBindingWarnings(value, platform) : [];

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
                      modChip(
                        m,
                        platform,
                        m === "fn" ? null : state.everPressedSides[m] ?? null,
                      ),
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
              {t(`dialogs:hotkey_field.conflict_reason.${state.reason}`, {
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
        {warnings.length > 0 ? (
          <motion.div
            key="warning-bar"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex flex-col items-end gap-0.5 font-mono text-[11px] text-te-accent/70"
          >
            {warnings.map((key) => (
              <span key={key} className="flex items-center gap-1.5">
                <AlertCircle className="size-3" />
                {t(key)}
              </span>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// 把 modSides 里属于本次 mods 集合的 entry 摘出来，丢掉 fn / 多余 mod。
// Used in finishCandidate 拼 candidate.modSides。
function pickSides(all: ModSides, mods: HotkeyMod[]): ModSides {
  const out: ModSides = {};
  for (const m of mods) {
    if (m === "fn") continue;
    const v = all[m as Exclude<HotkeyMod, "fn">];
    if (v) out[m as Exclude<HotkeyMod, "fn">] = v;
  }
  return out;
}

// idle / active 两态共用 chip 视觉：仅边框 + 背景色不同，宽高 / 字号 / 留白完全
// 一致，让录入前后切换只表现为颜色淡入淡出，不再有"字符串 → chip 拼图"的格式断层。
function ModChip({
  label,
  icon,
  side,
  tone,
  size,
}: {
  label: string;
  icon?: ReactNode;
  side?: Side;
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
      {icon ? (
        <span aria-hidden className="mr-1 inline-flex items-center opacity-70">
          {icon}
        </span>
      ) : null}
      {side ? (
        <span aria-hidden className="mr-1 text-[0.7em] font-bold opacity-70">
          {side === "left" ? "L" : "R"}
        </span>
      ) : null}
      {label}
    </span>
  );
}

interface ChipItem {
  label: string;
  icon?: ReactNode;
  side?: Side;
}

function ChipRow({
  items,
  tone,
  size,
}: {
  items: ChipItem[];
  tone: "idle" | "active";
  size: BinderSize;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {items.map((item, i) => (
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
          <ModChip
            label={item.label}
            icon={item.icon}
            side={item.side}
            tone={tone}
            size={size}
          />
        </span>
      ))}
    </span>
  );
}

// chip 风格用 11px 图标
function modIcon(mod: HotkeyMod, platform: Platform): ReactNode {
  return sharedModIcon(mod, platform, 11);
}

function modChip(
  mod: HotkeyMod,
  platform: Platform,
  side?: Side | null,
): ChipItem {
  return {
    label: formatMod(mod, platform),
    icon: modIcon(mod, platform),
    side: displaySide(mod, platform, side) ?? undefined,
  };
}

function bindingToChips(binding: HotkeyBinding, platform: Platform): ChipItem[] {
  if (binding.kind === "doubleTap" && binding.mods.length > 0) {
    const m = binding.mods[0]!;
    return [
      {
        label: `2× ${formatMod(m, platform)}`,
        icon: modIcon(m, platform),
        side: displaySide(m, platform, getModSide(binding, m)) ?? undefined,
      },
    ];
  }
  const out: ChipItem[] = binding.mods.map((m) =>
    modChip(m, platform, getModSide(binding, m)),
  );
  if (binding.kind === "combo" && binding.code) {
    out.push({ label: formatCode(binding.code), icon: MAIN_ICON[binding.code] });
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
