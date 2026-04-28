import { useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Check, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useOverlayMachine, type ToastActionKey } from "./state";
import { useOverlayListeners } from "./listeners";
import { Waveform, resetWaveform } from "./Waveform";

// 200×36 logical px 胶囊；toast 弹出时窗口高度扩到 EXPANDED_HEIGHT，胶囊位置不变、
// 提示条向上展开。Rust 端 overlay_set_height 会重新计算底部锚点。
const PILL_HEIGHT = 36;
const TOAST_HEIGHT = 42;
const TOAST_GAP = 4;
const EXPANDED_HEIGHT = TOAST_HEIGHT + TOAST_GAP + PILL_HEIGHT;

export default function OverlayPage() {
  const { t } = useTranslation();
  const { state, showToast, dismissToast, setEscArmed, applyFsm } =
    useOverlayMachine();

  useOverlayListeners({
    onFsm: (p) => applyFsm(p.state, p.errorMessage, p.liveTranscript),
    onToast: showToast,
    // 任意非 repeat 的 Esc 按下都关 toast；录音内的双击/中止仍由主窗 FSM 收。
    onEscPressed: () => {
      if (state.toast !== null) dismissToast();
    },
    onEscArmed: () => setEscArmed(true),
    onEscDisarmed: () => setEscArmed(false),
  });

  // 回到 idle 立即把波形 buffer 清掉——下一次 show 时不会闪一帧上次录音的尾巴。
  useEffect(() => {
    if (state.main === "idle") resetWaveform();
  }, [state.main]);

  const visible = state.main !== "idle" || state.toast !== null;

  // 可见时根据 toast 是否存在调整窗口高度；切换通过 set_height 命令。
  useEffect(() => {
    if (!visible) return;
    const h = state.toast ? EXPANDED_HEIGHT : PILL_HEIGHT;
    invoke("overlay_set_height", { height: h }).catch((e) =>
      console.warn("[overlay] set_height failed", e),
    );
  }, [state.toast, visible]);

  // 不可见时调用 hide。Rust 端 hide 是单 command 串行：先移屏外 → 复位尺寸 → hide，
  // 不会再有 IPC 顺序竞争留下黑条/旧尺寸。
  useEffect(() => {
    if (visible) return;
    invoke("overlay_hide").catch((e) =>
      console.warn("[overlay] hide failed", e),
    );
  }, [visible]);

  // overlay 是镜像窗口：按钮交互通过 emitTo 发回主窗，主窗 FSM 调真实的 Rust 副作用。
  const cancel = () => {
    void emitTo("main", "openspeech://overlay-action", "cancel");
  };
  const finalize = () => {
    void emitTo("main", "openspeech://overlay-action", "finalize");
  };
  const runToastAction = (key: ToastActionKey) => {
    void emitTo("main", "openspeech://overlay-toast-action", key);
    dismissToast();
  };

  const isRecording = state.main === "recording";
  const isPreparing = state.main === "preparing";
  const isTranscribing = state.main === "transcribing";
  const isInjecting = state.main === "injecting";
  const isError = state.main === "error";
  const canFinalize = isRecording || isPreparing;
  const canCancel = isRecording || isPreparing || isError;

  const toastAccent =
    state.toast?.kind === "info"
      ? "border-te-light-gray text-te-fg"
      : "border-te-accent text-te-accent";

  // 中央 AnimatePresence 用 centerKey 切换：同 key 只视作 prop 变化，不会触发动画。
  const centerKey = isTranscribing
    ? "transcribing"
    : isInjecting
      ? "injecting"
      : isError
        ? "error"
        : "wave";

  if (!visible) return null;
  return (
    <motion.div
      key="overlay-shell"
      initial={{ opacity: 0, scale: 0.94, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-screen w-screen flex-col"
      style={{ transformOrigin: "50% 100%" }}
    >
      <AnimatePresence>
        {state.toast && (
          <motion.div
            key={state.toast.id}
            initial={{ opacity: 0, y: -6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.15 }}
            className={cn(
              "flex items-start gap-1.5 border bg-te-bg px-2 py-1",
              toastAccent,
            )}
            style={{ height: TOAST_HEIGHT, marginBottom: TOAST_GAP }}
          >
            <AlertTriangle className="mt-0.5 size-3 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="truncate font-mono text-[10px] uppercase tracking-[0.15em]">
                {state.toast.title}
              </div>
              {state.toast.description && (
                <div className="truncate font-mono text-[9px] leading-[1.25] text-te-light-gray">
                  {state.toast.description}
                </div>
              )}
            </div>
            {state.toast.action && (
              <button
                type="button"
                onClick={() => runToastAction(state.toast!.action!.key)}
                className={cn(
                  "shrink-0 self-center border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em]",
                  "hover:bg-te-accent hover:text-te-accent-fg",
                  toastAccent,
                )}
              >
                {state.toast.action.label}
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className={cn(
          "flex w-full items-center gap-2 border px-1.5 transition-colors",
          isError ? "border-te-accent bg-te-bg" : "border-te-gray bg-te-bg",
        )}
        style={{ height: PILL_HEIGHT }}
      >
        <button
          type="button"
          onClick={cancel}
          disabled={!canCancel}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center border transition-colors",
            state.escArmed
              ? "animate-pulse border-te-accent text-te-accent"
              : canCancel
                ? "border-te-gray text-te-fg hover:border-te-accent hover:text-te-accent"
                : "border-te-gray/40 text-te-light-gray/40",
          )}
          aria-label={t("overlay:aria.cancel")}
        >
          <X className="size-3" />
        </button>

        <div className="flex min-w-0 flex-1 items-center justify-center">
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={centerKey}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
              className="flex h-full w-full items-center justify-center"
            >
              {centerKey === "transcribing" && (
                <span className="truncate px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-te-fg">
                  {t("overlay:status.transcribing")}
                </span>
              )}
              {centerKey === "error" && (
                <span className="truncate px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent">
                  {state.errorMessage ?? "ERROR"}
                </span>
              )}
              {centerKey === "wave" && <Waveform />}
            </motion.div>
          </AnimatePresence>
        </div>

        <button
          type="button"
          onClick={finalize}
          disabled={!canFinalize}
          className={cn(
            "flex size-6 shrink-0 items-center justify-center border transition-colors",
            canFinalize
              ? "border-te-accent text-te-accent hover:bg-te-accent hover:text-te-accent-fg"
              : "border-te-gray/40 text-te-light-gray/40",
          )}
          aria-label={t("overlay:aria.confirm")}
        >
          <Check className="size-3" />
        </button>
      </div>
    </motion.div>
  );
}
