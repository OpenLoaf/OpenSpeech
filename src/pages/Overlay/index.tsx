import { memo, useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Check, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording";

// 独立 WebviewWindow（label=overlay），200×36 logical px。布局：× | 波形 | ✓。
// 波形 bar 的高度由真实麦克风电平驱动 —— audio-level 事件 @ 20Hz 喂进
// recording store 的 audioLevels ring buffer。
//
// 错误条：主窗 store 通过 emitTo("overlay", "openspeech://overlay-toast", ...)
// 发来的提示直接渲染在胶囊上方，不再把主程序拉到前台。可选 action 让用户点击
// 后再反向通知主窗执行（"登录" / "打开网络设置" 这类必须主窗 dialog 的动作）。

const BAR_MIN_H = 3;
const BAR_MAX_H = 26;
// Rust 端做完 gate + gain 后输出已经是 [0,1]；这里只用 sqrt 拉高低音区可见度，
// 不叠加放大倍率（叠加会让底噪漏掉时直接拉满）。

const PILL_HEIGHT = 36;
const TOAST_HEIGHT = 42;
const TOAST_GAP = 4;
const EXPANDED_HEIGHT = TOAST_HEIGHT + TOAST_GAP + PILL_HEIGHT;
const TOAST_AUTO_DISMISS_MS = 2000;

type OverlayToastKind = "error" | "warning" | "info";
type OverlayToastActionKey =
  | "open_login"
  | "open_no_internet"
  | "open_settings_byo";

interface OverlayToastPayload {
  kind: OverlayToastKind;
  title: string;
  description?: string;
  action?: { label: string; key: OverlayToastActionKey };
  /** 0 = 不自动消失（用户必须显式关闭或点动作）。默认 6000ms。 */
  durationMs?: number;
}

interface OverlayToastState extends OverlayToastPayload {
  id: number;
}

// Waveform 自己订阅 audioLevels —— 录音中 20Hz 的电平更新只触发本子组件 re-render，
// 上层 OverlayPage 不再因为电平变化而重渲染（带 toast 的整条悬浮条尤其受益）。
//
// 性能要点：用 transform: scaleY 替代 height 动画，bar 的几何尺寸固定为 BAR_MAX_H，
// 仅靠 GPU 合成层做缩放——不触发 layout / paint，主线程只在事件到达时算一次新比例。
// 配合 CSS transition (80ms) 由浏览器调度，避免 framer-motion 给 15 个独立 motion.span
// 维护各自 RAF 状态的开销。
const Waveform = memo(function Waveform() {
  const levels = useRecordingStore((s) => s.audioLevels);
  return (
    <div className="flex h-full w-full items-center justify-between">
      {levels.map((lvl, i) => {
        const boosted = Math.min(1, Math.sqrt(Math.max(0, lvl)));
        const ratio =
          (BAR_MIN_H + boosted * (BAR_MAX_H - BAR_MIN_H)) / BAR_MAX_H;
        return (
          <span
            key={i}
            className="inline-block w-[3px] origin-center bg-te-fg"
            style={{
              height: BAR_MAX_H,
              transform: `scaleY(${ratio})`,
              transition: "transform 80ms ease-out",
              willChange: "transform",
            }}
          />
        );
      })}
    </div>
  );
});

export default function OverlayPage() {
  const { t } = useTranslation();
  const state = useRecordingStore((s) => s.state);
  const errorMessage = useRecordingStore((s) => s.errorMessage);

  const [toast, setToast] = useState<OverlayToastState | null>(null);
  const toastTimerRef = useRef<number | null>(null);
  const nextToastIdRef = useRef(1);
  const [escArmed, setEscArmed] = useState(false);

  const dismissToast = () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast(null);
  };

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      unlisten = await listen<OverlayToastPayload>(
        "openspeech://overlay-toast",
        (evt) => {
          const p = evt.payload;
          if (toastTimerRef.current !== null) {
            window.clearTimeout(toastTimerRef.current);
            toastTimerRef.current = null;
          }
          const id = nextToastIdRef.current++;
          setToast({ ...p, id });
          const dur = p.durationMs ?? TOAST_AUTO_DISMISS_MS;
          if (dur > 0) {
            toastTimerRef.current = window.setTimeout(() => {
              setToast((cur) => (cur && cur.id === id ? null : cur));
              toastTimerRef.current = null;
            }, dur);
          }
        },
      );
    })();
    return () => {
      unlisten?.();
      if (toastTimerRef.current !== null) {
        window.clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // 仅在"应该可见"时同步高度。idle 复位由下面 visible→false 那条 effect 处理，
  // Rust show_now 也会强制把 inner_size 复位到 HEIGHT 兜底。
  const visible = state !== "idle" || toast !== null;
  useEffect(() => {
    if (!visible) return;
    const h = toast ? EXPANDED_HEIGHT : PILL_HEIGHT;
    invoke("overlay_set_height", { height: h }).catch((e) =>
      console.warn("[overlay] set_height failed", e),
    );
  }, [toast, visible]);

  // ESC 关闭悬浮条上的 toast：所有窗口都收 `openspeech://key-preview`，overlay
  // 这里只管"有 toast 就关 toast"。录音激活态下的双击 ESC 取消逻辑在主窗
  // recording.ts 的 listener 里（escArmedAt + 1.5s 窗口），两端互不干扰。
  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    void (async () => {
      unlisten = await listen<{ code: string; phase: "pressed" | "released" }>(
        "openspeech://key-preview",
        (evt) => {
          if (evt.payload.phase !== "pressed") return;
          if (evt.payload.code !== "Escape") return;
          setToast((cur) => {
            if (cur === null) return cur;
            if (toastTimerRef.current !== null) {
              window.clearTimeout(toastTimerRef.current);
              toastTimerRef.current = null;
            }
            return null;
          });
        },
      );
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // recording.ts 的 ESC handler 进入 ARM 时广播一次 → X 按钮黄色闪烁；超时 / 二次
  // ESC 取消生效后再广播 disarmed 复位描边。
  useEffect(() => {
    let offArmed: UnlistenFn | null = null;
    let offDisarmed: UnlistenFn | null = null;
    void (async () => {
      offArmed = await listen("openspeech://esc-armed", () => setEscArmed(true));
      offDisarmed = await listen("openspeech://esc-disarmed", () =>
        setEscArmed(false),
      );
    })();
    return () => {
      offArmed?.();
      offDisarmed?.();
    };
  }, []);

  // overlay 是镜像窗口：按钮交互只能通过 emitTo 发回主窗，主窗 listener 调
  // 真实的 simulateCancel / simulateFinalize（那里才有 Rust 录音 / STT 副作用）。
  const cancel = () => {
    void emitTo("main", "openspeech://overlay-action", "cancel");
  };
  const finalize = () => {
    void emitTo("main", "openspeech://overlay-action", "finalize");
  };
  const runToastAction = (key: OverlayToastActionKey) => {
    void emitTo("main", "openspeech://overlay-toast-action", key);
    dismissToast();
  };

  // visible 由 true → false 时立刻物理 hide。Tauri overlay 窗口是不透明黑底，
  // 走 React fade 退场会出现"opacity 已 0 但窗口还在"的全黑长条；直接 hide 让
  // 窗口和状态切走在同一帧。set_height 复位是为了 hide 之前先把窗口尺寸归位
  // （IPC 顺序不保证，hide 先到则窗口会带着上次 EXPANDED_HEIGHT 进入下次 show）。
  useEffect(() => {
    if (visible) return;
    invoke("overlay_set_height", { height: PILL_HEIGHT }).catch(() => {});
    invoke("overlay_hide").catch((e) =>
      console.warn("[overlay] hide failed", e),
    );
  }, [visible]);

  const isRecording = state === "recording";
  const isPreparing = state === "preparing";
  const isTranscribing = state === "transcribing";
  const isInjecting = state === "injecting";
  const isError = state === "error";
  const canFinalize = isRecording || isPreparing;
  const canCancel = isRecording || isPreparing || isError;

  const toastAccent =
    toast?.kind === "info"
      ? "border-te-light-gray text-te-fg"
      : "border-te-accent text-te-accent";

  // 胶囊中央在不同 FSM 阶段切换的内容用同一个 key 空间——AnimatePresence 才能
  // 识别"换内容"并跑出 / 入场动画；同 key 只视作 prop 变化，不会触发过渡。
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
      className="flex h-screen w-screen flex-col bg-te-bg"
      style={{ transformOrigin: "50% 100%" }}
    >
          <AnimatePresence>
            {toast && (
              <motion.div
                key={toast.id}
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
                    {toast.title}
                  </div>
                  {toast.description && (
                    <div className="truncate font-mono text-[9px] leading-[1.25] text-te-light-gray">
                      {toast.description}
                    </div>
                  )}
                </div>
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => runToastAction(toast.action!.key)}
                    className={cn(
                      "shrink-0 self-center border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em]",
                      "hover:bg-te-accent hover:text-te-accent-fg",
                      toastAccent,
                    )}
                  >
                    {toast.action.label}
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
                escArmed
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
                  {/* {centerKey === "injecting" && (
                    <Check className="size-3.5 text-te-accent" />
                  )} */}
                  {centerKey === "error" && (
                    <span className="truncate px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent">
                      {errorMessage ?? "ERROR"}
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
