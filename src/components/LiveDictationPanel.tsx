import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { RecordingState } from "@/stores/recording";
import type { TFunction } from "i18next";

// 实时听写面板：左波形 + 右 realtime 转写 + 状态文案。Home 与 Onboarding Try-It 共用。
// audioLevels / liveTranscript 由调用方注入（通常来自 useRecordingStore）。
// 全系统 toggle 语义：按一下开始、再按一下结束（不再有 hold / 长按模式）。
// 调用方传 onClose 进入"结果模式"：录音结束后挂留最近一次转写结果，等用户点 ✕ 或再次按快捷键。

function Waveform({
  levels,
  active,
}: {
  levels: number[];
  active: boolean;
}) {
  return (
    <div className="flex h-16 w-full items-center gap-[2px]">
      {levels.map((v, i) => {
        const height = Math.max(8, Math.min(100, Math.pow(v, 0.55) * 110));
        return (
          <div
            key={i}
            className={cn(
              "flex-1 rounded-[1px] transition-[height] duration-75 ease-out",
              active ? "bg-te-accent" : "bg-te-gray/60",
            )}
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
  onClose,
}: {
  state: RecordingState;
  audioLevels: number[];
  liveTranscript: string;
  onClose?: () => void;
}) {
  const { t } = useTranslation();
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

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-3">
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
          <span className="font-mono text-[10px] text-te-light-gray md:text-xs">
            {hasText ? `${liveTranscript.length} CHARS` : "LIVE"}
          </span>
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

      <div className="grid grid-cols-[minmax(0,40%)_minmax(0,1fr)] gap-4 md:gap-6">
        <div className="flex flex-col gap-2">
          <Waveform levels={audioLevels} active={waveActive} />
          <span className="font-mono text-[9px] uppercase tracking-widest text-te-light-gray md:text-[10px]">
            AUDIO · {audioLevels.length} SAMPLES
          </span>
        </div>

        <div className="flex min-h-[4rem] flex-col justify-between border-l border-te-gray/40 pl-4 md:pl-6">
          <p
            className={cn(
              "font-sans text-xs leading-relaxed md:text-sm",
              "max-h-24 overflow-y-auto",
              hasText ? textToneClass : "text-te-fg/40",
            )}
          >
            {hasText ? liveTranscript : t("overlay:panel.placeholder")}
          </p>
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
        </div>
      </div>
    </div>
  );
}
