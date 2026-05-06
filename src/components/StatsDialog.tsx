import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { BarChart3, Hourglass, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { StatsMetric } from "@/stores/ui";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focusMetric: StatsMetric;
};

const TYPING_BASELINE_WPM = 40;

const METRIC_INDEX: Record<StatsMetric, string> = {
  duration: "01",
  words: "02",
  wpm: "03",
  saved: "04",
};

type Range = "today" | "7d" | "30d" | "90d" | "all";
const RANGE_ORDER: Range[] = ["today", "7d", "30d", "90d", "all"];
const RANGE_DAYS: Record<Range, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: 365,
};

type DailyPoint = {
  daysAgo: number;
  durationMs: number;
  words: number;
  sessions: number;
};

type HeatCell = { weekday: number; hour: number; value: number };

type AppRow = { name: string; durationMs: number; words: number };

type WpmByMode = {
  mode: "REALTIME" | "UTTERANCE";
  wpm: number;
  sessions: number;
};

interface MockStats {
  daily: DailyPoint[];
  heat: HeatCell[];
  topApps: AppRow[];
  wpmByMode: WpmByMode[];
  sessionDist: { short: number; medium: number; long: number };
  totals: {
    durationMs: number;
    words: number;
    sessions: number;
    wpm: number;
    savedMs: number;
  };
}

// ────────────────────────────────────────────────────────────────
// Mock data — deterministic seeded RNG so the UI doesn't flicker
// ────────────────────────────────────────────────────────────────

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function buildMock(range: Range): MockStats {
  const days = RANGE_DAYS[range];
  const rng = makeRng(0x5eed + days * 17);

  const daily: DailyPoint[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const trend = 1 + (days - i) / Math.max(1, days * 1.6);
    const weekendBoost = i % 7 === 0 || i % 7 === 6 ? 1.25 : 1;
    const noise = 0.5 + rng();
    const sessions = Math.round(2 + 8 * trend * weekendBoost * noise);
    const avgSec = 30 + rng() * 60;
    const durationMs = Math.round(sessions * avgSec * 1000);
    const wpm = 70 + rng() * 50;
    const minutes = durationMs / 60_000;
    const words = Math.round(minutes * wpm);
    daily.push({ daysAgo: i, durationMs, words, sessions });
  }

  const heat: HeatCell[] = [];
  for (let w = 0; w < 7; w++) {
    for (let h = 0; h < 24; h++) {
      const workHours = h >= 9 && h <= 18 ? 1 : 0.15;
      const morning = h >= 7 && h <= 9 ? 0.6 : 0;
      const evening = h >= 20 && h <= 23 ? 0.5 : 0;
      const weekendDamp = w >= 5 ? 0.55 : 1;
      const base = (workHours + morning + evening) * weekendDamp;
      const value = Math.max(0, Math.min(1, base * (0.7 + rng() * 0.6)));
      heat.push({ weekday: w, hour: h, value });
    }
  }

  const topApps: AppRow[] = [
    { name: "VS Code", durationMs: 0, words: 0 },
    { name: "Chrome", durationMs: 0, words: 0 },
    { name: "Slack", durationMs: 0, words: 0 },
    { name: "Notion", durationMs: 0, words: 0 },
    { name: "Mail", durationMs: 0, words: 0 },
    { name: "Figma", durationMs: 0, words: 0 },
  ].map((row, idx) => {
    const factor = 1 - idx * 0.13;
    return {
      ...row,
      durationMs: Math.round(180 * 60_000 * factor * (0.6 + rng() * 0.7)),
      words: Math.round(2400 * factor * (0.6 + rng() * 0.7)),
    };
  });

  const wpmByMode: WpmByMode[] = [
    {
      mode: "REALTIME",
      wpm: Math.round(110 + rng() * 18),
      sessions: Math.round(60 + rng() * 30),
    },
    {
      mode: "UTTERANCE",
      wpm: Math.round(95 + rng() * 14),
      sessions: Math.round(40 + rng() * 30),
    },
  ];

  const totalSessions = daily.reduce((a, b) => a + b.sessions, 0);
  const sessionDist = {
    short: Math.round(totalSessions * 0.42),
    medium: Math.round(totalSessions * 0.43),
    long: Math.max(0, totalSessions - Math.round(totalSessions * 0.85)),
  };

  const totals = daily.reduce(
    (acc, d) => ({
      durationMs: acc.durationMs + d.durationMs,
      words: acc.words + d.words,
      sessions: acc.sessions + d.sessions,
    }),
    { durationMs: 0, words: 0, sessions: 0 },
  );
  const minutes = totals.durationMs / 60_000;
  const wpm = minutes > 0 ? Math.round(totals.words / minutes) : 0;
  const savedMs = Math.max(
    0,
    (totals.words / TYPING_BASELINE_WPM) * 60_000 - totals.durationMs,
  );

  return {
    daily,
    heat,
    topApps: topApps.sort((a, b) => b.durationMs - a.durationMs),
    wpmByMode,
    sessionDist,
    totals: { ...totals, wpm, savedMs },
  };
}

