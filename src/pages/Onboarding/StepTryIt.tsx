import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, Check, PartyPopper } from "lucide-react";
import { cn } from "@/lib/utils";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { HotkeyPreview } from "@/components/HotkeyPreview";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useRecordingStore, type RecordingState } from "@/stores/recording";

// Step 4：默认订阅真实 useRecordingStore，让用户用真快捷键完整跑一遍流程；
// 不能 / 不愿按真快捷键的用户，点"模拟一次"走纯前端假状态机兜底。
// checklist 4 项基于 state 单调推进（preparing→1、recording 持续≥800ms→2、
// transcribing→3、injecting 走完→4）。

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

type Source = "real" | "mock";

export function StepTryIt({
  onBack,
  onComplete,
}: {
  onBack: () => void;
  onComplete: () => void;
}) {
  const binding = useHotkeysStore((s) => s.bindings.dictate_ptt);

  // 真实流：订阅 useRecordingStore（与 Home 页面一致）。
  const realState = useRecordingStore((s) => s.state);
  const realLevels = useRecordingStore((s) => s.audioLevels);
  const realTranscript = useRecordingStore((s) => s.liveTranscript);

  // 模拟流：本地状态机，仅在用户点"模拟一次"时驱动显示。
  const [mockActive, setMockActive] = useState(false);
  const [mockState, setMockState] = useState<RecordingState>("idle");
  const [mockTranscript, setMockTranscript] = useState("");
  const [mockSeed, setMockSeed] = useState(0);

  // 当前展示来源：mock 跑完前完全接管，跑完后回到 real。
  const source: Source = mockActive ? "mock" : "real";
  const state = source === "mock" ? mockState : realState;
  const transcript = source === "mock" ? mockTranscript : realTranscript;

  // 真流的波形是 LEVEL_BUFFER_LEN=15（recording store 里），mock 用 60 直接驱动 fakeWaveform。
  // 把两者都映射到 60 长度让 LiveDictationPanel 视觉一致。
  const audioLevels = useMemo(() => {
    if (source === "mock") {
      return mockState === "recording" || mockState === "preparing"
        ? fakeWaveform(mockSeed)
        : SILENT_LEVELS;
    }
    // real：把 15 长度的 buffer pad 成 60，避免突然变窄/宽
    if (realLevels.length >= 60) return realLevels.slice(-60);
    const padLen = 60 - realLevels.length;
    return [...Array(padLen).fill(0), ...realLevels];
  }, [source, mockState, mockSeed, realLevels]);

  // mock 录音时刷新假波形
  useEffect(() => {
    if (source !== "mock") return;
    if (mockState !== "recording" && mockState !== "preparing") return;
    const t = window.setInterval(() => setMockSeed((s) => s + 1), 70);
    return () => window.clearInterval(t);
  }, [source, mockState]);

  // checklist 单调推进。state 进入对应阶段后 lock，避免回到 idle 时被回吐。
  const [progress, setProgress] = useState(0);
  const recordingStartedAtRef = useRef<number | null>(null);

  useEffect(() => {
    setProgress((cur) => {
      let next = cur;
      if (state === "preparing" || state === "recording") {
        next = Math.max(next, 1);
        if (state === "recording" && recordingStartedAtRef.current == null) {
          recordingStartedAtRef.current = performance.now();
        }
      }
      if (
        state === "recording" &&
        recordingStartedAtRef.current != null &&
        performance.now() - recordingStartedAtRef.current >= 800
      ) {
        next = Math.max(next, 2);
      }
      if (state === "transcribing") {
        next = Math.max(next, 2, 3);
      }
      if (state === "injecting") {
        next = Math.max(next, 3);
      }
      // 注入完成：injecting → idle 时锁第 4 项
      if (state === "idle" && cur >= 3) {
        next = Math.max(next, 4);
      }
      return next;
    });
    if (state === "idle" && recordingStartedAtRef.current != null) {
      recordingStartedAtRef.current = null;
    }
  }, [state, transcript]);

  // recording 持续到 800ms 时补刷一次进度（useEffect 触发条件不会因时间流逝重新跑）
  useEffect(() => {
    if (state !== "recording") return;
    const t = window.setTimeout(() => {
      setProgress((cur) => Math.max(cur, 2));
    }, 800);
    return () => window.clearTimeout(t);
  }, [state]);

  const stepDone = useMemo(
    () => [progress >= 1, progress >= 2, progress >= 3, progress >= 4] as const,
    [progress],
  );
  const completed = stepDone.every(Boolean);

  // mock 跑完一次完整流程
  const runMock = () => {
    if (mockActive) return;
    setProgress(0);
    recordingStartedAtRef.current = null;
    setMockActive(true);
    setMockState("preparing");
    setMockTranscript("");

    const timeouts: number[] = [];
    const at = (ms: number, fn: () => void) => {
      timeouts.push(window.setTimeout(fn, ms));
    };

    at(220, () => setMockState("recording"));
    FAKE_TRANSCRIPT_SLICES.forEach((slice, i) => {
      at(280 + i * 280, () => setMockTranscript(slice));
    });
    const totalRecMs = 280 + FAKE_TRANSCRIPT_SLICES.length * 280;
    at(totalRecMs + 200, () => setMockState("transcribing"));
    at(totalRecMs + 700, () => setMockState("injecting"));
    at(totalRecMs + 1100, () => {
      setMockState("idle");
      setMockActive(false);
    });
  };

  const reset = () => {
    setProgress(0);
    recordingStartedAtRef.current = null;
    setMockTranscript("");
    setMockState("idle");
    setMockActive(false);
  };

  return (
    <div className="flex h-full w-full flex-col overflow-hidden px-8 pt-24 pb-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex h-full w-full max-w-3xl flex-col gap-3"
      >
        <div className="flex flex-col gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
            // step 04 / try it
          </span>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
              试一次。
            </h2>
            <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
              按住下方显示的快捷键，说一句话，松开
            </span>
          </div>
        </div>

        {/* 上：checklist + 实时面板 / 下：目标输入框。所有文字提亮，避免"看不清"。 */}
        <div className="grid flex-1 grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] gap-3">
          <div className="flex flex-col gap-3 border border-te-gray/60 bg-te-surface p-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
              // CHECKLIST
            </span>
            <div className="flex flex-col gap-2.5">
              {CHECKLIST.map((label, i) => {
                const done = stepDone[i];
                const active = !done && progress === i;
                return (
                  <div
                    key={i}
                    className={cn(
                      "flex items-center gap-2.5 transition-colors",
                      done
                        ? "text-te-accent"
                        : active
                          ? "text-te-fg"
                          : "text-te-light-gray",
                    )}
                  >
                    <span
                      className={cn(
                        "flex size-5 shrink-0 items-center justify-center border font-mono text-[10px] font-bold",
                        done
                          ? "border-te-accent bg-te-accent text-te-accent-fg"
                          : active
                            ? "border-te-accent text-te-accent"
                            : "border-te-gray text-te-light-gray",
                      )}
                    >
                      {done ? <Check className="size-3" /> : i + 1}
                    </span>
                    <span className="font-sans text-sm">{label}</span>
                  </div>
                );
              })}
            </div>

            <div className="mt-auto border-t border-te-gray/40 pt-3">
              <HotkeyPreview
                index="HOTKEY"
                title="你的听写快捷键"
                hint={
                  binding?.mode === "toggle"
                    ? "单击开始 · 再按结束"
                    : "按住说 · 松开转写"
                }
              />
            </div>
          </div>

          <div className="flex flex-col gap-2 border border-te-gray/60 bg-te-surface p-4">
            <LiveDictationPanel
              state={state}
              mode={binding?.mode ?? "hold"}
              audioLevels={audioLevels}
              liveTranscript={transcript}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
            // 目标输入框（焦点在这里时，松开快捷键文字会自动写入）
          </span>
          <textarea
            placeholder="光标点进来 → 按住快捷键 → 说话 → 松开 → 文字会出现在这里…"
            className="h-[3.75rem] resize-none border border-te-gray/60 bg-te-bg p-2.5 font-sans text-sm leading-relaxed text-te-fg placeholder:text-te-light-gray/70 focus:border-te-accent focus:outline-none"
          />
        </div>

        {completed ? (
          <div className="flex items-center gap-3 border border-te-accent bg-te-accent/10 p-2.5">
            <PartyPopper className="size-4 shrink-0 text-te-accent" />
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-te-accent">
                配置完成，可以开始使用了
              </span>
              <span className="font-sans text-xs text-te-fg/80">
                正式使用时光标在哪个 App，文字就写到哪个 App。
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
          >
            <ArrowLeft className="size-3" /> 上一步
          </button>

          <div className="flex items-center gap-2">
            {progress > 0 ? (
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
              >
                重置
              </button>
            ) : null}
            <button
              type="button"
              onClick={runMock}
              disabled={mockActive}
              className={cn(
                "inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] transition-colors",
                mockActive
                  ? "cursor-not-allowed border-te-gray/40 text-te-light-gray/40"
                  : "border-te-gray text-te-fg hover:border-te-accent hover:text-te-accent",
              )}
            >
              {mockActive ? "演示中…" : "▶ 模拟一次"}
            </button>
            <button
              type="button"
              onClick={onComplete}
              className={cn(
                "group inline-flex items-center gap-2 border px-4 py-2 font-mono text-xs font-bold uppercase tracking-[0.2em] transition-colors",
                completed
                  ? "border-te-accent bg-te-accent text-te-accent-fg hover:bg-te-accent/90"
                  : "border-te-gray text-te-fg hover:border-te-accent hover:text-te-accent",
              )}
            >
              <span>{completed ? "完成引导" : "跳过并完成"}</span>
              <Check className="size-3.5 transition-transform group-hover:translate-x-1" />
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
