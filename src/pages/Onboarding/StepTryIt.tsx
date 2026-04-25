import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Check, PartyPopper } from "lucide-react";
import { cn } from "@/lib/utils";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { useHotkeysStore } from "@/stores/hotkeys";
import type { RecordingState } from "@/stores/recording";

// Step 4：纯 mock 的 try-it 体验。点"模拟一次完整流程"按钮 → 时间线驱动状态机：
// idle → preparing → recording (假波形 + 假 partial) → transcribing → injecting → done。
// 用户的真实快捷键暂不接，只为视觉走查 UI。

const FAKE_TRANSCRIPT_SLICES = [
  "今",
  "今天",
  "今天天气",
  "今天天气真好",
  "今天天气真好，",
  "今天天气真好，我打开",
  "今天天气真好，我打开了 OpenSpeech",
  "今天天气真好，我打开了 OpenSpeech 试试看。",
];

function fakeWaveform(seed: number, len = 60): number[] {
  return Array.from({ length: len }, (_, i) => {
    const t = (i + seed) / 7;
    const v = (Math.sin(t) + Math.sin(t * 1.7) + Math.sin(t * 0.4)) / 3;
    return Math.max(0, Math.min(1, 0.45 + v * 0.45));
  });
}

const SILENT_LEVELS = Array.from({ length: 60 }, () => 0);

const CHECKLIST = [
  "按住听写快捷键",
  "对着麦克风说一句话",
  "松开快捷键",
  "看到文字写入下方",
] as const;

export function StepTryIt({
  onBack,
  onComplete,
}: {
  onBack: () => void;
  onComplete: () => void;
}) {
  const binding = useHotkeysStore((s) => s.bindings.dictate_ptt);
  const [state, setState] = useState<RecordingState>("idle");
  const [transcript, setTranscript] = useState("");
  const [stepDone, setStepDone] = useState<boolean[]>([false, false, false, false]);
  const [playing, setPlaying] = useState(false);
  const [waveSeed, setWaveSeed] = useState(0);
  const [textareaContent, setTextareaContent] = useState("");

  // 录音 / preparing 时刷新假波形
  useEffect(() => {
    if (state !== "recording" && state !== "preparing") return;
    const t = window.setInterval(() => setWaveSeed((s) => s + 1), 70);
    return () => window.clearInterval(t);
  }, [state]);

  const audioLevels = useMemo(() => {
    if (state === "recording" || state === "preparing") return fakeWaveform(waveSeed);
    return SILENT_LEVELS;
  }, [state, waveSeed]);

  const runMock = () => {
    if (playing) return;
    setPlaying(true);
    setTranscript("");
    setStepDone([false, false, false, false]);
    setTextareaContent("");

    // step 1: preparing → 200ms
    setState("preparing");
    setStepDone([true, false, false, false]);

    let timeouts: number[] = [];
    const at = (ms: number, fn: () => void) => {
      timeouts.push(window.setTimeout(fn, ms));
    };

    at(220, () => {
      setState("recording");
      setStepDone([true, true, false, false]);
    });

    FAKE_TRANSCRIPT_SLICES.forEach((slice, i) => {
      at(280 + i * 280, () => setTranscript(slice));
    });

    const totalRecMs = 280 + FAKE_TRANSCRIPT_SLICES.length * 280;
    at(totalRecMs + 200, () => {
      setState("transcribing");
      setStepDone([true, true, true, false]);
    });
    at(totalRecMs + 700, () => setState("injecting"));
    at(totalRecMs + 1100, () => {
      setTextareaContent(FAKE_TRANSCRIPT_SLICES[FAKE_TRANSCRIPT_SLICES.length - 1]);
      setState("idle");
      setStepDone([true, true, true, true]);
      setPlaying(false);
    });

    return () => timeouts.forEach((t) => window.clearTimeout(t));
  };

  const completed = stepDone.every(Boolean);

  return (
    <div className="flex h-full w-full flex-col px-8 py-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex w-full max-w-3xl flex-col gap-5"
      >
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
            // step 04 / try it
          </span>
          <h2 className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
            试一次。
          </h2>
          <p className="font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
            按下面的按钮模拟一次完整流程，看看 OpenSpeech 是怎么工作的。<br />
            正式使用时只需按住快捷键说话。
          </p>
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
              checklist
            </span>
            <div className="flex flex-col gap-2 border border-te-gray/60 bg-te-surface p-4">
              {CHECKLIST.map((label, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-center gap-3 transition-colors",
                    stepDone[i] ? "text-te-accent" : "text-te-light-gray",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-5 items-center justify-center border font-mono text-[10px]",
                      stepDone[i]
                        ? "border-te-accent bg-te-accent text-te-accent-fg"
                        : "border-te-gray text-te-light-gray",
                    )}
                  >
                    {stepDone[i] ? <Check className="size-3" /> : i + 1}
                  </span>
                  <span className="font-sans text-xs md:text-sm">{label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
              live preview
            </span>
            <div className="border border-te-gray/60 bg-te-surface p-4">
              <LiveDictationPanel
                state={state}
                mode={binding?.mode ?? "hold"}
                audioLevels={audioLevels}
                liveTranscript={transcript}
              />
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
            目标输入框（注入演示）
          </span>
          <textarea
            value={textareaContent}
            onChange={(e) => setTextareaContent(e.target.value)}
            placeholder="文字会在松开快捷键后自动写到这里…"
            className="min-h-[6rem] resize-none border border-te-gray/60 bg-te-bg p-3 font-sans text-sm leading-relaxed text-te-fg placeholder:text-te-light-gray/60 focus:border-te-accent focus:outline-none"
          />
        </div>

        {completed ? (
          <div className="flex items-center gap-3 border border-te-accent bg-te-accent/5 p-4">
            <PartyPopper className="size-5 shrink-0 text-te-accent" />
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-te-accent">
                你已经上路了
              </span>
              <span className="font-sans text-xs text-te-light-gray">
                正式使用时光标在哪个 App，文字就写到哪个 App。
              </span>
            </div>
          </div>
        ) : null}

        <div className="mt-1 flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
          >
            <ArrowLeft className="size-3" /> 上一步
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={runMock}
              disabled={playing}
              className={cn(
                "inline-flex items-center gap-2 border px-4 py-2 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors",
                playing
                  ? "cursor-not-allowed border-te-gray/40 text-te-light-gray/40"
                  : "border-te-gray text-te-fg hover:border-te-accent hover:text-te-accent",
              )}
            >
              {playing ? "演示中…" : "▶ 模拟一次完整流程"}
            </button>
            <button
              type="button"
              onClick={onComplete}
              className={cn(
                "group inline-flex items-center gap-3 border px-6 py-3 font-mono text-sm font-bold uppercase tracking-[0.2em] transition-colors",
                completed
                  ? "border-te-accent bg-te-accent text-te-accent-fg hover:bg-te-accent/90"
                  : "border-te-gray text-te-fg hover:border-te-accent hover:text-te-accent",
              )}
            >
              <span>{completed ? "完成引导" : "跳过并完成"}</span>
              <Check className="size-4 transition-transform group-hover:translate-x-1" />
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
