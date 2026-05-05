import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Mic,
  Pause,
  Pencil,
  Play,
  Search,
  Square,
  Trash2,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";

type View = "idle" | "live" | "paused" | "review";

type Segment = {
  id: string;
  speakerId: string;
  speakerName?: string;
  startMs: number;
  text: string;
  isFinal: boolean;
};

type SessionRow = {
  id: string;
  title: string;
  durationMs: number;
  speakerCount: number;
  startedAt: number;
};

const SPEAKER_COLORS = [
  "text-te-accent",
  "text-emerald-400",
  "text-sky-400",
  "text-violet-400",
  "text-rose-400",
  "text-amber-400",
];

const MOCK_SESSIONS: SessionRow[] = [
  {
    id: "m_001",
    title: "周会 · 05-04",
    durationMs: 45 * 60_000 + 21_000,
    speakerCount: 3,
    startedAt: Date.now() - 2 * 86_400_000,
  },
  {
    id: "m_002",
    title: "客户访谈 · 05-02",
    durationMs: 72 * 60_000 + 8_000,
    speakerCount: 2,
    startedAt: Date.now() - 4 * 86_400_000,
  },
  {
    id: "m_003",
    title: "技术评审 · 04-28",
    durationMs: 31 * 60_000,
    speakerCount: 4,
    startedAt: Date.now() - 8 * 86_400_000,
  },
];

const MOCK_SEGMENTS: Segment[] = [
  {
    id: "s1",
    speakerId: "A",
    startMs: 12_000,
    text: "今天的议程主要有三个，第一个是上周遗留任务的复盘。",
    isFinal: true,
  },
  {
    id: "s2",
    speakerId: "B",
    startMs: 38_000,
    text: "补充一下数据，上周的转化率比预期高了 12%。",
    isFinal: true,
  },
  {
    id: "s3",
    speakerId: "A",
    startMs: 56_000,
    text: "嗯，那我们接下来重点看第二项",
    isFinal: false,
  },
];

