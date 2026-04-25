import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, AlertCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import {
  BINDING_LABELS,
  codeToMod,
  formatBinding,
  isLegalMainKey,
  isModifierCode,
  normalizeMods,
  type BindingId,
  type HotkeyBinding,
  type HotkeyMod,
} from "@/lib/hotkey";
import { detectPlatform } from "@/lib/platform";

// Rust 侧 emit 的事件名（见 src-tauri/src/hotkey/modifier_only.rs）
const RECORDING_EVENT = "openspeech://hotkey-recording";
interface RecordingPayload {
  code: string;
  phase: "pressed" | "released";
}

interface Props {
  id: BindingId;
  value: HotkeyBinding | null;
  onChange: (v: HotkeyBinding | null) => void;
  onConflictCheck: (candidate: HotkeyBinding) => BindingId | null;
  canClear: boolean;
  allowSpecialKeys?: boolean;
  // 录入按钮左侧插槽（例如听写行的"单击切换"Switch 紧贴录入按钮左侧）
  fieldLeadingSlot?: React.ReactNode;
  // 整个 row 下方的副区块（例如当前模式的文字说明）
  bottomSlot?: React.ReactNode;
}

type FieldState =
  | { kind: "idle" }
  | { kind: "settling"; until: number }
  | {
      kind: "recording";
      startedAt: number;
      pressedMods: HotkeyMod[];
      everPressedMods: HotkeyMod[];
      sawMainKey: boolean;
    }
  | { kind: "error"; message: string }
  | { kind: "conflict"; with: BindingId; candidate: HotkeyBinding };

const SETTLING_MS = 150;
const RECORDING_TIMEOUT_MS = 5000;

