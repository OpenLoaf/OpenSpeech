import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { Check, PartyPopper } from "lucide-react";
import { cn } from "@/lib/utils";
import { HotkeyPreview } from "@/components/HotkeyPreview";
import { useRecordingStore, type RecordingState } from "@/stores/recording";

// Step 4：默认订阅真实 useRecordingStore，让用户用真快捷键完整跑一遍流程；
// 不能 / 不愿按真快捷键的用户，点"模拟一次"走纯前端假状态机兜底。
// checklist 4 项基于 state 单调推进（preparing→1、recording 持续≥800ms→2、
// transcribing→3、injecting 走完→4）。


function fakeWaveform(seed: number, len = 60): number[] {
  return Array.from({ length: len }, (_, i) => {
    const t = (i - seed) / 7;
    const v = (Math.sin(t) + Math.sin(t * 1.7) + Math.sin(t * 0.4)) / 3;
    return Math.max(0, Math.min(1, 0.45 + v * 0.45));
  });
}

const SILENT_LEVELS = Array.from({ length: 60 }, () => 0);

type Source = "real" | "mock";

export function StepTryIt({
  onComplete,
}: {
  onComplete: () => void;
}) {
  const { t } = useTranslation();
  // 真实流：订阅 useRecordingStore（与 Home 页面一致）。
  const realState = useRecordingStore((s) => s.state);
  const realLevels = useRecordingStore((s) => s.audioLevels);
  const realTranscript = useRecordingStore((s) => s.liveTranscript);

  // 此步要让用户看到「实时出字」效果，必须走 REALTIME（服务端 VAD + partial 回填）。
  // 用户默认走 UTTERANCE（+ AI 优化），只在松手才出 Final，会让人误以为实时输出坏了。
  // 仅在 Onboarding 这一步内覆盖，组件卸载即恢复用户原始偏好。
  useEffect(() => {
    const setOverride = useRecordingStore.getState().setSegmentModeOverride;
    setOverride("REALTIME");
    return () => setOverride(null);
  }, []);

  const checklist = useMemo(
    () => [
      t("onboarding:try_it.checklist.step1"),
      t("onboarding:try_it.checklist.step2"),
      t("onboarding:try_it.checklist.step3"),
      t("onboarding:try_it.checklist.step4"),
    ],
    [t],
  );

  const fakeTranscriptSlices = useMemo<string[]>(() => {
    const arr = t("onboarding:try_it.mock_slices", { returnObjects: true });
    return Array.isArray(arr) ? (arr as string[]) : [];
  }, [t]);

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
  // 把两者都映射到 60 长度让面板视觉一致。早先把 15 个真值右对齐 + 前面填 0，结果
  // 只有最右边 25% 有波形（用户报告 bug）。改为按比例复制到 60 槽位，让真实波形覆盖整条。
  const audioLevels = useMemo(() => {
    if (source === "mock") {
      return mockState === "recording" || mockState === "preparing"
        ? fakeWaveform(mockSeed)
        : SILENT_LEVELS;
    }
    if (realLevels.length === 0) return SILENT_LEVELS;
    if (realLevels.length >= 60) return realLevels.slice(-60);
    const out: number[] = new Array(60);
    for (let i = 0; i < 60; i++) {
      const srcIdx = Math.floor((i * realLevels.length) / 60);
      out[i] = realLevels[srcIdx]!;
    }
    return out;
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
    fakeTranscriptSlices.forEach((slice, i) => {
      at(280 + i * 280, () => setMockTranscript(slice));
    });
    const totalRecMs = 280 + fakeTranscriptSlices.length * 280;
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
            {t("onboarding:try_it.section_tag")}
          </span>
          <h2 className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
            {t("onboarding:try_it.title")}
          </h2>
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("onboarding:try_it.subhead")}
          </span>
        </div>

        {/* 上：checklist + 实时面板 / 下：目标输入框。所有文字提亮，避免"看不清"。 */}
        <div className="grid flex-1 grid-cols-[minmax(0,0.7fr)_minmax(0,1.3fr)] gap-3">
          <div className="flex flex-col gap-3 border border-te-gray/60 bg-te-surface p-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
              {t("onboarding:try_it.checklist_tag")}
            </span>
            <div className="flex flex-col gap-2.5">
              {checklist.map((label, i) => {
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
                title={t("onboarding:try_it.hotkey_title")}
                hint={t("onboarding:try_it.hotkey_hint")}
                stack
              />
            </div>
          </div>

          {/* 右侧两行：上 = 音频波形，下 = 实时转写文字。grid-rows-[auto_1fr] 让
              转写区独占剩余高度，避免之前下方留白。 */}
          <div className="grid grid-rows-[auto_minmax(0,1fr)] gap-3 border border-te-gray/60 bg-te-surface p-4">
            <TryItAudioRow state={state} audioLevels={audioLevels} />
            <TryItTranscriptRow state={state} transcript={transcript} />
          </div>
        </div>

        {completed ? (
          <div className="flex items-center gap-3 border border-te-accent bg-te-accent/10 p-2.5">
            <PartyPopper className="size-4 shrink-0 text-te-accent" />
            <div className="flex flex-col gap-0.5">
              <span className="font-mono text-xs font-bold uppercase tracking-[0.15em] text-te-accent">
                {t("onboarding:try_it.completed_title")}
              </span>
              <span className="font-sans text-xs text-te-fg/80">
                {t("onboarding:try_it.completed_desc")}
              </span>
            </div>
          </div>
        ) : null}

        <div className="flex items-center justify-end">
          <div className="flex items-center gap-2">
            {progress > 0 ? (
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
              >
                {t("onboarding:try_it.reset")}
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
              {mockActive
                ? t("onboarding:try_it.mock_running")
                : t("onboarding:try_it.mock_run")}
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
              <span>
                {completed
                  ? t("onboarding:try_it.finish")
                  : t("onboarding:try_it.skip_finish")}
              </span>
              <Check className="size-3.5 transition-transform group-hover:translate-x-1" />
            </button>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Step 4 实时面板：上 = 音频波形 / 下 = 实时转写文字                  */
/* ──────────────────────────────────────────────────────────────── */

function statusCopy(
  state: RecordingState,
  t: (k: string) => string,
): { tag: string; primary: string; secondary?: string } {
  switch (state) {
    case "preparing":
      return {
        tag: t("onboarding:try_it.status.ready_tag"),
        primary: t("onboarding:try_it.status.ready_primary"),
        secondary: t("onboarding:try_it.status.ready_secondary"),
      };
    case "recording":
      return {
        tag: t("onboarding:try_it.status.listening_tag"),
        primary: t("onboarding:try_it.status.listening_primary"),
        secondary: t("onboarding:try_it.status.listening_secondary"),
      };
    case "transcribing":
      return {
        tag: t("onboarding:try_it.status.transcribing_tag"),
        primary: t("onboarding:try_it.status.transcribing_primary"),
        secondary: t("onboarding:try_it.status.transcribing_secondary"),
      };
    case "injecting":
      return {
        tag: t("onboarding:try_it.status.injecting_tag"),
        primary: t("onboarding:try_it.status.injecting_primary"),
      };
    case "error":
      return {
        tag: t("onboarding:try_it.status.error_tag"),
        primary: t("onboarding:try_it.status.error_primary"),
      };
    default:
      return { tag: t("onboarding:try_it.status.idle_tag"), primary: "" };
  }
}

function TryItAudioRow({
  state,
  audioLevels,
}: {
  state: RecordingState;
  audioLevels: number[];
}) {
  const { t } = useTranslation();
  const { tag } = statusCopy(state, t);
  const active = state === "preparing" || state === "recording";
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-widest text-te-accent",
            active && "animate-[pulse_1.2s_ease-in-out_infinite]",
          )}
        >
          {tag}
        </span>
        <span className="font-mono text-[9px] uppercase tracking-widest text-te-light-gray">
          {t("onboarding:try_it.samples_label", { count: audioLevels.length })}
        </span>
      </div>
      <div className="flex h-14 w-full items-center gap-[2px]">
        {audioLevels.map((v, i) => {
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
    </div>
  );
}

function TryItTranscriptRow({
  state,
  transcript,
}: {
  state: RecordingState;
  transcript: string;
}) {
  const { t } = useTranslation();
  const { primary, secondary } = statusCopy(state, t);
  const hasText = transcript.trim().length > 0;
  const tone =
    state === "recording" || state === "preparing"
      ? "text-te-accent"
      : "text-te-fg";
  return (
    <div className="flex min-h-0 flex-col justify-between gap-2 border-t border-te-gray/40 pt-2">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
          {t("onboarding:try_it.live_transcript_tag")}
        </span>
        <span className="font-mono text-[9px] text-te-light-gray">
          {hasText
            ? t("onboarding:try_it.transcript_chars", { count: transcript.length })
            : "—"}
        </span>
      </div>
      <p
        className={cn(
          "min-h-0 flex-1 overflow-y-auto font-sans text-sm leading-relaxed",
          hasText ? tone : "text-te-fg/40",
        )}
      >
        {hasText ? transcript : t("onboarding:try_it.transcript_placeholder")}
      </p>
      <div className="flex flex-col gap-0.5">
        {primary ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent">
            {primary}
          </span>
        ) : null}
        {secondary ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
            {secondary}
          </span>
        ) : null}
      </div>
    </div>
  );
}
