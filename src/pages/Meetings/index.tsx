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
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  selectSortedSegments,
  useMeetingsStore,
  type MeetingSegment,
} from "@/stores/meetings";
import type { MeetingHistoryRow } from "@/lib/meetings-history";
import { useUIStore } from "@/stores/ui";

const SPEAKER_COLORS = [
  "text-te-accent",
  "text-emerald-400",
  "text-sky-400",
  "text-violet-400",
  "text-rose-400",
  "text-amber-400",
];

// 错误条 → 引导按钮：把这些 code 映射成"前往设置 → 听写"。
// 其它 code 仅显示文本，不挂引导。
const ERROR_CODES_OPEN_SETTINGS: ReadonlySet<string> = new Set([
  "meeting_provider_unsupported",
  "meeting_provider_not_configured",
]);

function formatHMS(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** speakerId=-1（待识别）走灰；正整数按 mod 取色。 */
function speakerColor(speakerId: number): string {
  if (speakerId < 0) return "text-te-light-gray";
  return SPEAKER_COLORS[speakerId % SPEAKER_COLORS.length];
}

function speakerLabel(speakerId: number): string {
  if (speakerId < 0) return "?";
  return String.fromCharCode(65 + (speakerId % 26));
}

/* ─────────────────────────────────────────────── */
/*  Waveform                                        */
/* ─────────────────────────────────────────────── */

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
  const view = useMeetingsStore((s) => s.view);
  const elapsedMs = useMeetingsStore((s) => s.elapsedMs);
  const error = useMeetingsStore((s) => s.error);
  const initSubscriptions = useMeetingsStore((s) => s.initSubscriptions);
  const startMeeting = useMeetingsStore((s) => s.start);
  const pauseMeeting = useMeetingsStore((s) => s.pause);
  const resumeMeeting = useMeetingsStore((s) => s.resume);
  const stopMeeting = useMeetingsStore((s) => s.stop);
  const back = useMeetingsStore((s) => s.back);
  const dismissError = () => useMeetingsStore.setState({ error: null });
  const openSettings = useUIStore((s) => s.openSettings);

  useEffect(() => {
    let off: (() => void) | undefined;
    initSubscriptions().then((u) => { off = u; });
    return () => { off?.(); };
  }, [initSubscriptions]);

  const errorTitle = error
    ? t(`errors:meetings.${error.code}`, { defaultValue: error.message || error.code })
    : "";
  const errorHintKey = error ? `errors:meetings.${error.code}_hint` : "";
  const errorHint = error
    ? t(errorHintKey, { defaultValue: "" })
    : "";

  return (
    <section className="relative flex h-full flex-col bg-te-bg">
      {view !== "review" ? (
        <div data-tauri-drag-region className="shrink-0 border-b border-te-gray/30 bg-te-bg">
          <div data-tauri-drag-region className="mx-auto max-w-5xl px-[4vw] pt-3 pb-[clamp(1rem,2vw,2rem)]">
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
                <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-3">
                  <span className={cn("size-2.5 rounded-full", view === "paused" ? "bg-te-light-gray" : "animate-pulse bg-[#ff4d4d]")} />
                  <span className="font-mono text-2xl font-bold tabular-nums text-te-fg">
                    {formatHMS(elapsedMs)}
                  </span>
                </div>
              ) : null}
            </motion.div>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="flex items-start gap-3 border-b border-[#ff4d4d]/40 bg-[#ff4d4d]/10 px-[4vw] py-2 font-mono text-[11px] text-[#ff4d4d]">
          <div className="min-w-0 flex-1">
            <div className="font-semibold uppercase tracking-[0.15em]">{errorTitle}</div>
            {errorHint ? (
              <div className="mt-1 text-[10px] tracking-[0.05em] opacity-90">{errorHint}</div>
            ) : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {ERROR_CODES_OPEN_SETTINGS.has(error.code) ? (
              <button
                type="button"
                onClick={() => openSettings("DICTATION")}
                className="border border-[#ff4d4d]/60 px-2 py-1 text-[10px] uppercase tracking-[0.15em] hover:bg-[#ff4d4d]/20"
              >
                {t("errors:meetings.go_to_settings", { defaultValue: "Open settings" })}
              </button>
            ) : null}
            <button
              type="button"
              onClick={dismissError}
              className="px-2 py-1 text-[10px] uppercase tracking-[0.15em] opacity-80 hover:opacity-100"
            >
              {t("common:actions.close", { defaultValue: "Close" })}
            </button>
          </div>
        </div>
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "idle" ? <IdleView onStart={startMeeting} /> : null}
        {view === "live" || view === "paused" ? (
          <LiveView paused={view === "paused"} onPauseToggle={view === "paused" ? resumeMeeting : pauseMeeting} onStop={stopMeeting} />
        ) : null}
        {view === "review" ? <ReviewView onBack={back} /> : null}
      </div>
    </section>
  );
}

