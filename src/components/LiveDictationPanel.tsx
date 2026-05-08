import { Fragment, type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardCopy, Check, Pencil, Sparkles, Languages } from "lucide-react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Kbd, tokensFromBinding } from "@/components/HotkeyPreview";
import { useHotkeysStore } from "@/stores/hotkeys";
import { detectPlatform } from "@/lib/platform";
import type { RecordingState } from "@/stores/recording";
import type { AsrSegmentMode } from "@/stores/settings";
import type { BindingId } from "@/lib/hotkey";
import type { TFunction } from "i18next";

function formatMmSs(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// result 模式底部耗时显示：< 1s 走 "320 ms"，≥ 1s 走 "1.4 s"。
function formatLatency(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export interface ResultStats {
  audioMs?: number | null;
  asrMs?: number | null;
  refineMs?: number | null;
}

export interface ResultParts {
  raw: string;
  translated: string;
  targetLang?: string | null;
}

// 实时听写面板：录音中顶部加波形条 + 主区（计时器 / partial 流）；
// 非录音状态（转写、注入、result）只渲染主区。Home 页 HotkeyDictationCard 使用。
// 全系统 toggle 语义：按一下开始、再按一下结束。
// 调用方传 onClose 进入"结果模式"：录音结束后挂留最近一次转写结果。

function Waveform({ levels }: { levels: number[] }) {
  return (
    <div className="flex h-16 w-full items-center gap-[2px] md:h-20">
      {levels.map((v, i) => {
        const height = Math.max(8, Math.min(100, Math.pow(v, 0.55) * 110));
        return (
          <div
            key={i}
            className="flex-1 rounded-[1px] bg-te-accent transition-[height] duration-75 ease-out"
            style={{ height: `${height}%` }}
          />
        );
      })}
    </div>
  );
}

function statusCopy(
  state: RecordingState,
  t: TFunction,
): { tag: string; primary: string; secondary?: string } {
  switch (state) {
    case "preparing":
      return {
        tag: "// READY",
        primary: t("overlay:panel.primary.ready"),
        secondary: t("overlay:panel.secondary.ready"),
      };
    case "recording":
      return {
        tag: "// LISTENING",
        primary: t("overlay:panel.primary.listening"),
        secondary: t("overlay:panel.secondary.listening"),
      };
    case "transcribing":
      return {
        tag: "// TRANSCRIBING",
        primary: t("overlay:panel.primary.transcribing"),
        secondary: t("overlay:panel.secondary.transcribing"),
      };
    case "injecting":
      return { tag: "// INJECTING", primary: t("overlay:panel.primary.injecting") };
    case "error":
      return { tag: "// ERROR", primary: t("overlay:panel.primary.error") };
    default:
      return { tag: "// IDLE", primary: "" };
  }
}

export function LiveDictationPanel({
  state,
  audioLevels,
  liveTranscript,
  segmentMode,
  escArmed,
  activeBindingId,
  resultStats,
  resultParts,
  errorMessage,
  onClose,
  onCopy,
  onEdit,
  onRefine,
  refineBusy = false,
  refineSlot,
  translateSlot,
  stack = false,
  hideActions = false,
}: {
  state: RecordingState;
  audioLevels: number[];
  liveTranscript: string;
  segmentMode: AsrSegmentMode;
  escArmed: boolean;
  activeBindingId: BindingId | null;
  resultStats?: ResultStats | null;
  resultParts?: ResultParts | null;
  errorMessage?: string | null;
  onClose?: () => void;
  /** Result 模式下 stats 行右侧的复制按钮回调；不传则不展示按钮。 */
  onCopy?: () => void | Promise<void>;
  /** Result 模式下"修改"按钮回调；点击后调用方负责弹历史编辑对话框。 */
  onEdit?: () => void;
  /** Result 模式下点"润色"触发；不传按钮显示为 disabled // SOON 占位。 */
  onRefine?: () => void;
  /** 润色流式期间禁用按钮 + 显示"润色中…"。 */
  refineBusy?: boolean;
  /** 替换默认润色按钮的整块 slot（HotkeyDictationCard 用它装"按钮 + 场景下拉"组）。 */
  refineSlot?: ReactNode;
  /** 替换默认翻译按钮的整块 slot（语言下拉）。 */
  translateSlot?: ReactNode;
  /** 窄容器（toolbox 输入区）走纵向布局：波形在上、计时器在下、底部按钮分两行。 */
  stack?: boolean;
  /** 隐藏底部按钮区（toolbox 把停止 / 取消快捷键挪到 OutputCard 时用）。 */
  hideActions?: boolean;
}) {
  const { t } = useTranslation();
  const isTranslate = activeBindingId === "translate";
  // 录音中显示的快捷键 = 当前进入此次录音的 binding；idle 兜底用 dictate_ptt
  // 让结果模式的占位也能渲染默认 token 序列（实际此时不展示底部行）。
  const activeKey: BindingId = isTranslate ? "translate" : "dictate_ptt";
  const activeBinding = useHotkeysStore((s) => s.bindings[activeKey]);
  const platform = detectPlatform();
  const activeTokens = useMemo(
    () => tokensFromBinding(activeBinding, platform),
    [activeBinding, platform],
  );
  const isResultMode = !!onClose && state === "idle";
  const { tag, primary, secondary } = isResultMode
    ? {
        tag: "// RESULT",
        primary: t("overlay:panel.primary.result"),
        secondary: t("overlay:panel.secondary.result"),
      }
    : statusCopy(state, t);
  const waveActive = !isResultMode && (state === "preparing" || state === "recording");
  const hasText = liveTranscript.trim().length > 0;
  const textToneClass =
    state === "recording" || state === "preparing"
      ? "text-te-accent"
      : "text-te-fg";
  // UTTERANCE 录音中没有 partial，文字区一直空着没意义——整块替换成大计时器。
  // 转写/注入阶段又会有 refine 流式 token 落进来，所以只在 waveActive 时切。
  const showBigTimer = segmentMode === "UTTERANCE" && waveActive;
  const showCornerTimer = segmentMode === "REALTIME" && waveActive;

  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!waveActive) {
      setElapsedMs(0);
      return;
    }
    const startedAt = performance.now();
    setElapsedMs(0);
    const id = window.setInterval(() => {
      setElapsedMs(performance.now() - startedAt);
    }, 250);
    return () => window.clearInterval(id);
  }, [waveActive]);

  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(id);
  }, [copied]);
  const handleCopy = useCallback(async () => {
    if (!onCopy) return;
    try {
      await onCopy();
      setCopied(true);
    } catch {}
  }, [onCopy]);

  const responseMs =
    resultStats?.asrMs != null
      ? (resultStats.asrMs ?? 0) + (resultStats.refineMs ?? 0)
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-start justify-between gap-3">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-widest md:text-xs",
            "text-te-accent",
            waveActive && "animate-[pulse_1.2s_ease-in-out_infinite]",
          )}
        >
          {tag}
        </span>
        <div className="flex items-center gap-2">
          {waveActive ? (
            <>
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
                {t(
                  isTranslate
                    ? "overlay:panel.mode_action.translate"
                    : "overlay:panel.mode_action.dictate",
                )}
                {" · "}
                {t(
                  segmentMode === "UTTERANCE"
                    ? "overlay:panel.mode_segment.utterance"
                    : "overlay:panel.mode_segment.realtime",
                )}
              </span>
              {showCornerTimer ? (
                <span className="font-mono text-[10px] tabular-nums text-te-light-gray md:text-xs">
                  {formatMmSs(elapsedMs)}
                </span>
              ) : null}
            </>
          ) : isResultMode && resultStats ? (
            <>
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
                <span className="text-te-fg/60">
                  {t("overlay:panel.result_stats.recording")}{" "}
                </span>
                <span className="text-te-accent tabular-nums">
                  {formatLatency(resultStats.audioMs)}
                </span>
              </span>
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
                <span className="text-te-fg/60">
                  {t("overlay:panel.result_stats.response")}{" "}
                </span>
                <span className="text-te-accent tabular-nums">
                  {formatLatency(responseMs)}
                </span>
              </span>
            </>
          ) : (
            <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
              {hasText ? `${liveTranscript.length} CHARS` : "LIVE"}
            </span>
          )}
          {isResultMode ? (
            <button
              type="button"
              onClick={onClose}
              aria-label={t("overlay:aria.close_result")}
              className="grid size-5 place-items-center border border-te-gray/60 text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
            >
              <X className="size-3" />
            </button>
          ) : null}
        </div>
      </div>

      {waveActive ? (
        stack ? (
          <div className="flex min-h-0 flex-1 flex-col items-stretch justify-center gap-4">
            <Waveform levels={audioLevels} />
            {showBigTimer ? (
              <span className="self-center font-mono text-5xl font-bold tabular-nums tracking-tighter text-te-accent md:text-6xl">
                {formatMmSs(elapsedMs)}
              </span>
            ) : (
              <p
                className={cn(
                  "min-h-0 max-h-full w-full font-sans text-sm leading-relaxed md:text-base",
                  "overflow-y-auto",
                  hasText ? textToneClass : "text-te-fg/40",
                )}
              >
                {hasText ? liveTranscript : t("overlay:panel.placeholder")}
              </p>
            )}
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,65%)_minmax(0,1fr)] items-center gap-4 md:gap-5">
            <Waveform levels={audioLevels} />
            <div className="flex min-h-0 flex-col items-end justify-center">
              {showBigTimer ? (
                <span className="font-mono text-5xl font-bold tabular-nums tracking-tighter text-te-accent md:text-6xl">
                  {formatMmSs(elapsedMs)}
                </span>
              ) : (
                <p
                  className={cn(
                    "min-h-0 max-h-full w-full text-right font-sans text-sm leading-relaxed md:text-base",
                    "overflow-y-auto",
                    hasText ? textToneClass : "text-te-fg/40",
                  )}
                >
                  {hasText ? liveTranscript : t("overlay:panel.placeholder")}
                </p>
              )}
            </div>
          </div>
        )
      ) : isResultMode && resultParts ? (
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto">
          <div className="flex shrink-0 flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
              {t("overlay:panel.result_label.original")}
            </span>
            <p className="font-sans text-sm leading-relaxed text-te-fg/80 md:text-base">
              {resultParts.raw || t("overlay:transcript.placeholder")}
            </p>
          </div>
          <div className="flex shrink-0 flex-col gap-1 border-t border-te-gray/40 pt-3">
            <span className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
              {t("overlay:panel.result_label.translation")}
              {resultParts.targetLang ? (
                <span className="text-te-light-gray">
                  {t(`overlay:translate.lang.${resultParts.targetLang}`, {
                    defaultValue: resultParts.targetLang,
                  })}
                </span>
              ) : null}
            </span>
            <p className="font-sans text-sm leading-relaxed text-te-fg md:text-base">
              {resultParts.translated || t("overlay:transcript.placeholder")}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col justify-center">
          <p
            className={cn(
              "min-h-0 max-h-full w-full font-sans text-sm leading-relaxed md:text-base",
              "overflow-y-auto",
              state === "error"
                ? "text-te-accent"
                : hasText
                  ? textToneClass
                  : "text-te-fg/40",
            )}
          >
            {state === "error"
              ? errorMessage || t("overlay:panel.primary.error")
              : hasText
                ? liveTranscript
                : t("overlay:panel.placeholder")}
          </p>
        </div>
      )}

      <div
        className={cn(
          "flex shrink-0 gap-x-4 gap-y-2",
          stack
            ? "flex-col items-start"
            : "flex-wrap items-center gap-y-1.5",
          isResultMode && "border-t border-te-gray/40 pt-3",
          hideActions && "hidden",
        )}
      >
        {isResultMode && resultStats ? (
          <div className="flex w-full flex-wrap items-center gap-2">
            {refineSlot ? (
              refineSlot
            ) : onRefine ? (
              <button
                type="button"
                onClick={onRefine}
                disabled={refineBusy}
                aria-label={t("overlay:panel.action.refine")}
                className={cn(
                  "inline-flex items-center gap-2 border px-3 py-2 font-mono text-xs uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-te-accent",
                  refineBusy
                    ? "border-te-accent/60 bg-te-surface text-te-accent animate-pulse"
                    : "border-te-accent/70 bg-te-surface text-te-accent hover:bg-te-accent hover:text-te-bg",
                )}
              >
                <Sparkles className="size-3.5" aria-hidden />
                {refineBusy
                  ? t("overlay:panel.action.refining")
                  : t("overlay:panel.action.refine")}
              </button>
            ) : (
              <button
                type="button"
                disabled
                aria-label={t("overlay:panel.action.refine")}
                title={t("overlay:panel.coming_soon")}
                className="inline-flex items-center gap-2 border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-xs uppercase tracking-widest text-te-light-gray/70 opacity-60"
              >
                <Sparkles className="size-3.5" aria-hidden />
                {t("overlay:panel.action.refine")}
                <span className="ml-1 text-[9px] tracking-widest text-te-light-gray/60">
                  {t("overlay:panel.coming_soon_tag")}
                </span>
              </button>
            )}
            {translateSlot ?? (
              <button
                type="button"
                disabled
                aria-label={t("overlay:panel.action.translate")}
                title={t("overlay:panel.coming_soon")}
                className="inline-flex items-center gap-2 border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-xs uppercase tracking-widest text-te-light-gray/70 opacity-60"
              >
                <Languages className="size-3.5" aria-hidden />
                {t("overlay:panel.action.translate")}
                <span className="ml-1 text-[9px] tracking-widest text-te-light-gray/60">
                  {t("overlay:panel.coming_soon_tag")}
                </span>
              </button>
            )}
            {onEdit ? (
              <button
                type="button"
                onClick={onEdit}
                aria-label={t("overlay:panel.action.edit")}
                className="ml-auto inline-flex items-center gap-2 border border-te-gray/60 bg-te-surface px-3 py-2 font-mono text-xs uppercase tracking-widest text-te-light-gray transition-colors hover:border-te-fg hover:text-te-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-te-accent"
              >
                <Pencil className="size-3.5" aria-hidden />
                {t("overlay:panel.action.edit")}
              </button>
            ) : null}
            {onCopy ? (
              <button
                type="button"
                onClick={handleCopy}
                aria-label={t("overlay:panel.action.copy")}
                className={cn(
                  "inline-flex items-center gap-2 border px-4 py-2 font-mono text-xs uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-te-accent",
                  !onEdit && "ml-auto",
                  copied
                    ? "border-te-accent bg-te-accent text-te-bg"
                    : "border-te-accent text-te-accent hover:bg-te-accent hover:text-te-bg",
                )}
              >
                {copied ? (
                  <Check className="size-3.5" aria-hidden />
                ) : (
                  <ClipboardCopy className="size-3.5" aria-hidden />
                )}
                {copied
                  ? t("overlay:panel.action.copied")
                  : t("overlay:panel.action.copy")}
              </button>
            ) : null}
          </div>
        ) : state === "error" ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
            {t("overlay:panel.action.retry_hint")}
          </span>
        ) : waveActive ? (
          <>
            <div className="flex items-center gap-1.5">
              {activeTokens.map((tok, i) => (
                <Fragment key={i}>
                  {i > 0 && (
                    <span className="font-mono text-[10px] text-te-light-gray">
                      +
                    </span>
                  )}
                  <Kbd highlight>
                    {tok.kind !== "prefix" && tok.icon ? (
                      <span aria-hidden className="mr-1 opacity-60">
                        {tok.icon}
                      </span>
                    ) : null}
                    {tok.label}
                  </Kbd>
                </Fragment>
              ))}
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
                {t(
                  isTranslate
                    ? "overlay:panel.action.stop_translate"
                    : "overlay:panel.action.stop",
                )}
              </span>
            </div>
            <div
              className={cn(
                "flex items-center gap-1.5",
                !stack && "ml-auto",
                escArmed && "animate-pulse",
              )}
            >
              <Kbd highlight={escArmed}>
                {t("overlay:panel.action.kbd_esc")}
              </Kbd>
              <span
                className={cn(
                  "font-mono text-[10px] uppercase tracking-widest",
                  escArmed ? "text-te-accent" : "text-te-light-gray",
                )}
              >
                {escArmed
                  ? t("overlay:toast.esc_arm.title")
                  : t("overlay:panel.action.cancel")}
              </span>
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
              {primary}
            </span>
            {secondary ? (
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                {secondary}
              </span>
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}
