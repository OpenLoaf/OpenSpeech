import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { AlertTriangle, Check, Languages, Mic, X } from "lucide-react";
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

// 200×36 logical px 胶囊；toast / debug strip 通过 motion 在 pill 上方展开，
// pill 永远贴 webview 底。webview 窗口尺寸由 Rust 端固定（src-tauri/src/overlay/mod.rs），
// 内部不再调 set_height ——避免 NSWindow setContentSize 引起整窗一帧重绘的"刷新闪一下"。
//
// PILL_WIDTH < 窗口 WIDTH：pill / debug-strip / translate-indicator 用 PILL_WIDTH
// 居中显示，把窗口左右富余的透明区让出来；只有 toast 走 w-full 撑满整窗——这样
// 录音条本身视觉宽度永远是老样子的 200px，仅在出错提示时 toast 真的看起来更大。
const PILL_WIDTH = 200;
const PILL_HEIGHT = 36;
// 64：title 11px + description 11px×2 行（line-clamp-2）+ 上下 padding/边距，
// 让"自定义供应商凭证缺失，请到设置 → 听写 → 自定义供应商配置"这种带行动按钮的
// 失败 toast 能完整读出来；轻量 toast（仅 title 一行，无 description）也撑得住，
// align-items 居中后视觉居中。
const TOAST_HEIGHT = 64;
const TOAST_GAP = 4;
const DEBUG_STRIP_HEIGHT = 28;
const TRANSLATE_INDICATOR_HEIGHT = 24;