// ────────────────────────────────────────────────────────────────
// Format helpers
// ────────────────────────────────────────────────────────────────

function formatHHMM(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalMinutes = Math.floor(ms / 60_000);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function formatHoursLong(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "0h";
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return mm === 0 ? `${hh}h` : `${hh}h ${mm}m`;
}

function formatNumber(n: number): string {
  return new Intl.NumberFormat().format(n);
}

// ────────────────────────────────────────────────────────────────
// Top-level Dialog
// ────────────────────────────────────────────────────────────────

export function StatsDialog({ open, onOpenChange, focusMetric }: Props) {
  const { t } = useTranslation();
  const [metric, setMetric] = useState<StatsMetric>(focusMetric);
  const [range, setRange] = useState<Range>("30d");

  useEffect(() => {
    if (open) setMetric(focusMetric);
  }, [open, focusMetric]);

  const stats = useMemo(() => buildMock(range), [range]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[82vh] w-[92vw] max-w-5xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-5xl"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <BarChart3 className="size-4 shrink-0 text-te-accent" aria-hidden />
          <div className="flex flex-1 flex-col">
            <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
              {t("pages:home.stats_dialog.title")}
            </DialogTitle>
            <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("pages:home.stats_dialog.subtitle")}
            </DialogDescription>
          </div>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* KPI strip — clickable; the active cell drives main panel + facets */}
          <KpiStrip stats={stats} focused={metric} onSelect={setMetric} />

          {/* Range only — metric switching now lives in the KPI strip */}
          <div className="flex flex-wrap items-center gap-3 border-b border-te-gray/30 bg-te-bg/40 px-5 py-3">
            <RangeSwitcher value={range} onChange={setRange} />
          </div>

          {/* Main + facets */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 px-5 py-5">
            <AnimatePresence mode="wait">
              <motion.div
                key={metric}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.2 }}
                className="flex flex-col gap-4"
              >
                <MainPanel metric={metric} stats={stats} range={range} />
                <FacetPanel metric={metric} stats={stats} />
              </motion.div>
            </AnimatePresence>
          </div>

          <div className="flex shrink-0 items-center justify-between gap-4 border-t border-te-gray/30 bg-te-surface-hover px-5 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("pages:home.stats_dialog.footer.privacy")}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────
// KPI strip — 4 metric KPIs (clickable) + sessions (read-only).
// ────────────────────────────────────────────────────────────────

