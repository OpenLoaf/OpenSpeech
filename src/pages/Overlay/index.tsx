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
const DEBUG_STRIP_HEIGHT = 28;
const EXPANDED_HEIGHT = TOAST_HEIGHT + TOAST_GAP + PILL_HEIGHT;
// toast 单独显示（无录音活动）时，整窗只渲染 toast 一行，省得用户被一条空的灰胶囊干扰。
const TOAST_ONLY_HEIGHT = TOAST_HEIGHT;

export default function OverlayPage() {
  const { t } = useTranslation();
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const { state, showToast, dismissToast, setEscArmed, applyFsm, setDebug } =
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
    onFsm: (p) =>
      applyFsm(
        p.state,
        p.activeId,
        p.errorMessage,
        p.liveTranscript,
        p.pillEarlyHide ?? false,
      ),
    onToast: showToast,
    // 任意非 repeat 的 Esc 按下都关 toast；录音内的双击/中止仍由主窗 FSM 收。
    onEscPressed: () => {
      if (state.toast !== null) dismissToast();
    },
    onEscArmed: () => setEscArmed(true),
    onEscDisarmed: () => setEscArmed(false),
    onDebug: (p) =>
      setDebug({
        active: p.active,
        endAtUnixMs: p.active ? p.endAtUnixMs ?? null : null,
        totalMs: p.active ? p.totalMs ?? 0 : 0,
      }),
  });

  // DEBUG 倒计时 ticker：每 200ms 重新算 remaining，驱动 strip 文案刷新。
  // 不依赖 setInterval 的精度；只要在 active 期间维持 ~5fps 即够用。
  const [debugRemainingMs, setDebugRemainingMs] = useState(0);
  useEffect(() => {
    if (!state.debug.active || state.debug.endAtUnixMs === null) {
      setDebugRemainingMs(0);
      return;
    }
    const tick = () => {
      const rem = Math.max(0, (state.debug.endAtUnixMs ?? 0) - Date.now());
      setDebugRemainingMs(rem);
    };
    tick();
    const t = window.setInterval(tick, 200);
    return () => window.clearInterval(t);
  }, [state.debug.active, state.debug.endAtUnixMs]);

  // 回到 idle 立即把波形 buffer 清掉——下一次 show 时不会闪一帧上次录音的尾巴。
  useEffect(() => {
    if (state.main === "idle") resetWaveform();
  }, [state.main]);

  // injecting 末尾段提前隐藏：流式 token 都已敲完、只剩末尾兜底 paste 那一段
  // 文字时，主窗会广播 pillEarlyHide=true。让用户在"看到几乎全部文字"那一刻
  // 同时看到悬浮栏退场，比"文字全敲完 + 800ms"再消失节奏快一拍。
  const pillEarlyHide = state.pillEarlyHide;
  const debugActive = state.debug.active;
  const visible =
    (state.main !== "idle" && !pillEarlyHide) ||
    state.toast !== null ||
    debugActive;
  // 录音活动期 = 胶囊必须显示。idle / error 时若有 toast，就让 toast 独占——
  // error 状态的红字本来就只是 toast 标题的回显，没必要在底下再挂个胶囊。
  const pillVisible = pillEarlyHide
    ? false
    : state.main !== "idle" && state.main !== "error"
      ? true
      : state.toast === null;

  // 窗口尺寸切换走"先涨后缩"两段：要变大时立刻涨（让动画里新元素有地方画），
  // 要变小时延迟到 framer-motion exit 动画结束（约 160ms）再收，避免窗口先于
  // toast/胶囊缩掉、把动画半路截断成生硬的 pop。
  const baseHeight = !visible
    ? 0
    : pillVisible
      ? state.toast
        ? EXPANDED_HEIGHT
        : PILL_HEIGHT
      : TOAST_ONLY_HEIGHT;
  const targetHeight = baseHeight + (debugActive ? DEBUG_STRIP_HEIGHT + TOAST_GAP : 0);
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
  const isTranslating = state.main === "translating";
  const isError = state.main === "error";
  const isTranslate = state.activeId === "translate";
  const translateTargetLang = useSettingsStore(
    (s) => s.general.translateTargetLang,
  );
  const translateLangShort: Record<string, string> = {
    en: "EN",
    zh: "中",
    "zh-TW": "繁",
    ja: "日",
    ko: "한",
    fr: "FR",
    de: "DE",
    es: "ES",
  };
  // 徽章仅在"录音中/准备中"挂着——进入 transcribing/injecting/error 后中心
  // 是进度文案 / 错误提示，徽章会挤占宽度让 truncate 截掉首字（"正在思考中…"
  // 变成 "E在思考中…"）。隐藏后中心区拿回完整宽度，翻译已经隐含于流程。
  const showTranslateBadge = isTranslate && (isRecording || isPreparing);
  const translateBadge = showTranslateBadge
    ? translateLangShort[translateTargetLang] ?? translateTargetLang.toUpperCase()
    : null;
  const canFinalize = isRecording || isPreparing;
  const canCancel = isRecording || isPreparing || isError;

  const toastAccent =
    state.toast?.kind === "info"
      ? "border-te-light-gray text-te-fg"
      : "border-te-accent text-te-accent";

  // 中央 AnimatePresence 用 centerKey 切换：同 key 只视作 prop 变化，不会触发动画。
  // transcribing / injecting / translating 共用 "progress" 容器（进度条不重启），
  // 内部的文字标签走另一层 AnimatePresence 单独 crossfade。
  const centerKey = isTranscribing || isInjecting || isTranslating
    ? "progress"
    : isError
      ? "error"
      : "wave";
  const progressLabelKey = isTranslating
    ? "translating"
    : isInjecting
      ? "injecting"
      : "transcribing";

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
        {debugActive && (
          <motion.div
            key="debug-strip"
            initial={{ opacity: 0, y: 6, height: 0, marginBottom: 0 }}
            animate={{
              opacity: 1,
              y: 0,
              height: DEBUG_STRIP_HEIGHT,
              marginBottom: TOAST_GAP,
            }}
            exit={{ opacity: 0, y: 4, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="flex items-center justify-between gap-2 overflow-hidden border border-dashed border-te-accent bg-te-bg px-2 leading-none"
          >
            <span className="shrink-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent">
              DEBUG · {Math.ceil(debugRemainingMs / 1000)}s
            </span>
            <span className="min-w-0 truncate whitespace-nowrap font-mono text-[9px] text-te-light-gray">
              ESC×2 取消
            </span>
          </motion.div>
        )}
      </AnimatePresence>

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

        {translateBadge ? (
          <span
            className="ml-1 inline-flex h-5 shrink-0 items-center gap-1 border border-te-accent bg-te-accent/10 px-1.5 font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent"
            aria-label={t("overlay:translate.target", { lang: translateBadge })}
          >
            <span className="text-[8px]">→</span>
            {translateBadge}
          </span>
        ) : null}

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
                    <span
                      key={progressLabelKey}
                      className="absolute inset-0 flex items-center justify-center truncate font-mono text-[10px] uppercase tracking-[0.15em] text-te-fg"
                    >
                      {t(
                        progressLabelKey === "translating"
                          ? "overlay:status.translating"
                          : progressLabelKey === "injecting"
                            ? "overlay:status.injecting"
                            : "overlay:status.transcribing",
                      )}
                    </span>
                  </div>
                  <div className="relative h-px w-32 overflow-hidden bg-te-gray/40">
                    <span className="te-progress-bar absolute inset-y-0 left-0 bg-te-accent" />
                  </div>
                </div>
              )}
              {centerKey === "error" && (
                <span className="truncate px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent">
                  {state.errorMessage ?? "ERROR"}
                </span>
              )}
              {centerKey === "wave" && (
                <Waveform barCount={isTranslate ? 16 : 20} />
              )}
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
