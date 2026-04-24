import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { X, AlertCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  BINDING_LABELS,
  DEFAULT_MODE,
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
  | { kind: "recording"; startedAt: number; pressedMods: HotkeyMod[] }
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

  // 进入录入态
  const enterRecording = () => {
    if (state.kind !== "idle") return;
    pressedModsRef.current = [];
    setState({ kind: "settling", until: Date.now() + SETTLING_MS });
    window.setTimeout(() => {
      setState({ kind: "recording", startedAt: Date.now(), pressedMods: [] });
      // 5 秒超时取消
      timeoutRef.current = window.setTimeout(() => {
        setState({ kind: "idle" });
      }, RECORDING_TIMEOUT_MS);
    }, SETTLING_MS);
  };

  const exitToIdle = () => {
    if (timeoutRef.current) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setState({ kind: "idle" });
  };

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

  // 键盘监听
  useEffect(() => {
    if (state.kind !== "recording") return;
    const onKeyDown = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === "Escape") {
        exitToIdle();
        return;
      }
      if (isModifierCode(e.code)) {
        const mod = codeToMod(e.code);
        if (!mod) return;
        pressedModsRef.current = normalizeMods([
          ...pressedModsRef.current,
          mod,
        ]);
        setState((s) =>
          s.kind === "recording"
            ? { ...s, pressedMods: pressedModsRef.current }
            : s,
        );
        return;
      }
      // 主键按下——读 ref 拿到最新的 pressedMods，避免闭包捕获旧值
      const mods = normalizeMods(pressedModsRef.current);
      const legal = isLegalMainKey(e.code, mods, allowSpecialKeys);
      if (!legal.ok) {
        flashError(legal.reason ?? "非法组合");
        return;
      }
      const candidate: HotkeyBinding = {
        kind: "combo",
        mods,
        code: e.code,
        mode: value?.mode ?? DEFAULT_MODE[id],
      };
      const conflictId = onConflictCheck(candidate);
      if (conflictId && conflictId !== id) {
        setState({ kind: "conflict", with: conflictId, candidate });
        return;
      }
      onChange(candidate);
      exitToIdle();
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (isModifierCode(e.code)) {
        const mod = codeToMod(e.code);
        if (!mod) return;
        pressedModsRef.current = pressedModsRef.current.filter(
          (m) => m !== mod,
        );
        setState((s) =>
          s.kind === "recording"
            ? { ...s, pressedMods: pressedModsRef.current }
            : s,
        );
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    window.addEventListener("keyup", onKeyUp, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
      window.removeEventListener("keyup", onKeyUp, { capture: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.kind, allowSpecialKeys]);

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
                    // 预留右侧空间给嵌入的 × 清除按钮（始终保留，避免 hover 进出时文字跳动）
                    showClear && "pr-7",
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