function KpiStrip({
  stats,
  focused,
  onSelect,
}: {
  stats: MockStats;
  focused: StatsMetric;
  onSelect: (m: StatsMetric) => void;
}) {
  const { t } = useTranslation();
  const cells: Array<{
    key: StatsMetric | "sessions";
    value: string;
    unit: string;
    selectable: boolean;
  }> = [
    {
      key: "duration",
      value: formatHHMM(stats.totals.durationMs),
      unit: t("pages:home.stats.duration_unit"),
      selectable: true,
    },
    {
      key: "words",
      value: formatNumber(stats.totals.words),
      unit: t("pages:home.stats.words_unit"),
      selectable: true,
    },
    {
      key: "wpm",
      value: stats.totals.wpm > 0 ? String(stats.totals.wpm) : "—",
      unit: t("pages:home.stats.wpm_unit"),
      selectable: true,
    },
    {
      key: "saved",
      value: formatHHMM(stats.totals.savedMs),
      unit: t("pages:home.stats.saved_unit"),
      selectable: true,
    },
    {
      key: "sessions",
      value: formatNumber(stats.totals.sessions),
      unit: "",
      selectable: false,
    },
  ];
  return (
    <div className="grid shrink-0 grid-cols-5 gap-px bg-te-gray/40">
      {cells.map((cell) => {
        const active = cell.key === focused;
        const baseCls =
          "relative flex flex-col gap-1.5 px-4 py-3 text-left transition-colors";
        const stateCls = active
          ? "bg-te-bg"
          : cell.selectable
            ? "bg-te-surface hover:bg-te-surface-hover"
            : "bg-te-surface";
        const inner = (
          <>
            {active ? (
              <span
                aria-hidden
                className="absolute inset-x-0 top-0 h-[2px] bg-te-accent"
              />
            ) : null}
            <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t(`pages:home.stats_dialog.kpi.${cell.key}`)}
            </span>
            <div className="flex items-baseline gap-2">
              <span
                className={cn(
                  "font-mono text-xl font-bold tracking-tighter md:text-2xl",
                  active ? "text-te-accent" : "text-te-fg",
                )}
              >
                {cell.value}
              </span>
              {cell.unit ? (
                <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                  {cell.unit}
                </span>
              ) : null}
            </div>
          </>
        );
        if (!cell.selectable) {
          return (
            <div key={cell.key} className={cn(baseCls, stateCls)}>
              {inner}
            </div>
          );
        }
        return (
          <button
            key={cell.key}
            type="button"
            onClick={() => onSelect(cell.key as StatsMetric)}
            aria-pressed={active}
            className={cn(
              baseCls,
              stateCls,
              "cursor-pointer focus:outline-none",
            )}
          >
            {inner}
          </button>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Range switcher
// ────────────────────────────────────────────────────────────────

function RangeSwitcher({
  value,
  onChange,
}: {
  value: Range;
  onChange: (r: Range) => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="tablist"
      className="inline-flex border border-te-gray/60 bg-te-surface font-mono text-[10px] uppercase tracking-widest"
    >
      {RANGE_ORDER.map((r) => {
        const active = r === value;
        return (
          <button
            key={r}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(r)}
            className={cn(
              "px-3 py-1.5 transition-colors",
              active
                ? "bg-te-accent text-te-accent-fg"
                : "text-te-light-gray hover:text-te-fg",
            )}
          >
            {t(`pages:home.stats_dialog.range.${r}`)}
          </button>
        );
      })}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Main panel — main chart per metric
// ────────────────────────────────────────────────────────────────

function MainPanel({
  metric,
  stats,
  range,
}: {
  metric: StatsMetric;
  stats: MockStats;
  range: Range;
}) {
  const { t } = useTranslation();
  const title = t(`pages:home.stats_dialog.main.${metric}.title`);
  const hint = t(`pages:home.stats_dialog.main.${metric}.hint`, {
    baseline: TYPING_BASELINE_WPM,
  });
  return (
    <Section title={title} hint={hint} indexLabel={METRIC_INDEX[metric]}>
      {metric === "duration" ? (
        <DailyBars stats={stats} field="duration" />
      ) : metric === "words" ? (
        <DailyBars stats={stats} field="words" />
      ) : metric === "wpm" ? (
        <WpmLine stats={stats} />
      ) : (
        <DailyBars stats={stats} field="saved" />
      )}
      <RangeBaseline range={range} />
    </Section>
  );
}

function RangeBaseline({ range }: { range: Range }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2 flex justify-between font-mono text-[9px] uppercase tracking-widest text-te-light-gray/70">
      <span>—{RANGE_DAYS[range]}d</span>
      <span>{t("pages:home.stats_dialog.range.today")}</span>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Facet panel — 1-2 facets per metric
// ────────────────────────────────────────────────────────────────

function FacetPanel({
  metric,
  stats,
}: {
  metric: StatsMetric;
  stats: MockStats;
}) {
  if (metric === "duration") {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FacetHeatmap heat={stats.heat} />
        <FacetSessionDist dist={stats.sessionDist} />
      </div>
    );
  }
  if (metric === "words") {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FacetTopApps apps={stats.topApps} valueKey="words" />
        <FacetSessionDist dist={stats.sessionDist} />
      </div>
    );
  }
  if (metric === "wpm") {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FacetWpmByMode rows={stats.wpmByMode} />
        <FacetTopApps apps={stats.topApps} valueKey="words" />
      </div>
    );
  }
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <FacetSavedEquivalent savedMs={stats.totals.savedMs} />
      <FacetTopApps apps={stats.topApps} valueKey="duration" />
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Section frame
// ────────────────────────────────────────────────────────────────

function Section({
  title,
  hint,
  indexLabel,
  children,
}: {
  title: string;
  hint?: string;
  indexLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="border border-te-gray/40 bg-te-surface/40 p-4">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex flex-col">
          <span className="font-mono text-xs font-bold uppercase tracking-[0.18em] text-te-fg">
            {title}
          </span>
          {hint ? (
            <span className="mt-0.5 font-sans text-[11px] leading-relaxed text-te-light-gray">
              {hint}
            </span>
          ) : null}
        </div>
        {indexLabel ? (
          <span className="font-mono text-[10px] tracking-widest text-te-light-gray">
            {indexLabel}
          </span>
        ) : null}
      </div>
      {children}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Charts — pure SVG
// ────────────────────────────────────────────────────────────────

function ChartFrame({
  children,
}: {
  children: (w: number, h: number) => React.ReactNode;
}) {
  const W = 800;
  const H = 180;
  return (
    <div className="w-full">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="block h-44 w-full"
      >
        {children(W, H)}
      </svg>
    </div>
  );
}

function DailyBars({
  stats,
  field,
}: {
  stats: MockStats;
  field: "duration" | "words" | "saved";
}) {
  const data = stats.daily;
  const series = data.map((d) => {
    if (field === "duration") return d.durationMs;
    if (field === "words") return d.words;
    const typingNeed = (d.words / TYPING_BASELINE_WPM) * 60_000;
    return Math.max(0, typingNeed - d.durationMs);
  });
  const maxV = Math.max(1, ...series);
  return (
    <ChartFrame>
      {(w, h) => {
        const innerH = h - 14;
        const gap = data.length > 60 ? 1 : 2;
        const bw = Math.max(1, (w - gap * (data.length - 1)) / data.length);
        return (
          <>
            {[0.25, 0.5, 0.75].map((p) => (
              <line
                key={p}
                x1={0}
                y1={innerH * (1 - p)}
                x2={w}
                y2={innerH * (1 - p)}
                stroke="var(--te-gray)"
                strokeWidth={0.5}
                strokeDasharray="2 3"
                opacity={0.3}
              />
            ))}
            {series.map((v, i) => {
              const bh = (v / maxV) * innerH;
              const x = i * (bw + gap);
              const y = innerH - bh;
              return (
                <rect
                  key={i}
                  x={x}
                  y={y}
                  width={bw}
                  height={Math.max(0.5, bh)}
                  fill="var(--te-accent)"
                  opacity={0.85}
                />
              );
            })}
            <line
              x1={0}
              y1={innerH + 0.5}
              x2={w}
              y2={innerH + 0.5}
              stroke="var(--te-gray)"
              strokeWidth={1}
            />
          </>
        );
      }}
    </ChartFrame>
  );
}

function WpmLine({ stats }: { stats: MockStats }) {
  const data = stats.daily;
  const wpms = data.map((d) =>
    d.durationMs > 0 ? d.words / (d.durationMs / 60_000) : 0,
  );
  const maxV = Math.max(120, ...wpms);
  return (
    <ChartFrame>
      {(w, h) => {
        const innerH = h - 14;
        const stepX = data.length > 1 ? w / (data.length - 1) : w;
        const points = wpms.map((v, i) => {
          const x = i * stepX;
          const y = innerH - (v / maxV) * innerH;
          return [x, y] as [number, number];
        });
        const path = points
          .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`)
          .join(" ");
        return (
          <>
            {[0.25, 0.5, 0.75].map((p) => (
              <line
                key={p}
                x1={0}
                y1={innerH * p}
                x2={w}
                y2={innerH * p}
                stroke="var(--te-gray)"
                strokeWidth={0.5}
                strokeDasharray="2 3"
                opacity={0.4}
              />
            ))}
            <path d={path} fill="none" stroke="var(--te-accent)" strokeWidth={1.5} />
            {points.length <= 60
              ? points.map(([x, y], i) => (
                  <circle key={i} cx={x} cy={y} r={1.5} fill="var(--te-accent)" />
                ))
              : null}
            <line
              x1={0}
              y1={innerH + 0.5}
              x2={w}
              y2={innerH + 0.5}
              stroke="var(--te-gray)"
              strokeWidth={1}
            />
          </>
        );
      }}
    </ChartFrame>
  );
}

// ────────────────────────────────────────────────────────────────
// Donut — SVG ring with multi-segment support
// ────────────────────────────────────────────────────────────────

type DonutSegment = { value: number; opacity: number };

function Donut({
  segments,
  centerLabel,
  centerHint,
  size = 132,
}: {
  segments: DonutSegment[];
  centerLabel: string;
  centerHint?: string;
  size?: number;
}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  const safeTotal = Math.max(1, total);
  const r = 40;
  const c = 2 * Math.PI * r;
  let acc = 0;
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <svg viewBox="0 0 100 100" className="absolute inset-0">
        <circle
          cx={50}
          cy={50}
          r={r}
          fill="none"
          stroke="var(--te-surface)"
          strokeWidth={12}
        />
        {segments.map((s, i) => {
          const dash = (s.value / safeTotal) * c;
          const offset = -((acc / safeTotal) * c);
          acc += s.value;
          return (
            <circle
              key={i}
              cx={50}
              cy={50}
              r={r}
              fill="none"
              stroke="var(--te-accent)"
              strokeOpacity={s.opacity}
              strokeWidth={12}
              strokeDasharray={`${dash.toFixed(2)} ${(c - dash).toFixed(2)}`}
              strokeDashoffset={offset.toFixed(2)}
              transform="rotate(-90 50 50)"
              strokeLinecap="butt"
            />
          );
        })}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="font-mono text-lg font-bold tracking-tighter text-te-fg">
          {centerLabel}
        </span>
        {centerHint ? (
          <span className="mt-0.5 font-mono text-[9px] uppercase tracking-widest text-te-light-gray">
            {centerHint}
          </span>
        ) : null}
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// Facets
// ────────────────────────────────────────────────────────────────

function FacetHeatmap({ heat }: { heat: HeatCell[] }) {
  const { t } = useTranslation();
  const max = Math.max(0.001, ...heat.map((c) => c.value));
  const weekdays = t("pages:home.stats_dialog.facet.heatmap.weekdays").split(",");
  return (
    <Section
      title={t("pages:home.stats_dialog.facet.heatmap.title")}
      hint={t("pages:home.stats_dialog.facet.heatmap.hint")}
    >
      <div className="grid grid-cols-[auto_1fr] gap-2">
        <div className="flex flex-col gap-px pt-[14px]">
          {weekdays.map((d, i) => (
            <div
              key={i}
              className="flex h-3 items-center font-mono text-[9px] tracking-widest text-te-light-gray"
            >
              {d}
            </div>
          ))}
        </div>
        <div>
          <div className="mb-1 grid grid-cols-12 font-mono text-[8px] tracking-widest text-te-light-gray/70">
            {[0, 4, 8, 12, 16, 20].map((h) => (
              <div key={h} className="col-span-2 text-left">
                {String(h).padStart(2, "0")}
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-px">
            {Array.from({ length: 7 }, (_, w) => (
              <div
                key={w}
                className="grid gap-px"
                style={{ gridTemplateColumns: "repeat(24, 1fr)" }}
              >
                {Array.from({ length: 24 }, (_, h) => {
                  const cell = heat.find(
                    (c) => c.weekday === w && c.hour === h,
                  );
                  const v = cell ? cell.value / max : 0;
                  return (
                    <div
                      key={h}
                      className="h-3"
                      style={{
                        background:
                          v < 0.05
                            ? "var(--te-surface)"
                            : `color-mix(in oklab, var(--te-accent) ${Math.round(
                                v * 100,
                              )}%, var(--te-surface))`,
                      }}
                      title={`${weekdays[w]} ${String(h).padStart(2, "0")}:00`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </Section>
  );
}

function FacetTopApps({
  apps,
  valueKey,
}: {
  apps: AppRow[];
  valueKey: "words" | "duration";
}) {
  const { t } = useTranslation();
  const max = Math.max(
    1,
    ...apps.map((a) => (valueKey === "words" ? a.words : a.durationMs)),
  );
  return (
    <Section
      title={t("pages:home.stats_dialog.facet.top_apps.title")}
      hint={t("pages:home.stats_dialog.facet.top_apps.hint")}
    >
      <div className="flex flex-col gap-1.5">
        {apps.map((a, i) => {
          const raw = valueKey === "words" ? a.words : a.durationMs;
          const display =
            valueKey === "words"
              ? formatNumber(a.words)
              : formatHoursLong(a.durationMs);
          const pct = (raw / max) * 100;
          return (
            <div
              key={i}
              className="grid grid-cols-[6rem_1fr_4.5rem] items-center gap-2"
            >
              <span className="truncate font-mono text-[11px] text-te-fg">
                {a.name}
              </span>
              <div className="relative h-3 bg-te-surface">
                <div
                  className="absolute inset-y-0 left-0 bg-te-accent"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="text-right font-mono text-[10px] tabular-nums text-te-light-gray">
                {display}
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function FacetWpmByMode({ rows }: { rows: WpmByMode[] }) {
  const { t } = useTranslation();
  const totalSessions = rows.reduce((a, r) => a + r.sessions, 0) || 1;
  return (
    <Section
      title={t("pages:home.stats_dialog.facet.wpm_by_mode.title")}
      hint={t("pages:home.stats_dialog.facet.wpm_by_mode.hint")}
    >
      <div className="grid grid-cols-2 gap-3">
        {rows.map((r, i) => {
          const sharePct = Math.round((r.sessions / totalSessions) * 100);
          return (
            <div
              key={r.mode}
              className="flex flex-col items-center gap-2 border border-te-gray/40 bg-te-surface px-3 py-3"
            >
              <Donut
                size={108}
                centerLabel={String(r.wpm)}
                centerHint="WPM"
                segments={[
                  { value: r.sessions, opacity: i === 0 ? 1 : 0.55 },
                  { value: totalSessions - r.sessions, opacity: 0 },
                ]}
              />
              <div className="flex w-full items-baseline justify-between font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                <span className="text-te-fg">{r.mode}</span>
                <span className="tabular-nums">{sharePct}%</span>
              </div>
              <span className="font-mono text-[9px] uppercase tracking-widest text-te-light-gray/70">
                {r.sessions} sessions
              </span>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

function FacetSessionDist({
  dist,
}: {
  dist: { short: number; medium: number; long: number };
}) {
  const { t } = useTranslation();
  const total = dist.short + dist.medium + dist.long;
  const items = [
    { key: "short" as const, value: dist.short, opacity: 1 },
    { key: "medium" as const, value: dist.medium, opacity: 0.65 },
    { key: "long" as const, value: dist.long, opacity: 0.35 },
  ];
  return (
    <Section
      title={t("pages:home.stats_dialog.facet.session_dist.title")}
      hint={t("pages:home.stats_dialog.facet.session_dist.hint")}
    >
      <div className="grid grid-cols-[auto_1fr] items-center gap-5">
        <Donut
          segments={items.map((it) => ({
            value: it.value,
            opacity: it.opacity,
          }))}
          centerLabel={formatNumber(total)}
          centerHint={t("pages:home.stats_dialog.kpi.sessions")}
        />
        <div className="flex flex-col gap-2">
          {items.map((it) => {
            const pct =
              total > 0 ? Math.round((it.value / total) * 100) : 0;
            return (
              <div
                key={it.key}
                className="flex items-center justify-between gap-2 font-mono text-[10px] uppercase tracking-widest text-te-light-gray"
              >
                <span className="flex items-center gap-2">
                  <span
                    className="size-2 bg-te-accent"
                    style={{ opacity: it.opacity }}
                    aria-hidden
                  />
                  {t(
                    `pages:home.stats_dialog.facet.session_dist.buckets.${it.key}`,
                  )}
                </span>
                <span className="tabular-nums text-te-fg">
                  {formatNumber(it.value)}
                  <span className="ml-1 text-te-light-gray">·{pct}%</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </Section>
  );
}

function FacetSavedEquivalent({ savedMs }: { savedMs: number }) {
  const { t } = useTranslation();
  const hoursStr = formatHoursLong(savedMs);
  const podcasts = Math.max(0, Math.round(savedMs / (45 * 60_000)));
  const coffees = Math.max(0, Math.round(savedMs / (10 * 60_000)));
  const pages = Math.max(0, Math.round(savedMs / 72_000));
  const items = [
    { icon: Hourglass, key: "typing_hours", value: hoursStr },
    { icon: Sparkles, key: "podcasts", value: String(podcasts) },
    { icon: Sparkles, key: "coffees", value: String(coffees) },
    { icon: Sparkles, key: "books_pages", value: String(pages) },
  ];
  return (
    <Section
      title={t("pages:home.stats_dialog.facet.saved_equivalent.title")}
      hint={t("pages:home.stats_dialog.facet.saved_equivalent.hint")}
    >
      <ul className="grid grid-cols-2 gap-2">
        {items.map((it) => {
          const Icon = it.icon;
          return (
            <li
              key={it.key}
              className="flex items-center gap-2 border border-te-gray/40 bg-te-surface px-3 py-2"
            >
              <Icon className="size-3.5 shrink-0 text-te-accent" />
              <span className="font-mono text-[11px] tracking-tight text-te-fg">
                {t(
                  `pages:home.stats_dialog.facet.saved_equivalent.items.${it.key}`,
                  { value: it.value },
                )}
              </span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}