export function HotkeyField({
  id,
  value,
  onChange,
  onConflictCheck,
  canClear,
  allowSpecialKeys = false,
  fieldLeadingSlot,
  bottomSlot,
}: Props) {
  const platform = detectPlatform();
  const [state, setState] = useState<FieldState>({ kind: "idle" });
  const rootRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<number | null>(null);

  // pressedMods 的真实来源——避免 keydown 闭包捕获旧值。
  const pressedModsRef = useRef<HotkeyMod[]>([]);
  // 本次录入过程中按下过的所有修饰键（即使已松开），用于 modifier-only 完成判定。
  const everPressedModsRef = useRef<HotkeyMod[]>([]);
  // 录入中是否按过非修饰主键（按过 → 走 combo 路径；否则松开时作为 modifier-only）。
  const sawMainKeyRef = useRef<boolean>(false);
  // 避免组件卸载后 invoke(false) / state 更新引发 warning。
  const recordingActiveRef = useRef<boolean>(false);

  const startRustRecording = () => {
    if (recordingActiveRef.current) return;
    recordingActiveRef.current = true;
    invoke("set_hotkey_recording", { enabled: true }).catch((e) =>
      console.warn("[HotkeyField] set_hotkey_recording(true) failed:", e),
    );
  };

  const stopRustRecording = () => {
    if (!recordingActiveRef.current) return;
    recordingActiveRef.current = false;
    invoke("set_hotkey_recording", { enabled: false }).catch((e) =>
      console.warn("[HotkeyField] set_hotkey_recording(false) failed:", e),
    );
  };

  // 进入录入态
  const enterRecording = () => {
    if (state.kind !== "idle") return;
    pressedModsRef.current = [];
    everPressedModsRef.current = [];
    sawMainKeyRef.current = false;
    setState({ kind: "settling", until: Date.now() + SETTLING_MS });
    window.setTimeout(() => {
      setState({
        kind: "recording",
        startedAt: Date.now(),
        pressedMods: [],
        everPressedMods: [],
        sawMainKey: false,
      });
      startRustRecording();
      // 5 秒超时取消
      timeoutRef.current = window.setTimeout(() => {
        stopRustRecording();
        setState({ kind: "idle" });
      }, RECORDING_TIMEOUT_MS);
    }, SETTLING_MS);
  };

  const exitToIdle = () => {
    stopRustRecording();
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setState({ kind: "idle" });
  };

  // 组件卸载时确保 Rust 侧录入模式关闭（防 panel 被关掉后 rdev 仍吞事件）。
  useEffect(() => stopRustRecording, []);

  const flashError = (message: string) => {
    setState({ kind: "error", message });
    window.setTimeout(() => setState({ kind: "idle" }), 3000);
  };

  // 全局监听点击外部 / 失焦
  useEffect(() => {
    if (state.kind !== "recording" && state.kind !== "settling") return;
    const onClickOut = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        exitToIdle();
      }
    };
    const onBlur = () => {
      window.setTimeout(() => {
        if (document.visibilityState === "hidden") exitToIdle();
      }, 1000);
    };
    window.addEventListener("mousedown", onClickOut);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("mousedown", onClickOut);
      window.removeEventListener("blur", onBlur);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind]);

  // DOM 和 Rust 两路事件共用的核心逻辑。纯基于 code 字符串（Rust 侧也归一化成
  // KeyboardEvent.code 风格；Fn 用约定 token "Fn"）。
  const handlePressRef = useRef<(code: string) => void>(() => {});
  const handleReleaseRef = useRef<(code: string) => void>(() => {});
  handlePressRef.current = (code: string) => {
    if (code === "Escape") {
      exitToIdle();
      return;
    }
    if (isModifierCode(code)) {
      const mod = codeToMod(code);
      if (!mod) return;
      if (!pressedModsRef.current.includes(mod)) {
        pressedModsRef.current = normalizeMods([
          ...pressedModsRef.current,
          mod,
        ]);
      }
      if (!everPressedModsRef.current.includes(mod)) {
        everPressedModsRef.current = normalizeMods([
          ...everPressedModsRef.current,
          mod,
        ]);
      }
      setState((s) =>
        s.kind === "recording"
          ? {
              ...s,
              pressedMods: pressedModsRef.current,
              everPressedMods: everPressedModsRef.current,
            }
          : s,
      );
      return;
    }
    // 主键按下 → 走 combo 判定
    sawMainKeyRef.current = true;
    const mods = normalizeMods(pressedModsRef.current);
    const legal = isLegalMainKey(code, mods, allowSpecialKeys);
    if (!legal.ok) {
      flashError(legal.reason ?? "非法组合");
      return;
    }
    const candidate: HotkeyBinding = {
      kind: "combo",
      mods,
      code,
    };
    const conflictId = onConflictCheck(candidate);
    if (conflictId && conflictId !== id) {
      setState({ kind: "conflict", with: conflictId, candidate });
      stopRustRecording();
      return;
    }
    onChange(candidate);
    exitToIdle();
  };
  handleReleaseRef.current = (code: string) => {
    if (!isModifierCode(code)) return;
    const mod = codeToMod(code);
    if (!mod) return;
    pressedModsRef.current = pressedModsRef.current.filter((m) => m !== mod);
    setState((s) =>
      s.kind === "recording"
        ? { ...s, pressedMods: pressedModsRef.current }
        : s,
    );
    // 全部修饰键松开 + 录入期间没按过主键 + 至少按过 1 个修饰键 → modifier-only
    if (
      pressedModsRef.current.length === 0 &&
      !sawMainKeyRef.current &&
      everPressedModsRef.current.length > 0
    ) {
      const mods = everPressedModsRef.current;
      const candidate: HotkeyBinding = {
        kind: "modifierOnly",
        mods,
        code: "",
      };
      const conflictId = onConflictCheck(candidate);
      if (conflictId && conflictId !== id) {
        setState({ kind: "conflict", with: conflictId, candidate });
        stopRustRecording();
        return;
      }
      onChange(candidate);
      exitToIdle();
    }
  };

  // DOM 键盘监听（普通 combo 路径；Fn 键在 macOS 上 DOM 收不到，由下方 Tauri 事件补齐）
  useEffect(() => {
    if (state.kind !== "recording") return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      handlePressRef.current(e.code);
    };
    const onKeyUp = (e: KeyboardEvent) => {
      handleReleaseRef.current(e.code);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
  }, [state.kind]);

  // Tauri rdev 通道——macOS 上 Fn 键只有这条路能收到。
  // Rust 侧在录入模式下把所有 press/release pass-through 过来（不参与 binding 匹配）。
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

  const confirmReplace = () => {
    if (state.kind !== "conflict") return;
    onChange(state.candidate);
    exitToIdle();
  };

  const cancelReplace = () => {
    exitToIdle();
  };

  // Clear 按钮嵌入录入按钮内部右侧：hover 录入按钮/Clear 按钮时淡入；
  // 通过父容器 `group` + `group-hover:opacity-100` 实现。点击 Clear 时
  // stopPropagation，避免冒泡到录入按钮触发 enterRecording。
  const showClear = canClear && !!value && state.kind !== "recording" && state.kind !== "settling";

  return (
    <div className="flex flex-col gap-1 py-3">
      <div className="flex items-center justify-between gap-4">
        <span className="font-sans text-sm text-te-fg">
          {BINDING_LABELS[id]}
        </span>

        <div className="flex items-center gap-2">
          {fieldLeadingSlot}
          <div className="group relative" ref={rootRef}>
            <AnimatePresence mode="wait">
              {state.kind === "recording" || state.kind === "settling" ? (
                <motion.button
                  key="recording"
                  type="button"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{ duration: 0.12 }}
                  aria-live="polite"
                  className={cn(
                    "inline-flex min-w-[10rem] items-center justify-center border px-3 py-2 font-mono text-xs uppercase tracking-[0.15em] transition-colors",
                    "border-te-accent bg-te-accent/8 text-te-accent",
                    state.kind === "recording" &&
                      "animate-[pulse_1.2s_ease-in-out_infinite]",
                  )}
                  onClick={exitToIdle}
                >
                  按下新快捷键...
                </motion.button>
              ) : (
                <motion.button
                  key="display"
                  type="button"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  onClick={enterRecording}
                  className={cn(
                    "inline-flex min-w-[10rem] items-center justify-center border px-3 py-2 font-mono text-xs text-te-fg transition-colors",
                    "border-te-gray/40 bg-te-surface hover:border-te-gray",
                    state.kind === "error" &&
                      "border-te-accent/70 text-te-accent animate-[shake_0.25s]",
                    !value && "text-te-light-gray",
                    // 预留两侧空间给嵌入的 × 清除按钮，对称 padding 保证文字居中（始终保留，避免 hover 进出时文字跳动）
                    showClear && "px-7",
                  )}
                >
                  {formatBinding(value, platform)}
                </motion.button>
              )}
            </AnimatePresence>

            {showClear ? (
              <button
                type="button"
                title="清除"
                aria-label="清除快捷键"
                onClick={(e) => {
                  e.stopPropagation();
                  onChange(null);
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className="absolute top-1/2 right-1.5 -translate-y-1/2 flex size-5 items-center justify-center text-te-light-gray opacity-0 transition-opacity group-hover:opacity-100 hover:text-te-fg focus-visible:opacity-100"
              >
                <X className="size-3.5" />
              </button>
            ) : null}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {state.kind === "error" && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center gap-1.5 text-right font-mono text-[11px] text-te-accent"
          >
            <AlertCircle className="size-3" />
            <span>ERROR: {state.message}</span>
          </motion.div>
        )}
        {state.kind === "conflict" && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="flex items-center justify-end gap-3 font-mono text-[11px] text-te-light-gray"
          >
            <span>
              此组合已被「{BINDING_LABELS[state.with]}」使用
            </span>
            <ConflictBtn onClick={confirmReplace}>替换</ConflictBtn>
            <ConflictBtn onClick={cancelReplace} variant="ghost">
              取消
            </ConflictBtn>
          </motion.div>
        )}
      </AnimatePresence>

      {bottomSlot}
    </div>
  );
}

function ConflictBtn({
  onClick,
  children,
  variant = "solid",
}: {
  onClick: () => void;
  children: React.ReactNode;
  variant?: "solid" | "ghost";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.15em] transition-colors",
        variant === "solid"
          ? "border border-te-accent bg-te-accent text-te-accent-fg hover:bg-te-accent/90"
          : "border border-te-gray/40 text-te-light-gray hover:text-te-fg",
      )}
    >
      {children}
    </button>
  );
}