function formatHMS(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function speakerColor(speakerId: string): string {
  const idx = speakerId.charCodeAt(0) - 65;
  return SPEAKER_COLORS[((idx % SPEAKER_COLORS.length) + SPEAKER_COLORS.length) % SPEAKER_COLORS.length];
}

/* ─────────────────────────────────────────────── */
/*  Waveform                                        */
/* ─────────────────────────────────────────────── */

// 与 History wavesurfer 配置对齐：barWidth=2 / barGap=2 / barRadius=1 / 中心对称
const BAR_WIDTH = 2;
const BAR_GAP = 2;
const BAR_STEP = BAR_WIDTH + BAR_GAP;

function MockWaveform({
  active,
  height = 64,
  variant = "live",
}: {
  active: boolean;
  height?: number;
  variant?: "live" | "preview";
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [barCount, setBarCount] = useState(96);
  const [tick, setTick] = useState(0);
  const [amps, setAmps] = useState<number[]>([]);

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
  }, []);

  // preview：固定的"已录音 clip"形态，无动画（多 sin 叠加 + 两端轻微衰减）
  const previewAmps = useMemo(() => {
    if (variant !== "preview") return null;
    return Array.from({ length: barCount }, (_, i) => {
      const a = Math.sin(i * 0.21) * 0.5 + 0.5;
      const b = Math.sin(i * 0.83 + 1.2) * 0.5 + 0.5;
      const c = Math.sin(i * 1.7 + 2.3) * 0.5 + 0.5;
      const env = 0.55 + 0.45 * Math.sin((i / Math.max(1, barCount - 1)) * Math.PI);
      return Math.max(0.06, (a * 0.5 + b * 0.3 + c * 0.2) * env);
    });
  }, [variant, barCount]);

  useEffect(() => {
    if (variant !== "live") return;
    setAmps((prev) => {
      if (prev.length === barCount) return prev;
      if (prev.length > barCount) return prev.slice(prev.length - barCount);
      return Array(barCount - prev.length).fill(0).concat(prev);
    });
  }, [barCount, variant]);

  useEffect(() => {
    if (variant !== "live" || !active) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 90);
    return () => window.clearInterval(id);
  }, [variant, active]);

  useEffect(() => {
    if (variant !== "live" || !active) return;
    const t = tick * 0.09;
    const syll = Math.max(0, 0.55 + 0.45 * Math.sin(t * 1.6) * Math.sin(t * 0.55 + 0.4));
    const burst = 0.35 + 0.65 * Math.abs(Math.sin(t * 8.7));
    const jitter = 0.65 + 0.35 * Math.random();
    const next = Math.min(1, syll * burst * jitter);
    setAmps((prev) => {
      if (prev.length === 0) return prev;
      const out = prev.slice(1);
      out.push(next);
      return out;
    });
  }, [tick, variant, active]);

  const bars = useMemo(() => Array.from({ length: barCount }, (_, i) => i), [barCount]);

  return (
    <div
      ref={containerRef}
      className="flex w-full items-center justify-between"
      style={{ height, gap: `${BAR_GAP}px` }}
    >
      {bars.map((i) => {
        let amp: number;
        if (variant === "preview") {
          amp = previewAmps?.[i] ?? 0;
        } else {
          amp = active ? (amps[i] ?? 0) : 0;
        }
        const h = Math.max(2, amp * height);
        return (
          <span
            key={i}
            className={cn(
              "shrink-0 rounded-[1px] transition-[height] duration-90",
              variant === "preview" ? "bg-te-light-gray/50" : "bg-te-accent",
              variant === "live" && !active && "opacity-30",
            )}
            style={{ width: `${BAR_WIDTH}px`, height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Page entry                                      */
/* ─────────────────────────────────────────────── */

export default function MeetingsPage() {
  const { t } = useTranslation();
  const [view, setView] = useState<View>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    if (view !== "live") return;
    const start = Date.now() - elapsedMs;
    const id = window.setInterval(() => setElapsedMs(Date.now() - start), 250);
    return () => window.clearInterval(id);
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="relative flex h-full flex-col bg-te-bg">
      {view !== "review" ? (
        <div
          data-tauri-drag-region
          className="shrink-0 border-b border-te-gray/30 bg-te-bg"
        >
          <div
            data-tauri-drag-region
            className="mx-auto max-w-5xl px-[4vw] pt-3 pb-[clamp(1rem,2vw,2rem)]"
          >
            <motion.div
              data-tauri-drag-region
              className="flex items-start justify-between gap-4"
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.4 }}
            >
              <div data-tauri-drag-region>
                <h1 className="font-mono text-3xl font-bold tracking-tighter text-te-fg">
                  {t("pages:meetings.title")}
                </h1>
                <p className="mt-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
                  {t("pages:meetings.subtitle")}
                </p>
              </div>

              {view === "live" || view === "paused" ? (
                <div
                  data-tauri-drag-region="false"
                  className="flex shrink-0 items-center gap-3"
                >
                  <span
                    className={cn(
                      "size-2.5 rounded-full",
                      view === "paused" ? "bg-te-light-gray" : "animate-pulse bg-[#ff4d4d]",
                    )}
                  />
                  <span className="font-mono text-2xl font-bold tabular-nums text-te-fg">
                    {formatHMS(elapsedMs)}
                  </span>
                </div>
              ) : null}
            </motion.div>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "idle" ? (
          <IdleView
            onStart={() => {
              setElapsedMs(0);
              setView("live");
            }}
            onOpenSession={() => setView("review")}
          />
        ) : null}

        {view === "live" || view === "paused" ? (
          <LiveView
            paused={view === "paused"}
            onPauseToggle={() => setView(view === "paused" ? "live" : "paused")}
            onStop={() => {
              setView("idle");
              setElapsedMs(0);
            }}
          />
        ) : null}

        {view === "review" ? <ReviewView onBack={() => setView("idle")} /> : null}
      </div>

      <DevStateSwitcher view={view} setView={setView} />
    </section>
  );
}

/* ─────────────────────────────────────────────── */
/*  Idle view                                       */
/* ─────────────────────────────────────────────── */

function IdleView({
  onStart,
  onOpenSession,
}: {
  onStart: () => void;
  onOpenSession: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <div className="relative mx-auto w-full max-w-5xl px-[4vw] py-[clamp(1.5rem,4vw,3rem)]">
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 40% 60% at 50% 45%, color-mix(in oklab, var(--te-accent) 14%, transparent) 0%, transparent 70%)",
          }}
        />
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.4, delay: 0.05 }}
          className="relative flex flex-col items-center gap-7"
        >
          <button
            type="button"
            onClick={onStart}
            aria-label={t("pages:meetings.idle.hint")}
            className="group relative flex size-28 items-center justify-center rounded-full bg-te-accent text-te-accent-fg shadow-[0_0_0_8px_color-mix(in_oklab,var(--te-accent)_18%,transparent)] transition hover:shadow-[0_0_0_14px_color-mix(in_oklab,var(--te-accent)_22%,transparent)]"
          >
            <Mic className="size-10 transition group-hover:scale-110" strokeWidth={1.75} />
          </button>

          <div className="text-center">
            <div className="font-mono text-xs uppercase tracking-[0.3em] text-te-light-gray">
              {t("pages:meetings.idle.hint")}
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-te-fg">
              00:00:00
            </div>
          </div>

          <div className="w-full">
            <MockWaveform active={false} variant="preview" height={48} />
          </div>
        </motion.div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="border-y border-te-gray/40 bg-te-bg">
          <div className="mx-auto flex max-w-5xl items-center justify-between px-[4vw] py-2">
            <span className="font-mono text-xs uppercase tracking-[0.25em] text-te-light-gray">
              {t("pages:meetings.idle.recent")}
            </span>
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/60">
              {MOCK_SESSIONS.length} {t("pages:meetings.idle.items")}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <ul className="mx-auto max-w-5xl divide-y divide-te-gray/40 px-[4vw]">
            {MOCK_SESSIONS.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  onClick={() => onOpenSession(s.id)}
                  className="flex w-full items-center gap-4 py-4 text-left transition hover:bg-te-surface-hover"
                >
                  <div className="flex size-10 shrink-0 items-center justify-center border border-te-gray/40 bg-te-surface">
                    <Mic className="size-4 text-te-light-gray" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm text-te-fg">{s.title}</div>
                    <div className="mt-1 flex items-center gap-3 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
                      <span className="tabular-nums">{formatHMS(s.durationMs)}</span>
                      <span className="inline-flex items-center gap-1">
                        <Users className="size-3" />
                        {s.speakerCount}
                      </span>
                    </div>
                  </div>
                  <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/60">
                    {new Date(s.startedAt).toLocaleDateString()}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Live view                                       */
/* ─────────────────────────────────────────────── */

function LiveView({
  paused,
  onPauseToggle,
  onStop,
}: {
  paused: boolean;
  onPauseToggle: () => void;
  onStop: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-te-gray/40 bg-te-surface">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-[4vw] py-4">
          <div className="flex items-center justify-between gap-4">
            <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
              {paused ? t("pages:meetings.live.paused") : t("pages:meetings.live.recording")}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onPauseToggle}
                className="flex items-center gap-2 border border-te-gray/40 bg-te-bg px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition hover:border-te-accent hover:text-te-accent"
              >
                {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
                {paused ? t("pages:meetings.live.resume") : t("pages:meetings.live.pause")}
              </button>
              <button
                type="button"
                onClick={onStop}
                className="flex items-center gap-2 border border-[#ff4d4d] bg-[#ff4d4d] px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-white transition hover:bg-[#ff6b6b]"
              >
                <Square className="size-3.5" />
                {t("pages:meetings.live.stop")}
              </button>
            </div>
          </div>
          <MockWaveform active={!paused} height={56} />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-[4vw] py-[clamp(1rem,2vw,2rem)]">
          {MOCK_SEGMENTS.map((seg) => (
            <SegmentBlock key={seg.id} seg={seg} />
          ))}
          {!paused ? (
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
              {t("pages:meetings.live.listening")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SegmentBlock({ seg }: { seg: Segment }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            "font-mono text-xs uppercase tracking-[0.25em]",
            speakerColor(seg.speakerId),
          )}
        >
          [{seg.speakerName ?? `${seg.speakerId}`}]
        </span>
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
        {!seg.isFinal ? <span className="ml-0.5 inline-block animate-pulse">▌</span> : null}
      </p>
    </div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Review view                                     */
/* ─────────────────────────────────────────────── */

function ReviewView({ onBack }: { onBack: () => void }) {
  const { t } = useTranslation();
  const session = MOCK_SESSIONS[0];

  return (
    <div className="flex h-full flex-col">
      <div data-tauri-drag-region className="border-b border-te-gray/40 bg-te-bg">
        <div
          data-tauri-drag-region
          className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-[4vw] py-3"
        >
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              data-tauri-drag-region="false"
              onClick={onBack}
              className="flex shrink-0 items-center gap-2 font-mono text-xs uppercase tracking-[0.2em] text-te-accent transition hover:brightness-110"
            >
              <ArrowLeft className="size-3.5" />
              {t("pages:meetings.review.back")}
            </button>
            <span className="truncate font-mono text-sm text-te-fg">{session.title}</span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] tabular-nums text-te-light-gray">
              {formatHMS(session.durationMs)} · {session.speakerCount} {t("pages:meetings.review.speakers")}
            </span>
          </div>
          <button
            type="button"
            data-tauri-drag-region="false"
            className="flex shrink-0 items-center gap-2 border border-te-gray/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition hover:border-[#ff4d4d] hover:text-[#ff4d4d]"
          >
            <Trash2 className="size-3" />
            {t("pages:meetings.review.delete")}
          </button>
        </div>
      </div>

      <div className="border-b border-te-gray/40 bg-te-surface">
        <div className="mx-auto flex max-w-5xl items-center gap-4 px-[4vw] py-4">
          <button
            type="button"
            className="flex size-9 shrink-0 items-center justify-center border border-te-gray/40 bg-te-bg text-te-fg transition hover:border-te-accent hover:text-te-accent"
          >
            <Play className="size-4" />
          </button>
          <div className="relative h-1 flex-1 bg-te-gray/40">
            <div className="absolute top-0 left-0 h-full w-1/4 bg-te-accent" />
            <div className="absolute top-1/2 left-1/4 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-te-accent" />
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-te-light-gray">
            12:34 / {formatHMS(session.durationMs)}
          </span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto grid h-full max-w-5xl grid-cols-2 divide-x divide-te-gray/40 px-[4vw]">
          <div className="flex min-h-0 flex-col pr-4">
            <div className="flex shrink-0 items-center justify-between border-b border-te-gray/40 py-3">
              <span className="font-mono text-xs uppercase tracking-[0.25em] text-te-fg">
                {t("pages:meetings.review.transcript")}
              </span>
              <div className="flex items-center gap-1 text-te-light-gray">
                <button
                  type="button"
                  title={t("pages:meetings.review.search")}
                  className="flex size-6 items-center justify-center transition hover:text-te-fg"
                >
                  <Search className="size-3.5" />
                </button>
                <button
                  type="button"
                  title={t("pages:meetings.review.edit")}
                  className="flex size-6 items-center justify-center transition hover:text-te-fg"
                >
                  <Pencil className="size-3.5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto py-5">
              <div className="flex flex-col gap-5">
                {MOCK_SEGMENTS.map((seg, i) => (
                  <button
                    key={seg.id}
                    type="button"
                    className={cn(
                      "flex flex-col gap-2 border-l-2 px-3 py-1 text-left transition",
                      i === 1
                        ? "border-te-accent bg-te-surface-hover"
                        : "border-transparent hover:border-te-gray/40 hover:bg-te-surface-hover/50",
                    )}
                  >
                    <div className="flex items-baseline gap-3">
                      <span
                        className={cn(
                          "font-mono text-xs uppercase tracking-[0.25em]",
                          speakerColor(seg.speakerId),
                        )}
                      >
                        [{seg.speakerName ?? `${seg.speakerId}`}]
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-te-light-gray/60">
                        {formatHMS(seg.startMs)}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed text-te-fg">{seg.text}</p>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="flex min-h-0 flex-col pl-4">
            <div className="flex shrink-0 items-center justify-between border-b border-te-gray/40 py-3">
              <span className="font-mono text-xs uppercase tracking-[0.25em] text-te-fg">
                {t("pages:meetings.review.summary")}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto py-5">
              <ReviewSummary />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewSummary() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex gap-2">
          <dt className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("pages:meetings.review.summary_topic")}：
          </dt>
          <dd className="text-te-fg">AI 代码生成规范与技能管理研讨会</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("pages:meetings.review.summary_speakers")}：
          </dt>
          <dd className="text-te-fg">A / B</dd>
        </div>
      </dl>

      <div>
        <div className="mb-1 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
          {t("pages:meetings.review.summary_abstract")}
        </div>
        <p className="text-sm leading-relaxed text-te-fg">
          本次会议重点讨论了 AI 代码生成中模板代码的规范性问题，确立了基于"最小化依赖"的模板优化策略，并明确了技能（Skills）的动态加载机制与 Token 管理原则，同时制定了后续需求文档生成与源码分析的执行计划。
        </p>
      </div>

      <div className="border-t border-te-gray/40 pt-3">
        <h4 className="mb-2 text-sm font-bold text-te-fg">一、模板代码规范与重构策略</h4>
        <p className="mb-2 text-sm leading-relaxed text-te-fg">
          针对当前模板代码中存在的不规范问题，会议确立了"最小化依赖"与"分层治理"的优化方向：
        </p>
        <ul className="ml-4 list-disc space-y-1.5 text-sm text-te-fg marker:text-te-accent">
          <li>
            <span className="font-bold">领域层纯化：</span>
            明确领域层（Domain Layer）不应直接依赖基础设施层（Infrastructure）的框架。
          </li>
          <li>
            <span className="font-bold">最小化引入原则：</span>
            鉴于 Java 生态对 Spring 的强依赖，允许在领域层引入部分常用 Spring 框架组件。
          </li>
        </ul>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────── */
/*  Dev state switcher                              */
/* ─────────────────────────────────────────────── */

function DevStateSwitcher({
  view,
  setView,
}: {
  view: View;
  setView: (v: View) => void;
}) {
  const states: View[] = ["idle", "live", "paused", "review"];
  return (
    <div className="pointer-events-auto absolute right-4 bottom-4 flex items-center gap-1 border border-te-gray/40 bg-te-surface/90 px-2 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray backdrop-blur">
      <span className="pr-2 text-te-light-gray/60">DEV</span>
      {states.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => setView(s)}
          className={cn(
            "px-2 py-0.5 transition",
            view === s ? "bg-te-accent text-te-accent-fg" : "hover:text-te-fg",
          )}
        >
          {s}
        </button>
      ))}
    </div>
  );
}