export default function OverlayPage() {
  const { t } = useTranslation();
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const settingsLoaded = useSettingsStore((s) => s.loaded);
  const {
    state,
    showToast,
    dismissToast,
    setEscArmed,
    applyFsm,
    setDebug,
    setTranslate,
    showModeSwitchHint,
  } = useOverlayMachine();

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
    onTranslate: (p) =>
      setTranslate({ active: p.active, lang: p.active ? p.lang ?? "" : "" }),
    onModeSwitchHint: (p) => showModeSwitchHint(p.kind),
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
  // indicator 显示条件：翻译激活态本身在 || 当前正处于切换过渡（让"切换为听写
  // 模式"提示有壳子可挂；过渡结束后 modeSwitchHint 清空，若 translate.active
  // 也是 false（切到听写完成），indicator 自然退场）。
  const translateIndicatorVisible =
    state.translate.active || state.modeSwitchHint !== null;
  const visible =
    (state.main !== "idle" && !pillEarlyHide) ||
    state.toast !== null ||
    debugActive ||
    translateIndicatorVisible;
  // 底部 shell 共享一个 motion.div，pill / toast 形态在容器内 crossfade，
  // 容器自身的 height 由 framer-motion layout 自动平滑过渡——避免 pill 退场 +
  // toast 入场两个独立动画并发引起的"内容跳一下"。
  // - recordingActive：pill 形态（X / wave / progress / Check / ERROR errorMsg）
  // - !recordingActive + toast：toast 形态（icon + title + description + action）
  // - error 无 toast：pill 形态（ERROR + errorMessage 让用户知道为什么）
  // - idle 无 toast：bottom-shell 不存在
  const recordingActive =
    !pillEarlyHide && state.main !== "idle" && state.main !== "error";
  const hasToast = state.toast !== null;
  const bottomMode: "pill" | "toast" | null = pillEarlyHide
    ? null
    : recordingActive || (state.main === "error" && !hasToast)
      ? "pill"
      : hasToast
        ? "toast"
        : null;
  // 录音活跃期 + toast：toast 仍叠加在 pill 上方（保留原行为，让用户既能看到
  // 录音波形又能看到提示）。其他时机 toast 进入底部 shell。
  const showToastAbove = recordingActive && hasToast;

  // 不可见时调用 hide。Rust 端 hide 是单 command 串行：先移屏外 → hide，
  // 不会再有 IPC 顺序竞争留下黑条。延迟一帧让 motion exit 跑完再 hide。
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
  // 翻译目标语言徽章已迁出 pill——改用 toast 显示完整"翻译为<目标语言>"，
  // 翻译激活时主窗发持续型 toast，录音结束 dismiss。pill 内宽度让回波形使用，
  // bar count 统一 20 不再按是否翻译模式区分。
  const canFinalize = isRecording || isPreparing;
  // 录音结束后的 transcribing / injecting / translating 同样允许 X 取消：
  // simulateCancel 在这些态走 discardRecording → 丢弃 STT 结果 + 中断后续注入，
  // 用户不会被一段已经反悔的转写强行注入光标。
  const canCancel =
    isRecording ||
    isPreparing ||
    isTranscribing ||
    isInjecting ||
    isTranslating ||
    isError;

  const toastAccent =
    state.toast?.kind === "info"
      ? "border-te-light-gray text-te-fg"
      : "border-te-accent text-te-accent";

  // 中央 AnimatePresence 用 centerKey 切换：同 key 只视作 prop 变化，不会触发动画。
  // transcribing / injecting / translating 共用 "progress" 容器（进度条不重启），
  // 内部的文字标签走另一层 AnimatePresence 单独 crossfade。
  // 注意：模式切换不抢 pill 中心——会让录音波形断一拍。过渡文字渲染在
  // translate indicator 框内（见下方 indicator 块），pill 中心保持 wave 连续。
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
      // 容器拦掉 pointer-events——固定窗口尺寸 130px 后，pill 上方约 94px 是
      // 透明的，整个容器若仍接收事件会吞掉用户点击下方 app 的鼠标。子元素
      // （pill / toast / debug strip）显式开 pointer-events-auto 接受交互。
      // pb-px：Windows 在 125% / 150% 等非整数 DPI 下，pill 的 1px 底边框若压在
      // webview 最后一行像素上会被 DWM 透明合成 / subpixel rounding 吞掉，肉眼
      // 看不到底边线。抬 1px 让底边框不再贴底，跨平台无感知。
      className="pointer-events-none flex h-screen w-screen flex-col justify-end pb-px"
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
            className="pointer-events-auto mx-auto flex items-center justify-between gap-2 overflow-hidden border border-dashed border-te-accent bg-te-bg px-2 leading-none"
            style={{ width: PILL_WIDTH }}
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

      {/* 上方独立 toast：仅录音活跃期共存——临时通知放在最顶层，最显眼。
          录音波形不被替换，几秒后自动 dismiss。非活跃期 toast 接入底部 shell
          直接替换 pill 形态，不再两个独立元素并发出生灭。 */}
      <AnimatePresence initial={false}>
        {showToastAbove && state.toast && (
          <motion.div
            key={state.toast.id}
            initial={{ opacity: 0, y: 8, height: 0, marginBottom: 0 }}
            animate={{
              opacity: 1,
              y: 0,
              height: TOAST_HEIGHT,
              marginBottom: TOAST_GAP,
            }}
            exit={{ opacity: 0, y: 4, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={cn(
              "pointer-events-auto flex items-center gap-2 overflow-hidden border bg-te-bg px-2.5 py-1.5",
              toastAccent,
            )}
          >
            <AlertTriangle className="size-3.5 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
              <div className="truncate font-mono text-[11px] uppercase tracking-[0.12em]">
                {state.toast.title}
              </div>
              {state.toast.description && (
                <div className="line-clamp-2 font-mono text-[11px] leading-tight text-te-light-gray">
                  {state.toast.description}
                </div>
              )}
            </div>
            {state.toast.action && (
              <button
                type="button"
                onClick={() => runToastAction(state.toast!.action!.key)}
                className={cn(
                  "shrink-0 self-center whitespace-nowrap border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.1em]",
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

      {/* 翻译模式指示条：activeId=translate 录音激活时持续挂在 pill 上方，
          录音流程结束主动收起。同时承载"模式切换过渡文字"——切到听写时 indicator
          先显示"切换为听写模式" 1.8s 再退场；切到翻译时 indicator 先显示
          "切换为翻译模式" 1.8s 再回到稳态"翻译模式 · 英文"。pill 中心保持
          wave 连续，避免录音波形被切换提示打断"断一拍"的体感。 */}
      <AnimatePresence initial={false}>
        {translateIndicatorVisible && (
          <motion.div
            key="translate-indicator"
            initial={{ opacity: 0, y: 6, height: 0, marginBottom: 0 }}
            animate={{
              opacity: 1,
              y: 0,
              height: TRANSLATE_INDICATOR_HEIGHT,
              marginBottom: TOAST_GAP,
            }}
            exit={{ opacity: 0, y: 4, height: 0, marginBottom: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="pointer-events-auto mx-auto flex items-center justify-center gap-1.5 overflow-hidden border border-te-accent bg-te-bg px-2 leading-none"
            style={{ width: PILL_WIDTH }}
          >
            <AnimatePresence mode="wait" initial={false}>
              {state.modeSwitchHint !== null ? (
                <motion.span
                  key={`switch-${state.modeSwitchHint}`}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex items-center gap-1.5"
                >
                  {state.modeSwitchHint === "dictation" ? (
                    <Mic className="size-3 shrink-0 text-te-accent" />
                  ) : (
                    <Languages className="size-3 shrink-0 text-te-accent" />
                  )}
                  <span className="truncate font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent">
                    {t(
                      state.modeSwitchHint === "translate"
                        ? "overlay:mode_switch.to_translate"
                        : "overlay:mode_switch.to_dictation",
                    )}
                  </span>
                </motion.span>
              ) : (
                <motion.span
                  key="steady"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.12 }}
                  className="flex items-center gap-1.5"
                >
                  <Languages className="size-3 shrink-0 text-te-accent" />
                  <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.15em] text-te-light-gray">
                    {t("overlay:translate.mode_label")}
                  </span>
                  <span className="text-[10px] text-te-light-gray">·</span>
                  <span className="truncate font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent">
                    {state.translate.lang}
                  </span>
                </motion.span>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 底部 shell：pill 与 toast 形态共享同一个 motion.div 容器。
          - 形态切换（pill ↔ toast）走内层 AnimatePresence popLayout，crossfade。
          - 容器 layout 让 height 跟随内容（pill 36 ↔ toast 46~54）平滑过渡。
          - 退化为容器自身出生灭只发生在 idle 无 toast → 整窗 visible 切 false 时。 */}
      <AnimatePresence initial={false}>
        {bottomMode && (
          <motion.div
            key="bottom-shell"
            layout
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{
              duration: 0.18,
              ease: [0.16, 1, 0.3, 1],
              layout: { duration: 0.22, ease: [0.16, 1, 0.3, 1] },
            }}
            className="pointer-events-auto w-full"
          >
            <AnimatePresence mode="popLayout" initial={false}>
              {bottomMode === "pill" ? (
                <motion.div
                  key="form-pill"
                  layout
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.14 }}
                  className={cn(
                    "mx-auto flex items-center gap-2 overflow-hidden border px-1.5 transition-colors",
                    isError ? "border-te-accent bg-te-bg" : "border-te-gray bg-te-bg",
                  )}
                  style={{ width: PILL_WIDTH, height: PILL_HEIGHT }}
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
                          <Waveform barCount={20} />
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
              ) : (
                state.toast && (
                  <motion.div
                    key="form-toast"
                    layout
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    transition={{ duration: 0.14 }}
                    className={cn(
                      "flex items-center gap-2 overflow-hidden border bg-te-bg px-2.5 py-1.5",
                      toastAccent,
                    )}
                  >
                    <AlertTriangle className="size-3.5 shrink-0" />
                    <div className="flex min-w-0 flex-1 flex-col justify-center gap-0.5">
                      <div className="truncate font-mono text-[11px] uppercase tracking-[0.12em]">
                        {state.toast.title}
                      </div>
                      {state.toast.description && (
                        <div className="line-clamp-2 font-mono text-[11px] leading-tight text-te-light-gray">
                          {state.toast.description}
                        </div>
                      )}
                    </div>
                    {state.toast.action && (
                      <button
                        type="button"
                        onClick={() => runToastAction(state.toast!.action!.key)}
                        className={cn(
                          "shrink-0 self-center whitespace-nowrap border px-2 py-1 font-mono text-[11px] uppercase tracking-[0.1em]",
                          "hover:bg-te-accent hover:text-te-accent-fg",
                          toastAccent,
                        )}
                      >
                        {state.toast.action.label}
                      </button>
                    )}
                  </motion.div>
                )
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
      )}
    </AnimatePresence>
  );
}
