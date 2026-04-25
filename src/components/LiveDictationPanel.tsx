import { cn } from "@/lib/utils";
import type { RecordingState } from "@/stores/recording";
import type { HotkeyMode } from "@/lib/hotkey";

// 实时听写面板：左波形 + 右 realtime 转写 + 状态文案。Home 与 Onboarding Try-It 共用。
// audioLevels / liveTranscript 由调用方注入（通常来自 useRecordingStore）。

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
  mode: HotkeyMode,
): { tag: string; primary: string; secondary?: string } {
  switch (state) {
    case "preparing":
      return {
        tag: "// READY",
        primary: mode === "hold" ? "继续按住，开始说话…" : "开始说话…",
        secondary: "Esc 取消",
      };
    case "recording":
      return {
        tag: "// LISTENING",
        primary:
          mode === "hold"
            ? "松开快捷键 结束并转写"
            : "再按一次快捷键 结束并转写",
        secondary: "Esc 取消本次录音",
      };
    case "transcribing":
      return {
        tag: "// TRANSCRIBING",
        primary: "正在转写…",
        secondary: "Esc 放弃这次结果",
      };
    case "injecting":
      return { tag: "// INJECTING", primary: "正在写入输入框…" };
    case "error":
      return { tag: "// ERROR", primary: "出错了，检查日志或重试" };
    default:
      return { tag: "// IDLE", primary: "" };
  }
}

export function LiveDictationPanel({
  state,
  mode,
  audioLevels,
  liveTranscript,
}: {
  state: RecordingState;
  mode: HotkeyMode;
  audioLevels: number[];
  liveTranscript: string;
}) {
  const { tag, primary, secondary } = statusCopy(state, mode);
  const waveActive = state === "preparing" || state === "recording";
  const hasText = liveTranscript.trim().length > 0;
  const textToneClass =
    state === "recording" || state === "preparing"
      ? "text-te-accent"
      : "text-te-fg";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-start justify-between">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-widest md:text-xs",
            "text-te-accent",
            waveActive && "animate-[pulse_1.2s_ease-in-out_infinite]",
          )}
        >
          {tag}
        </span>
        <span className="font-mono text-[10px] text-te-light-gray md:text-xs">
          {hasText ? `${liveTranscript.length} CHARS` : "LIVE"}
        </span>
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
            {hasText ? liveTranscript : "实时转写文字将出现在这里…"}
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
