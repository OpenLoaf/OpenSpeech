import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Check, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { useTranslation } from "react-i18next";
import i18n, { resolveLang, SUPPORTED_LANGS, type SupportedLang } from "@/i18n";
import { applyLang } from "@/lib/i18n-sync";
import { useSettingsStore } from "@/stores/settings";
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
// toast 单独显示（无录音活动）时，整窗只渲染 toast 一行，省得用户被一条空的灰胶囊干扰。
const TOAST_ONLY_HEIGHT = TOAST_HEIGHT;

export default function OverlayPage() {
  const { t } = useTranslation();
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const { state, showToast, dismissToast, setEscArmed, applyFsm } =
    useOverlayMachine();

  // boot IIFE 跑 applyLang 是 race 路径——overlay 第一次拿到 settings 之前可能就
  // 已经渲染过 t()。这里把 i18n 语言绑死到 settings.interfaceLang：mount + 主窗
  // 切语言（settings store 持久化后 loaded 触发）都会重新对齐一次，避免悬浮条
  // 卡在初始 navigator.language 上。
  useEffect(() => {
    if (!settingsLoaded) return;
    const lang = resolveLang(interfaceLang);
    if ((SUPPORTED_LANGS as readonly string[]).includes(lang)) {
      void applyLang(lang as SupportedLang);
    }
    if (i18n.language !== lang) {
      void i18n.changeLanguage(lang);
    }
  }, [interfaceLang, settingsLoaded]);

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
  // 录音活动期 = 胶囊必须显示。idle / error 时若有 toast，就让 toast 独占——
  // error 状态的红字本来就只是 toast 标题的回显，没必要在底下再挂个胶囊。
  const pillVisible =
    state.main !== "idle" && state.main !== "error" ? true : state.toast === null;

  // 窗口尺寸切换走"先涨后缩"两段：要变大时立刻涨（让动画里新元素有地方画），
  // 要变小时延迟到 framer-motion exit 动画结束（约 160ms）再收，避免窗口先于
  // toast/胶囊缩掉、把动画半路截断成生硬的 pop。
  const targetHeight = !visible
    ? 0
    : pillVisible
      ? state.toast
        ? EXPANDED_HEIGHT
        : PILL_HEIGHT
      : TOAST_ONLY_HEIGHT;
  const [appliedHeight, setAppliedHeight] = useState(targetHeight);
  useEffect(() => {
    if (targetHeight === appliedHeight) return;
    if (targetHeight > appliedHeight) {
      setAppliedHeight(targetHeight);
      return;
    }
    const t = window.setTimeout(() => setAppliedHeight(targetHeight), 200);
    return () => window.clearTimeout(t);
  }, [targetHeight, appliedHeight]);

  useEffect(() => {
    if (!visible || appliedHeight <= 0) return;
    invoke("overlay_set_height", { height: appliedHeight }).catch((e) =>
      console.warn("[overlay] set_height failed", e),
    );
  }, [appliedHeight, visible]);

  // 不可见时调用 hide。Rust 端 hide 是单 command 串行：先移屏外 → 复位尺寸 → hide，
  // 不会再有 IPC 顺序竞争留下黑条/旧尺寸。延迟一帧让 motion exit 跑完再 hide。
  useEffect(() => {
    if (visible) return;
    const t = window.setTimeout(() => {
      invoke("overlay_hide").catch((e) =>
        console.warn("[overlay] hide failed", e),
      );
    }, 200);
    return () => window.clearTimeout(t);
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
  // transcribing / injecting 共用 "progress" 容器（进度条不重启），内部的文字标签
  // 走另一层 AnimatePresence 单独 crossfade。
  const centerKey = isTranscribing || isInjecting
    ? "progress"
    : isError
      ? "error"
      : "wave";
  const progressLabelKey = isInjecting ? "injecting" : "transcribing";

  return (
    <AnimatePresence>
      {visible && (
    <motion.div
      key="overlay-shell"
      initial={{ opacity: 0, scale: 0.94, y: 4 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.94, y: 4 }}
      transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
      className="flex h-screen w-screen flex-col justify-end"
      style={{ transformOrigin: "50% 100%" }}
    >
      <AnimatePresence initial={false}>
        {state.toast && (
          <motion.div
            key={state.toast.id}
            initial={{ opacity: 0, y: 8, height: 0, marginBottom: 0 }}
            animate={{
              opacity: 1,
              y: 0,
              height: TOAST_HEIGHT,
              marginBottom: pillVisible ? TOAST_GAP : 0,
            }}
            exit={{ opacity: 0, y: 4, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "flex items-center gap-1.5 overflow-hidden border bg-te-bg px-2 py-1",
              toastAccent,
            )}
          >
            <AlertTriangle className="size-3 shrink-0" />
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
                  "shrink-0 border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em]",
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

      <AnimatePresence initial={false}>
      {pillVisible && (
      <motion.div
        key="overlay-pill"
        initial={{ opacity: 0, y: 6, height: 0 }}
        animate={{ opacity: 1, y: 0, height: PILL_HEIGHT }}
        exit={{ opacity: 0, y: 6, height: 0 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          "flex w-full items-center gap-2 overflow-hidden border px-1.5 transition-colors",
          isError ? "border-te-accent bg-te-bg" : "border-te-gray bg-te-bg",
        )}
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
              {centerKey === "progress" && (
                <div className="relative flex h-full w-full flex-col items-center justify-center gap-1 px-2">
                  <div className="relative h-3 w-full">
                    <AnimatePresence initial={false}>
                      <motion.span
                        key={progressLabelKey}
                        initial={{ opacity: 0 }}
                        animate={{ opacity: 1 }}
                        exit={{ opacity: 0 }}
                        transition={{ duration: 0.24, ease: "easeInOut" }}
                        className="absolute inset-0 flex items-center justify-center truncate font-mono text-[10px] uppercase tracking-[0.15em] text-te-fg"
                      >
                        {t(
                          progressLabelKey === "injecting"
                            ? "overlay:status.injecting"
                            : "overlay:status.transcribing",
                        )}
                      </motion.span>
                    </AnimatePresence>
                  </div>
                  <div className="relative h-px w-32 overflow-hidden bg-te-gray/40">
                    <motion.span
                      className="absolute inset-y-0 bg-te-accent"
                      style={{ width: "33%" }}
                      initial={{ left: "-33%" }}
                      animate={{ left: "100%" }}
                      transition={{
                        duration: 1.1,
                        repeat: Infinity,
                        ease: "linear",
                      }}
                    />
                  </div>
                </div>
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
      </motion.div>
      )}
      </AnimatePresence>
    </motion.div>
      )}
    </AnimatePresence>
  );
}
