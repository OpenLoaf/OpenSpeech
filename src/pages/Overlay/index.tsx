import { useEffect } from "react";
import { motion } from "framer-motion";
import { Check, Loader2, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { emitTo } from "@tauri-apps/api/event";
import { cn } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording";

// 独立 WebviewWindow（label=overlay），240×36 logical px。布局：× | 波形 | ✓。
// 波形 bar 的高度由真实麦克风电平驱动 —— audio-level 事件 @ 20Hz 喂进
// recording store 的 audioLevels ring buffer。

// 幅度映射：gamma 0.5（Math.sqrt）放大低音量 + 线性增益 1.5。小声说话也能看出
// 明显起伏，大声说话直接顶满。
const BAR_MIN_H = 3;
const BAR_MAX_H = 26;
const VISUAL_GAIN = 1.5;

function Waveform({ levels }: { levels: number[] }) {
  return (
    <div className="flex h-full items-center gap-[2px]">
      {levels.map((lvl, i) => {
        const boosted = Math.min(1, Math.sqrt(Math.max(0, lvl)) * VISUAL_GAIN);
        const h = BAR_MIN_H + boosted * (BAR_MAX_H - BAR_MIN_H);
        return (
          <motion.span
            key={i}
            className="inline-block w-[3px] bg-te-fg"
            animate={{ height: h }}
            transition={{ duration: 0.08, ease: "easeOut" }}
          />
        );
      })}
    </div>
  );
}

export default function OverlayPage() {
  const state = useRecordingStore((s) => s.state);
  const audioLevels = useRecordingStore((s) => s.audioLevels);
  const errorMessage = useRecordingStore((s) => s.errorMessage);

  // overlay 是镜像窗口：按钮交互只能通过 emitTo 发回主窗，主窗 listener 调
  // 真实的 simulateCancel / simulateFinalize（那里才有 Rust 录音 / STT 副作用）。
  const cancel = () => {
    void emitTo("main", "openspeech://overlay-action", "cancel");
  };
  const finalize = () => {
    void emitTo("main", "openspeech://overlay-action", "finalize");
  };

  // initListeners 已在 main.tsx 的 boot IIFE 中完成，组件只负责订阅 + 渲染。

  useEffect(() => {
    if (state === "idle") {
      invoke("overlay_hide").catch((e) => console.warn("[overlay] hide failed", e));
    }
  }, [state]);

  const isRecording = state === "recording";
  const isPreparing = state === "preparing";
  const isTranscribing = state === "transcribing";
  const isInjecting = state === "injecting";
  const isError = state === "error";
  const canFinalize = isRecording || isPreparing;
  const canCancel = isRecording || isPreparing || isError;

  return (
    <div
      className={cn(
        "flex h-screen w-screen items-center gap-2 border px-1.5",
        isError ? "border-te-accent bg-te-bg" : "border-te-gray bg-te-bg",
      )}
    >
      <button
        type="button"
        onClick={cancel}
        disabled={!canCancel}
        className={cn(
          "flex size-6 shrink-0 items-center justify-center border transition-colors",
          canCancel
            ? "border-te-gray text-te-fg hover:border-te-accent hover:text-te-accent"
            : "border-te-gray/40 text-te-light-gray/40",
        )}
        aria-label="取消"
      >
        <X className="size-3" />
      </button>

      <div className="flex min-w-0 flex-1 items-center justify-center">
        {isTranscribing && (
          <Loader2 className="size-3.5 text-te-accent animate-spin" />
        )}
        {isInjecting && <Check className="size-3.5 text-te-accent" />}
        {isError && (
          <span className="truncate px-1 font-mono text-[10px] uppercase tracking-[0.15em] text-te-accent">
            {errorMessage ?? "ERROR"}
          </span>
        )}
        {(isRecording || isPreparing) && <Waveform levels={audioLevels} />}
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
        aria-label="确定"
      >
        <Check className="size-3" />
      </button>
    </div>
  );
}