/* ─────────────────────────────────────────────── */
/*  Idle view                                       */
/* ─────────────────────────────────────────────── */

function IdleView({ onStart }: { onStart: () => void }) {
  const { t } = useTranslation();
  const recent = useMeetingsStore((s) => s.recentMeetings);
  const recentLoaded = useMeetingsStore((s) => s.recentLoaded);
  const loadRecent = useMeetingsStore((s) => s.loadRecent);
  const openMeeting = useMeetingsStore((s) => s.openMeeting);
  const removeMeeting = useMeetingsStore((s) => s.removeMeeting);

  useEffect(() => {
    void loadRecent();
  }, [loadRecent]);

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

          <div className="mt-1 max-w-md text-center font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/70">
            {t("pages:meetings.idle.language_support")}
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
              {recent.length} {t("pages:meetings.idle.items")}
            </span>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl px-[4vw]">
            {recent.length === 0 ? (
              <div className="py-8 text-center font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/60">
                {recentLoaded
                  ? t("pages:meetings.idle.empty", { defaultValue: "No meetings yet" })
                  : t("pages:meetings.idle.loading", { defaultValue: "Loading…" })}
              </div>
            ) : (
              <ul className="divide-y divide-te-gray/30">
                {recent.map((m) => (
                  <RecentMeetingRow
                    key={m.id}
                    item={m}
                    onOpen={() => openMeeting(m.id)}
                    onDelete={() => removeMeeting(m.id)}
                  />
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function RecentMeetingRow({
  item,
  onOpen,
  onDelete,
}: {
  item: MeetingHistoryRow;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const date = new Date(item.created_at);
  const dateLabel = date.toLocaleString(undefined, {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const preview = (item.text ?? "").trim().split(/\r?\n/).filter((s) => s.length > 0)[0] ?? "";
  return (
    <li className="group flex items-center gap-4 py-3">
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-4 text-left transition hover:bg-te-surface-hover/50"
      >
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] tabular-nums text-te-light-gray">
          {dateLabel}
        </span>
        <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] tabular-nums text-te-light-gray">
          {formatHMS(item.duration_ms)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm text-te-fg">
          {preview || t("pages:meetings.idle.empty_transcript", { defaultValue: "(empty)" })}
        </span>
      </button>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="shrink-0 p-1 text-te-light-gray opacity-0 transition group-hover:opacity-100 hover:text-[#ff4d4d]"
        title={t("pages:meetings.review.delete")}
      >
        <Trash2 className="size-3.5" />
      </button>
    </li>
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
  const segments = useMeetingsStore(selectSortedSegments);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // 新片段进来时滚到底（用户主动上滑可中断）
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [segments.length]);

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

      <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-5xl flex-col gap-6 px-[4vw] py-[clamp(1rem,2vw,2rem)]">
          {segments.map((seg) => (
            <SegmentBlock key={seg.sentenceId} seg={seg} />
          ))}
          {!paused && segments.length === 0 ? (
            <div className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/60">
              {t("pages:meetings.live.listening")}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SegmentBlock({ seg }: { seg: MeetingSegment }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline gap-3">
        <span
          className={cn(
            "font-mono text-xs uppercase tracking-[0.25em]",
            speakerColor(seg.speakerId),
          )}
        >
          [{speakerLabel(seg.speakerId)}]
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
  const segments = useMeetingsStore(selectSortedSegments);
  const elapsedMs = useMeetingsStore((s) => s.elapsedMs);
  const reviewMeetingId = useMeetingsStore((s) => s.reviewMeetingId);
  const recent = useMeetingsStore((s) => s.recentMeetings);
  const removeMeeting = useMeetingsStore((s) => s.removeMeeting);

  const speakerCount = useMemo(() => {
    const set = new Set<number>();
    segments.forEach((s) => { if (s.speakerId >= 0) set.add(s.speakerId); });
    return set.size;
  }, [segments]);

  // 优先用历史记录的 created_at 渲染标题日期，避免打开旧会议时显示"今天"。
  const meta = reviewMeetingId ? recent.find((m) => m.id === reviewMeetingId) : null;
  const titleDate = new Date(meta?.created_at ?? Date.now()).toLocaleDateString();
  const title = `${t("pages:meetings.title")} · ${titleDate}`;

  const handleDelete = async () => {
    if (!reviewMeetingId) return onBack();
    const ok = window.confirm(
      t("pages:meetings.review.delete_confirm", { defaultValue: "Delete this meeting?" }),
    );
    if (!ok) return;
    await removeMeeting(reviewMeetingId);
    onBack();
  };

  return (
    <div className="flex h-full flex-col">
      <div data-tauri-drag-region className="border-b border-te-gray/40 bg-te-bg">
        <div data-tauri-drag-region className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-[4vw] py-3">
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
            <span className="truncate font-mono text-sm text-te-fg">{title}</span>
            <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] tabular-nums text-te-light-gray">
              {formatHMS(elapsedMs)} · {speakerCount} {t("pages:meetings.review.speakers")}
            </span>
          </div>
          <button
            type="button"
            data-tauri-drag-region="false"
            onClick={handleDelete}
            disabled={!reviewMeetingId}
            className="flex shrink-0 items-center gap-2 border border-te-gray/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition hover:border-[#ff4d4d] hover:text-[#ff4d4d] disabled:opacity-40"
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
            <div className="absolute top-0 left-0 h-full w-0 bg-te-accent" />
          </div>
          <span className="shrink-0 font-mono text-[10px] tabular-nums text-te-light-gray">
            00:00 / {formatHMS(elapsedMs)}
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
                {segments.length === 0 ? (
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/60">
                    {t("pages:meetings.review.transcript")} —
                  </div>
                ) : null}
                {segments.map((seg) => (
                  <div
                    key={seg.sentenceId}
                    className="flex flex-col gap-2 border-l-2 border-transparent px-3 py-1 text-left transition hover:border-te-gray/40 hover:bg-te-surface-hover/50"
                  >
                    <div className="flex items-baseline gap-3">
                      <span className={cn("font-mono text-xs uppercase tracking-[0.25em]", speakerColor(seg.speakerId))}>
                        [{speakerLabel(seg.speakerId)}]
                      </span>
                      <span className="font-mono text-[10px] tabular-nums text-te-light-gray/60">
                        {formatHMS(seg.startMs)}
                      </span>
                    </div>
                    <p className="text-sm leading-relaxed text-te-fg">{seg.text}</p>
                  </div>
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
              {/* AI 纪要待接入：当前阶段先显示发言人 + 字数统计兜底。 */}
              <ReviewSummary speakerCount={speakerCount} segmentCount={segments.length} />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ReviewSummary({ speakerCount, segmentCount }: { speakerCount: number; segmentCount: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <dl className="flex flex-col gap-2 text-sm">
        <div className="flex gap-2">
          <dt className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("pages:meetings.review.summary_speakers")}：
          </dt>
          <dd className="text-te-fg">{speakerCount}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="shrink-0 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("pages:meetings.review.summary_section")}：
          </dt>
          <dd className="text-te-fg">{segmentCount}</dd>
        </div>
      </dl>

      <div className="border-t border-te-gray/40 pt-3 font-mono text-[11px] text-te-light-gray/80">
        {t("pages:meetings.review.summary_loading")}
      </div>
    </div>
  );
}
