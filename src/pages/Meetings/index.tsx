import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { listen } from "@tauri-apps/api/event";
import { save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import {
  ArrowLeft,
  Download,
  Loader2,
  Mic,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  Square,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import { cn } from "@/lib/utils";
import { useMeetingsStore, type MeetingSegment } from "@/stores/meetings";
import {
  buildMeetingMarkdown,
  exportMeetingMarkdown,
  type MeetingHistoryRow,
} from "@/lib/meetings-history";
import { MeetingErrorDialog } from "@/components/MeetingErrorDialog";
import {
  AudioWavePlayer,
  type AudioWavePlayerHandle,
} from "@/components/AudioWavePlayer";

const SPEAKER_COLORS = [
  "text-te-accent",
  "text-emerald-400",
  "text-sky-400",
  "text-violet-400",
  "text-rose-400",
  "text-amber-400",
];

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

function SpeakerLabel({ speakerId, className }: { speakerId: number; className?: string }) {
  const { t } = useTranslation();
  const text = speakerId < 0
    ? t("pages:meetings.speaker.pending")
    : t("pages:meetings.speaker.label", { letter: String.fromCharCode(65 + (speakerId % 26)) });
  return <span className={cn("font-mono text-xs", speakerColor(speakerId), className)}>{text}</span>;
}

/**
 * 把 store 里的 segments Map 派生成排好序的数组。
 *
 * 必须在组件内 useMemo 而不能用 zustand selector 直接 `Array.from(...).sort(...)`
 * —— selector 每次都返回新数组引用，会让 React 19 的 useSyncExternalStore 抛
 * "getSnapshot should be cached" 并陷入死循环。
 *
 * Map 引用只在 store 里 `set({ segments: new Map(...) })` 时才换，依赖稳定。
 */
function useSortedSegments(): MeetingSegment[] {
  const segmentsMap = useMeetingsStore((s) => s.segments);
  return useMemo(
    () => Array.from(segmentsMap.values()).sort((a, b) => a.startMs - b.startMs),
    [segmentsMap],
  );
}

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

function PreviewWaveform({ height = 48 }: { height?: number }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const barCount = useResizeBarCount(containerRef);

  const amps = useMemo(
    () =>
      Array.from({ length: barCount }, (_, i) => {
        const a = Math.sin(i * 0.21) * 0.5 + 0.5;
        const b = Math.sin(i * 0.83 + 1.2) * 0.5 + 0.5;
        const c = Math.sin(i * 1.7 + 2.3) * 0.5 + 0.5;
        const env = 0.55 + 0.45 * Math.sin((i / Math.max(1, barCount - 1)) * Math.PI);
        return Math.max(0.06, (a * 0.5 + b * 0.3 + c * 0.2) * env);
      }),
    [barCount],
  );

  return (
    <div
      ref={containerRef}
      className="flex w-full items-center justify-between"
      style={{ height, gap: `${BAR_GAP}px` }}
    >
      {amps.map((amp, i) => {
        const h = Math.max(2, amp * height);
        return (
          <span
            key={i}
            className="shrink-0 rounded-[1px] bg-te-light-gray/50"
            style={{ width: `${BAR_WIDTH}px`, height: `${h}px` }}
          />
        );
      })}
    </div>
  );
}

// 实时波形：订阅 Rust 端 20Hz 推送的 `openspeech://audio-level`（值已归一化 0..1）。
// active=false（pause）时不订阅；新 amp 入队右侧、左移老值，与 dictation Waveform 视觉一致。
function LiveWaveform({ active, height = 64 }: { active: boolean; height?: number }) {
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

  // pause 时只取消订阅、不清空 amps——保留最后一帧的波形冻结，让用户视觉上明确"暂停"
  // 而不是"已结束"。resume 时直接接着推新的电平，左侧旧值会被自然滑出。
  useEffect(() => {
    if (!active) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void listen<number>("openspeech://audio-level", (evt) => {
      if (cancelled) return;
      const v = Math.max(0, Math.min(1, Number(evt.payload) || 0));
      setAmps((prev) => {
        if (prev.length === 0) return prev;
        const out = prev.slice(1);
        out.push(v);
        return out;
      });
    }).then((u) => {
      if (cancelled) {
        u();
      } else {
        unlisten = u;
      }
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
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
  const dismissError = useMeetingsStore((s) => s.dismissError);

  useEffect(() => {
    let off: (() => void) | undefined;
    initSubscriptions().then((u) => { off = u; });
    return () => { off?.(); };
  }, [initSubscriptions]);

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

      <div className="min-h-0 flex-1 overflow-hidden">
        {view === "idle" || view === "starting" ? (
          <IdleView onStart={startMeeting} loading={view === "starting"} />
        ) : null}
        {view === "live" || view === "paused" ? (
          <LiveView paused={view === "paused"} onPauseToggle={view === "paused" ? resumeMeeting : pauseMeeting} onStop={stopMeeting} />
        ) : null}
        {view === "review" ? <ReviewView onBack={back} /> : null}
      </div>

      <MeetingErrorDialog error={error} onClose={dismissError} />
    </section>
  );
}

/* ─────────────────────────────────────────────── */
/*  Idle view                                       */
/* ─────────────────────────────────────────────── */

function IdleView({ onStart, loading }: { onStart: () => void; loading: boolean }) {
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
            disabled={loading}
            aria-label={t("pages:meetings.idle.hint")}
            aria-busy={loading}
            className={cn(
              "group relative flex size-28 items-center justify-center rounded-full bg-te-accent text-te-accent-fg transition",
              loading
                ? "cursor-progress opacity-80 shadow-[0_0_0_8px_color-mix(in_oklab,var(--te-accent)_18%,transparent)]"
                : "shadow-[0_0_0_8px_color-mix(in_oklab,var(--te-accent)_18%,transparent)] hover:shadow-[0_0_0_14px_color-mix(in_oklab,var(--te-accent)_22%,transparent)]",
            )}
          >
            {loading ? (
              <Loader2 className="size-10 animate-spin" strokeWidth={1.75} />
            ) : (
              <Mic className="size-10 transition group-hover:scale-110" strokeWidth={1.75} />
            )}
          </button>

          <div className="text-center">
            <div className="font-mono text-xs uppercase tracking-[0.3em] text-te-light-gray">
              {loading
                ? t("pages:meetings.idle.starting", { defaultValue: "Starting…" })
                : t("pages:meetings.idle.hint")}
            </div>
            <div className="mt-2 font-mono text-2xl font-bold tabular-nums text-te-fg">
              00:00:00
            </div>
          </div>

          <div className="w-full">
            <PreviewWaveform height={48} />
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
  const segments = useSortedSegments();
  const reconnect = useMeetingsStore((s) => s.reconnect);
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
      {reconnect ? (
        <div className="border-b border-amber-500/40 bg-amber-500/10">
          <div className="mx-auto flex max-w-5xl items-center gap-3 px-[4vw] py-2 font-mono text-[10px] uppercase tracking-[0.25em] text-amber-300">
            <span className="size-2 animate-pulse rounded-full bg-amber-400" />
            <span>
              {reconnect.phase === "gave_up"
                ? t("pages:meetings.live.reconnect_gave_up")
                : t("pages:meetings.live.reconnecting", {
                    attempt: reconnect.attempt,
                    max: reconnect.maxAttempts,
                  })}
            </span>
          </div>
        </div>
      ) : null}
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
          <LiveWaveform active={!paused} height={56} />
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
  const segments = useSortedSegments();
  const elapsedMs = useMeetingsStore((s) => s.elapsedMs);
  const reviewMeetingId = useMeetingsStore((s) => s.reviewMeetingId);
  const recent = useMeetingsStore((s) => s.recentMeetings);
  const lastRecording = useMeetingsStore((s) => s.lastRecording);
  const removeMeeting = useMeetingsStore((s) => s.removeMeeting);

  const playerRef = useRef<AudioWavePlayerHandle | null>(null);
  const [currentSec, setCurrentSec] = useState(0);

  const speakerCount = useMemo(() => {
    const set = new Set<number>();
    segments.forEach((s) => { if (s.speakerId >= 0) set.add(s.speakerId); });
    return set.size;
  }, [segments]);

  // 优先用历史记录的 created_at 渲染标题日期，避免打开旧会议时显示"今天"。
  const meta = reviewMeetingId ? recent.find((m) => m.id === reviewMeetingId) : null;
  const titleDate = new Date(meta?.created_at ?? Date.now()).toLocaleDateString();
  const title = `${t("pages:meetings.title")} · ${titleDate}`;

  // 优先取 recent 列表里的 audio_path（历史进入），fallback 到刚停的 lastRecording（review 直进）。
  const audioPath = meta?.audio_path ?? lastRecording?.audio_path ?? null;

  // 点 segment 跳到对应时间——直接调 wavesurfer，加载完成前调用会被忽略（getDuration=0）。
  const handleSegmentClick = (startMs: number) => {
    if (!audioPath) return;
    playerRef.current?.seekToSec(startMs / 1000);
  };

  const handleDelete = async () => {
    if (!reviewMeetingId) return onBack();
    const ok = window.confirm(
      t("pages:meetings.review.delete_confirm", { defaultValue: "Delete this meeting?" }),
    );
    if (!ok) return;
    await removeMeeting(reviewMeetingId);
    onBack();
  };

  // 导出 Markdown：拼字符串走系统 Save 对话框；用户取消视为正常退出。
  const handleExport = async () => {
    if (!reviewMeetingId || !meta || segments.length === 0) return;
    const created = new Date(meta.created_at);
    const pad = (n: number) => String(n).padStart(2, "0");
    const dateLabel = `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())}`;
    const shortId = reviewMeetingId.slice(0, 8);
    const defaultName = `${t("pages:meetings.review.export_default_name", {
      date: dateLabel,
      shortId,
    })}.md`;

    let dest: string | null = null;
    try {
      dest = await saveFileDialog({
        defaultPath: defaultName,
        filters: [{ name: t("pages:meetings.review.export_md_filter"), extensions: ["md"] }],
      });
    } catch (e) {
      console.error("[meetings] save dialog failed:", e);
      toast.error(t("pages:meetings.review.export_failed"));
      return;
    }
    if (!dest) return;

    try {
      const content = buildMeetingMarkdown({
        meeting: meta,
        segments: segments
          .filter((s) => s.isFinal)
          .map((s) => ({
            sentenceId: s.sentenceId,
            speakerId: s.speakerId,
            text: s.text,
            startMs: s.startMs,
            endMs: s.endMs,
          })),
        i18n: {
          title: t("pages:meetings.review.export_doc_title"),
          metaCreated: t("pages:meetings.review.export_meta_created"),
          metaDuration: t("pages:meetings.review.export_meta_duration"),
          metaSpeakers: t("pages:meetings.review.export_meta_speakers"),
          metaSegments: t("pages:meetings.review.export_meta_segments"),
          speakerLabel: t("pages:meetings.speaker.label"),
          speakerPending: t("pages:meetings.speaker.pending"),
        },
      });
      await exportMeetingMarkdown(content, dest);
      toast.success(t("pages:meetings.review.export_success", { path: dest }));
    } catch (e) {
      console.error("[meetings] export failed:", e);
      const msg = e instanceof Error ? e.message : String(e);
      toast.error(t("pages:meetings.review.export_failed"), { description: msg });
    }
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
          <div data-tauri-drag-region="false" className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={handleExport}
              disabled={!reviewMeetingId || segments.length === 0}
              className="flex items-center gap-2 border border-te-gray/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition hover:border-te-accent hover:text-te-accent disabled:opacity-40"
            >
              <Download className="size-3" />
              {t("pages:meetings.review.export")}
            </button>
            <button
              type="button"
              onClick={handleDelete}
              disabled={!reviewMeetingId}
              className="flex items-center gap-2 border border-te-gray/40 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition hover:border-[#ff4d4d] hover:text-[#ff4d4d] disabled:opacity-40"
            >
              <Trash2 className="size-3" />
              {t("pages:meetings.review.delete")}
            </button>
          </div>
        </div>
      </div>

      {audioPath ? (
        <AudioWavePlayer
          ref={playerRef}
          audioPath={audioPath}
          fallbackDurationMs={elapsedMs}
          onTimeUpdate={setCurrentSec}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto grid h-full max-w-5xl grid-cols-2 divide-x divide-te-gray/40 px-[4vw]">
          <div className="flex min-h-0 flex-col pr-4">
            <div className="flex shrink-0 items-center justify-between border-b border-te-gray/40 py-3">
              <span className="font-mono text-xs uppercase tracking-[0.25em] text-te-fg">
                {t("pages:meetings.review.transcript")}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto py-5">
              <div className="flex flex-col gap-5">
                {segments.length === 0 ? (
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/60">
                    {t("pages:meetings.review.transcript")} —
                  </div>
                ) : null}
                {segments.map((seg) => {
                  const isActive =
                    !!audioPath &&
                    currentSec * 1000 >= seg.startMs &&
                    currentSec * 1000 < seg.endMs;
                  return (
                    <button
                      key={seg.sentenceId}
                      type="button"
                      onClick={() => handleSegmentClick(seg.startMs)}
                      disabled={!audioPath}
                      className={cn(
                        "flex w-full flex-col gap-2 border-l-2 px-3 py-1 text-left transition disabled:cursor-default",
                        isActive
                          ? "border-te-accent bg-te-surface-hover/40"
                          : "border-transparent hover:border-te-gray/40 hover:bg-te-surface-hover/50",
                      )}
                    >
                      <div className="flex items-baseline gap-3">
                        <SpeakerLabel speakerId={seg.speakerId} />
                        <span className="font-mono text-[10px] tabular-nums text-te-light-gray/60">
                          {formatHMS(seg.startMs)}
                        </span>
                      </div>
                      <p className="text-sm leading-relaxed text-te-fg">{seg.text}</p>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>

          <MeetingSummaryPanel
            speakerCount={speakerCount}
            segmentCount={segments.length}
            hasSegments={segments.length > 0}
          />
        </div>
      </div>
    </div>
  );
}

// 右栏纪要面板：从 store 拉 summary 状态，按"未生成 / 生成中 / 已生成 / 失败"四态切换。
// generating 时持续追加 chunk，react-markdown 实时重渲染。
function MeetingSummaryPanel({
  speakerCount,
  segmentCount,
  hasSegments,
}: {
  speakerCount: number;
  segmentCount: number;
  hasSegments: boolean;
}) {
  const { t } = useTranslation();
  const summary = useMeetingsStore((s) => s.summary);
  const status = useMeetingsStore((s) => s.summaryStatus);
  const summaryError = useMeetingsStore((s) => s.summaryError);
  const generateSummary = useMeetingsStore((s) => s.generateSummary);

  const isBusy = status === "generating" || status === "loading";
  const hasContent = !!summary && summary.length > 0;

  return (
    <div className="flex min-h-0 flex-col pl-4">
      <div className="flex shrink-0 items-center justify-between border-b border-te-gray/40 py-3">
        <span className="font-mono text-xs uppercase tracking-[0.25em] text-te-fg">
          {t("pages:meetings.review.summary")}
        </span>
        <button
          type="button"
          onClick={() => void generateSummary()}
          disabled={!hasSegments || isBusy}
          className="flex items-center gap-2 border border-te-gray/40 px-3 py-1 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition hover:border-te-accent hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40"
        >
          {status === "generating" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : hasContent ? (
            <RefreshCw className="size-3" />
          ) : (
            <Sparkles className="size-3" />
          )}
          {hasContent
            ? t("pages:meetings.review.summary_regenerate")
            : t("pages:meetings.review.summary_generate")}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-5">
        {hasContent ? (
          <article className="prose-meeting font-sans text-sm leading-relaxed text-te-fg">
            <ReactMarkdown>{summary ?? ""}</ReactMarkdown>
            {status === "generating" ? (
              <span className="ml-1 inline-block animate-pulse text-te-accent">▌</span>
            ) : null}
          </article>
        ) : status === "loading" ? (
          <div className="font-mono text-[11px] text-te-light-gray/80">
            {t("pages:meetings.review.summary_loading")}
          </div>
        ) : status === "error" ? (
          <div className="flex flex-col gap-3">
            <div className="font-mono text-[11px] text-[#ff6b6b]">
              {t("pages:meetings.review.summary_failed")}
            </div>
            {summaryError ? (
              <div className="font-mono text-[10px] break-words text-te-light-gray/80">
                {summaryError}
              </div>
            ) : null}
          </div>
        ) : (
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
              {hasSegments
                ? t("pages:meetings.review.summary_idle_hint")
                : t("pages:meetings.review.summary_empty_transcript")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
