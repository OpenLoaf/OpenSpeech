import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  ArrowLeft,
  Download,
  Pause,
  Play,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { cn } from "../lib/cn";

/**
 * src/pages/Meetings/index.tsx 的 LiveView + ReviewView 视觉克隆。
 * className / DOM 与真实组件一致；audio-level 事件订阅替换为本地 RAF mock；
 * segments / summary 由本地驱动；不依赖 i18n / store / Tauri。
 */

const SPEAKER_COLORS = [
  "text-te-accent",
  "text-emerald-400",
  "text-sky-400",
  "text-violet-400",
  "text-rose-400",
  "text-amber-400",
];

function speakerColor(speakerId: number): string {
  if (speakerId < 0) return "text-te-light-gray";
  return SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length];
}

function formatHMS(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function SpeakerLabel({ speakerId }: { speakerId: number }) {
  const text =
    speakerId < 0
      ? "待识别"
      : `说话人 ${String.fromCharCode(65 + (speakerId % 26))}`;
  return (
    <span className={cn("font-mono text-xs", speakerColor(speakerId))}>
      {text}
    </span>
  );
}

interface MeetingSegment {
  sentenceId: string;
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

// 演示对话脚本：A=PM、B=Design / 数据，覆盖 Q3 双目标 + onboarding 决策 + 导出待办。
const DEMO_SCRIPT: Array<Omit<MeetingSegment, "sentenceId" | "endMs" | "isFinal">> = [
  { speakerId: 0, text: "我们先把 Q3 的目标过一遍。", startMs: 1200 },
  { speakerId: 1, text: "好的，重点是新用户激活和付费转化。", startMs: 5400 },
  { speakerId: 0, text: "激活率上个月做到 32%，目标是 40%。", startMs: 11800 },
  { speakerId: 1, text: "需要落地一个 onboarding 实验，design 周三前出方案。", startMs: 16500 },
  { speakerId: 0, text: "OK，付费这边我下周给数据分析报告。", startMs: 23200 },
  { speakerId: 1, text: "纪要直接生成到群里就行，关键决策一定要有时间戳。", startMs: 29800 },
  { speakerId: 0, text: "成交，散会。", startMs: 35200 },
];

// 已写死的 AI 摘要（直接用，task 里给定）
const SUMMARY_MARKDOWN = `## 决策
- Q3 双目标：新用户激活、付费转化。
- Onboarding 实验由 Design 团队主导，周三前出方案。

## 待办
- [ ] @Design：周三前提交 onboarding 实验方案
- [ ] @PM：下周提交付费转化数据分析报告

## 关键时刻
- 03:12 — 确认激活率目标 32% → 40%
- 08:45 — 决定 onboarding 实验由 Design 主导
`;

/* ─────────────────────────────────────────────── */
/*  Waveform                                        */
/* ─────────────────────────────────────────────── */

const BAR_WIDTH = 2;
const BAR_GAP = 2;
const BAR_STEP = BAR_WIDTH + BAR_GAP;

function useResizeBarCount(containerRef: React.RefObject<HTMLDivElement | null>) {
  const [barCount, setBarCount] = useState(96);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      const next = Math.max(24, Math.floor(w / BAR_STEP));
      setBarCount(next);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [containerRef]);
  return barCount;
}

function LiveWaveform({ active, height = 56 }: { active: boolean; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const barCount = useResizeBarCount(containerRef);
  const [amps, setAmps] = useState<number[]>(() => Array(96).fill(0));

  useEffect(() => {
    setAmps((prev) => {
      if (prev.length === barCount) return prev;
      if (prev.length > barCount) return prev.slice(prev.length - barCount);
      return Array(barCount - prev.length).fill(0).concat(prev);
    });
  }, [barCount]);

  // mock：用 RAF + 多频率合成模拟人声振幅，pause 时冻结最后一帧（与真实 LiveWaveform 行为一致）
  useEffect(() => {
    if (!active) return;
    let raf = 0;
    const tick = () => {
      const t = performance.now() / 1000;
      const v = Math.max(
        0,
        Math.min(
          1,
          0.45 +
            Math.sin(t * 4.7) * 0.2 +
            Math.sin(t * 11) * 0.12 +
            Math.sin(t * 23) * 0.07 +
            (Math.random() - 0.5) * 0.18,
        ),
      );
      setAmps((prev) => {
        if (prev.length === 0) return prev;
        const out = prev.slice(1);
        out.push(v);
        return out;
      });
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);

  return (
    <div
      ref={containerRef}
      className="flex w-full items-center justify-between"
      style={{ height, gap: `${BAR_GAP}px` }}
    >
      {amps.map((amp, i) => {
        const eased = Math.pow(amp, 0.55);
        const h = Math.max(2, eased * height);
        return (
          <span
            key={i}
            className={cn(
              "shrink-0 rounded-[1px] bg-te-accent transition-[height] duration-75 ease-out",
              !active && "opacity-30",
            )}
            style={{ width: `${BAR_WIDTH}px`, height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

// review 态用的静态波形（克隆自 AudioWavePlayer 视觉），bar 数组按已知振幅生成
function StaticWaveform({ progress, height = 56 }: { progress: number; height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const barCount = useResizeBarCount(containerRef);

  const amps = useMemo(
    () =>
      Array.from({ length: barCount }, (_, i) => {
        const a = Math.sin(i * 0.31) * 0.5 + 0.5;
        const b = Math.sin(i * 0.97 + 1.3) * 0.5 + 0.5;
        const c = Math.sin(i * 1.9 + 2.6) * 0.5 + 0.5;
        const env = 0.55 + 0.45 * Math.sin((i / Math.max(1, barCount - 1)) * Math.PI);
        return Math.max(0.1, (a * 0.5 + b * 0.3 + c * 0.2) * env);
      }),
    [barCount],
  );

  const playedIdx = Math.floor(progress * barCount);

  return (
    <div
      ref={containerRef}
      className="flex w-full items-center justify-between"
      style={{ height, gap: `${BAR_GAP}px` }}
    >
      {amps.map((amp, i) => {
        const eased = Math.pow(amp, 0.55);
        const h = Math.max(2, eased * height);
        const played = i <= playedIdx;
        return (
          <span
            key={i}
            className={cn(
              "shrink-0 rounded-[1px]",
              played ? "bg-te-accent" : "bg-te-light-gray/40",
            )}
            style={{ width: `${BAR_WIDTH}px`, height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Segment block                                   */
/* ─────────────────────────────────────────────── */

function SegmentBlock({ seg }: { seg: MeetingSegment }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <SpeakerLabel speakerId={seg.speakerId} />
        <span className="font-mono text-[10px] tabular-nums text-te-light-gray/60">
          {formatHMS(seg.startMs)}
        </span>
      </div>
      <p
        className={cn(
          "text-sm leading-relaxed",
          seg.isFinal ? "text-te-fg" : "text-te-light-gray",
        )}
      >
        {seg.text}
        {!seg.isFinal ? (
          <span className="ml-0.5 inline-block animate-pulse">▌</span>
        ) : null}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Inline prose-meeting style (landing/styles.css 没定义，内联一份避免改全局)  */
/* ─────────────────────────────────────────────── */

const PROSE_MEETING_CSS = `
.lp-prose-meeting h2 {
  font-family: "Space Mono", ui-monospace, monospace;
  font-weight: 700;
  font-size: 0.9rem;
  margin: 1.1rem 0 0.4rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--te-accent);
}
.lp-prose-meeting h2:first-child { margin-top: 0; }
.lp-prose-meeting h3 {
  font-family: "Space Mono", ui-monospace, monospace;
  font-size: 0.82rem;
  margin: 0.9rem 0 0.3rem;
  color: var(--te-light-gray);
}
.lp-prose-meeting p { margin: 0.4rem 0; }
.lp-prose-meeting ul,
.lp-prose-meeting ol { margin: 0.3rem 0 0.6rem; padding-left: 1.2rem; }
.lp-prose-meeting ul { list-style: disc; }
.lp-prose-meeting ol { list-style: decimal; }
.lp-prose-meeting li { margin: 0.25rem 0; }
.lp-prose-meeting li input[type="checkbox"] {
  margin-right: 0.45rem;
  vertical-align: middle;
  accent-color: var(--te-accent);
}
.lp-prose-meeting strong { font-weight: 700; color: var(--te-fg); }
.lp-prose-meeting em { font-style: italic; color: var(--te-light-gray); }
.lp-prose-meeting a { color: var(--te-accent); text-decoration: underline; }
`;

/* ─────────────────────────────────────────────── */
/*  Main component                                  */
/* ─────────────────────────────────────────────── */

export type MeetingsView = "live" | "review";

interface MeetingsLiveStaticProps {
  /** 是否驱动演示（section 进入视口才启动） */
  active: boolean;
  /** 显式指定 view；不传则按内部状态机自动 live → review 循环 */
  view?: MeetingsView;
  /** view 切换回调，便于父级同步 AppWindow subtitle */
  onViewChange?: (view: MeetingsView) => void;
}

export function MeetingsLiveStatic({
  active,
  view: viewProp,
  onViewChange,
}: MeetingsLiveStaticProps) {
  const [internalView, setInternalView] = useState<MeetingsView>("live");
  const view = viewProp ?? internalView;

  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [revealedCount, setRevealedCount] = useState(0);
  const [reviewProgress, setReviewProgress] = useState(0);

  const liveScrollerRef = useRef<HTMLDivElement | null>(null);
  const reviewScrollerRef = useRef<HTMLDivElement | null>(null);

  // segments：live 态按 revealedCount 解锁，review 态全量、全 isFinal
  const segments = useMemo<MeetingSegment[]>(() => {
    const count = view === "review" ? DEMO_SCRIPT.length : revealedCount;
    return DEMO_SCRIPT.slice(0, count).map((s, i) => ({
      sentenceId: `seg-${i}`,
      speakerId: s.speakerId,
      text: s.text,
      startMs: s.startMs,
      endMs: s.startMs + 2400,
      isFinal: true,
    }));
  }, [revealedCount, view]);

  const speakerCount = useMemo(() => {
    const set = new Set<number>();
    segments.forEach((s) => {
      if (s.speakerId >= 0) set.add(s.speakerId);
    });
    return set.size || 2;
  }, [segments]);

  // 内部状态机：active 时跑 live → review 循环；viewProp 给定时停用
  useEffect(() => {
    if (viewProp != null) return;
    if (!active) {
      setInternalView("live");
      setPaused(false);
      setElapsedMs(0);
      setRevealedCount(0);
      setReviewProgress(0);
      return;
    }

    const startTs = performance.now();
    let frozenMs = 0;

    const tick = setInterval(() => {
      if (!paused) setElapsedMs(performance.now() - startTs);
    }, 200);

    const reveal = setInterval(() => {
      setRevealedCount((n) => Math.min(DEMO_SCRIPT.length, n + 1));
    }, 1200);

    // live 阶段约 9.6 秒（reveal 间隔 1200ms × 8）后切到 review
    const toReview = setTimeout(() => {
      frozenMs = performance.now() - startTs;
      setElapsedMs(frozenMs);
      setRevealedCount(DEMO_SCRIPT.length);
      setInternalView("review");
    }, 9600);

    return () => {
      clearInterval(tick);
      clearInterval(reveal);
      clearTimeout(toReview);
    };
  }, [active, viewProp, paused]);

  // 通知父级 view 切换
  useEffect(() => {
    onViewChange?.(view);
  }, [view, onViewChange]);

  // review 态：6 秒后回到 live，循环；进度条同步前进
  useEffect(() => {
    if (viewProp != null) return;
    if (!active || view !== "review") return;
    setReviewProgress(0);

    const startTs = performance.now();
    const REVIEW_MS = 6000;

    const progress = setInterval(() => {
      const p = Math.min(1, (performance.now() - startTs) / REVIEW_MS);
      setReviewProgress(p);
    }, 80);

    const toLive = setTimeout(() => {
      setElapsedMs(0);
      setRevealedCount(0);
      setReviewProgress(0);
      setInternalView("live");
    }, REVIEW_MS);

    return () => {
      clearInterval(progress);
      clearTimeout(toLive);
    };
  }, [active, view, viewProp]);

  // live 滚到底
  useEffect(() => {
    const el = liveScrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [segments.length]);

  return (
    <section className="relative flex h-[560px] flex-col overflow-hidden border border-te-gray/40 bg-te-bg">
      <style>{PROSE_MEETING_CSS}</style>

      {view === "live" ? (
        <LivePanel
          paused={paused}
          active={active}
          elapsedMs={elapsedMs}
          segments={segments}
          onPauseToggle={() => setPaused((p) => !p)}
          scrollerRef={liveScrollerRef}
        />
      ) : (
        <ReviewPanel
          elapsedMs={elapsedMs || 754_000}
          speakerCount={speakerCount}
          segmentCount={DEMO_SCRIPT.length}
          segments={segments}
          progress={reviewProgress}
          scrollerRef={reviewScrollerRef}
        />
      )}
    </section>
  );
}

/* ─────────────────────────────────────────────── */
/*  Live panel                                      */
/* ─────────────────────────────────────────────── */

interface LivePanelProps {
  paused: boolean;
  active: boolean;
  elapsedMs: number;
  segments: MeetingSegment[];
  onPauseToggle: () => void;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}

function LivePanel({
  paused,
  active,
  elapsedMs,
  segments,
  onPauseToggle,
  scrollerRef,
}: LivePanelProps) {
  return (
    <motion.div
      key="live"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35 }}
      className="flex h-full min-h-0 flex-col"
    >
      {/* header（克隆自 view !== "review" 标题区） */}
      <div className="shrink-0 border-b border-te-gray/30 bg-te-bg">
        <div className="mx-auto max-w-5xl px-[4vw] pt-3 pb-3">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h1 className="font-mono text-2xl font-bold tracking-tighter text-te-fg">
                会议录制
              </h1>
              <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
                实时转写 · 说话人分离 · AI 摘要
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span
                className={cn(
                  "size-2.5 rounded-full",
                  paused ? "bg-te-light-gray" : "animate-pulse bg-[#ff4d4d]",
                )}
              />
              <span className="font-mono text-2xl font-bold tabular-nums text-te-fg">
                {formatHMS(elapsedMs)}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* toolbar + 实时波形（克隆自 LiveView） */}
      <div className="border-b border-te-gray/40 bg-te-surface">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-[4vw] py-4">
          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
              {paused ? "已暂停" : "录制中"}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPauseToggle}
                className="flex items-center gap-2 border border-te-gray/40 bg-te-bg px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition hover:border-te-accent hover:text-te-accent"
              >
                {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {paused ? "继续" : "暂停"}
              </button>
              <button
                type="button"
                className="flex items-center gap-2 border border-[#ff4d4d] bg-[#ff4d4d] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#ff6b6b]"
              >
                <Square className="size-3.5" />
                结束
              </button>
            </div>
          </div>
          <LiveWaveform active={!paused && active} height={56} />
        </div>
      </div>

      {/* segments scroller */}
      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-5 px-[4vw] py-[clamp(1rem,2vw,2rem)]">
          {segments.map((seg) => (
            <SegmentBlock key={seg.sentenceId} seg={seg} />
          ))}
          {!paused && segments.length === 0 ? (
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
              正在聆听…
            </div>
          ) : null}
        </div>
      </div>
    </motion.div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Review panel                                    */
/* ─────────────────────────────────────────────── */

interface ReviewPanelProps {
  elapsedMs: number;
  speakerCount: number;
  segmentCount: number;
  segments: MeetingSegment[];
  progress: number;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}

function ReviewPanel({
  elapsedMs,
  speakerCount,
  segmentCount,
  segments,
  progress,
  scrollerRef,
}: ReviewPanelProps) {
  const title = `会议录制 · ${new Date().toLocaleDateString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
  })}`;

  // 当前播放对应的 segment（由 progress 决定，让左栏跟着右栏摘要"高亮"）
  const activeIdx = Math.min(
    segments.length - 1,
    Math.floor(progress * segments.length),
  );

  return (
    <motion.div
      key="review"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.4 }}
      className="flex h-full min-h-0 flex-col"
    >
      {/* topbar（克隆自 ReviewView） */}
      <div className="border-b border-te-gray/40 bg-te-bg">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-5 py-2">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              className="flex shrink-0 items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-te-accent transition hover:brightness-110"
            >
              <ArrowLeft className="size-3.5" />
              返回
            </button>
            <span className="truncate font-mono text-sm text-te-fg">{title}</span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] tabular-nums text-te-light-gray">
              {formatHMS(elapsedMs)} · {speakerCount} 人 · {segmentCount} 段
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              className="flex items-center gap-2 border border-te-gray/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition hover:border-te-accent hover:text-te-accent"
            >
              <Download className="size-3" />
              导出
            </button>
            <button
              type="button"
              className="flex items-center gap-2 border border-te-gray/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition hover:border-[#ff4d4d] hover:text-[#ff4d4d]"
            >
              <Trash2 className="size-3" />
              删除
            </button>
          </div>
        </div>
      </div>

      {/* 静态波形（克隆 AudioWavePlayer 视觉） */}
      <div className="border-b border-te-gray/40 bg-te-surface px-[4vw] py-3">
        <div className="mx-auto max-w-5xl">
          <StaticWaveform progress={progress} height={48} />
        </div>
      </div>

      {/* 双栏：transcript / summary */}
      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto grid h-full max-w-5xl grid-cols-2 divide-x divide-te-gray/40 px-[4vw]">
          {/* 左栏 transcript */}
          <div className="flex min-h-0 flex-col pr-4">
            <div className="flex shrink-0 items-center justify-between border-b border-te-gray/40 py-3">
              <span className="font-mono text-xs uppercase tracking-[0.25em] text-te-fg">
                转写
              </span>
            </div>
            <div ref={scrollerRef} className="flex-1 overflow-y-auto py-4">
              <div className="flex flex-col gap-4">
                {segments.map((seg, i) => {
                  const isActive = i === activeIdx;
                  return (
                    <div
                      key={seg.sentenceId}
                      className={cn(
                        "flex w-full flex-col gap-2 border-l-2 px-3 py-1 transition",
                        isActive
                          ? "border-te-accent bg-te-surface-hover/40"
                          : "border-transparent",
                      )}
                    >
                      <div className="flex items-baseline gap-3">
                        <SpeakerLabel speakerId={seg.speakerId} />
                        <span className="ml-auto font-mono text-[10px] tabular-nums text-te-light-gray/60">
                          {formatHMS(seg.startMs)}
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed text-te-fg">
                        {seg.text}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>

          {/* 右栏 AI 摘要 */}
          <div className="flex min-h-0 flex-col pl-4">
            <div className="flex shrink-0 items-center justify-between border-b border-te-gray/40 py-3">
              <span className="font-mono text-xs uppercase tracking-[0.25em] text-te-fg">
                AI 纪要
              </span>
              <span className="flex items-center gap-2 border border-te-accent/60 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-te-accent">
                <Sparkles className="size-3" />
                已生成
              </span>
            </div>
            <div className="flex-1 overflow-y-auto py-4">
              <article className="lp-prose-meeting font-sans text-sm leading-relaxed text-te-fg">
                <ReactMarkdown>{SUMMARY_MARKDOWN}</ReactMarkdown>
              </article>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
