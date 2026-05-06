import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion, AnimatePresence } from "framer-motion";
import { BarChart3, Hourglass, Sparkles } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { StatsMetric } from "@/stores/ui";
import { useHistoryStore } from "@/stores/history";
import {
  aggregate,
  type AppRow,
  type HeatCell,
  type Range,
  type StatsBundle,
  type WpmByMode,
} from "@/lib/statsAggregator";
import { TYPING_BASELINE_WPM } from "@/lib/wordCount";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  focusMetric: StatsMetric;
};

const METRIC_INDEX: Record<StatsMetric, string> = {
  duration: "01",
  words: "02",
  wpm: "03",
  saved: "04",
  sessions: "05",
};

const RANGE_ORDER: Range[] = ["today", "7d", "30d", "90d", "all"];
const RANGE_DAYS: Record<Range, number> = {
  today: 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
  all: 365,
};

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

  const items = useHistoryStore((s) => s.items);
  const unknownLabel = t("pages:home.stats_dialog.facet.top_apps.unknown");
  const stats = useMemo(
    () => aggregate(items, range, unknownLabel),
    [items, range, unknownLabel],
  );
  const empty = stats.totals.sessions === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex h-[82vh] w-[92vw] max-w-5xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-5xl"
      >
        <DialogHeader className="flex flex-row items-baseline gap-3 border-b border-te-dialog-border bg-te-surface-hover px-5 py-3">
          <BarChart3
            className="size-4 shrink-0 translate-y-0.5 self-center text-te-accent"
            aria-hidden
          />
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("pages:home.stats_dialog.title")}
          </DialogTitle>
          <DialogDescription className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("pages:home.stats_dialog.subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* KPI strip — clickable; the active cell drives main panel + facets */}
          <KpiStrip stats={stats} focused={metric} onSelect={setMetric} />

          {/* Range only — metric switching now lives in the KPI strip */}
          <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-te-gray/30 bg-te-bg/40 px-5 py-3">
            <RangeSwitcher value={range} onChange={setRange} />
          </div>

          {/* Main + facets */}
          <div className="flex flex-col gap-4 px-5 py-5">
            {empty ? (
              <div className="flex min-h-[20rem] items-center justify-center border border-dashed border-te-gray/40 bg-te-surface/30">
                <span className="font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
                  {t("pages:home.stats_dialog.empty")}
                </span>
              </div>
            ) : (
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
            )}
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
  stats: StatsBundle;
  focused: StatsMetric;
  onSelect: (m: StatsMetric) => void;
}) {
  const { t } = useTranslation();
  const cells: Array<{ key: StatsMetric; value: string; unit: string }> = [
    {
      key: "duration",
      value: formatHHMM(stats.totals.durationMs),
      unit: t("pages:home.stats.duration_unit"),
    },
    {
      key: "words",
      value: formatNumber(stats.totals.words),
      unit: t("pages:home.stats.words_unit"),
    },
    {
      key: "wpm",
      value: stats.totals.wpm > 0 ? String(stats.totals.wpm) : "—",
      unit: t("pages:home.stats.wpm_unit"),
    },
    {
      key: "saved",
      value: formatHHMM(stats.totals.savedMs),
      unit: t("pages:home.stats.saved_unit"),
    },
    {
      key: "sessions",
      value: formatNumber(stats.totals.sessions),
      unit: "",
    },
  ];
  return (
    <div className="grid shrink-0 grid-cols-5 gap-px bg-te-gray/40">
      {cells.map((cell) => {
        const active = cell.key === focused;
        return (
          <button
            key={cell.key}
            type="button"
            onClick={() => onSelect(cell.key)}
            aria-pressed={active}
            className={cn(
              "relative flex cursor-pointer flex-col gap-1.5 px-4 py-3 text-left transition-colors focus:outline-none",
              active ? "bg-te-bg" : "bg-te-surface hover:bg-te-surface-hover",
            )}
          >
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
  stats: StatsBundle;
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
      ) : metric === "saved" ? (
        <DailyBars stats={stats} field="saved" />
      ) : (
        <DailyBars stats={stats} field="sessions" />
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
  stats: StatsBundle;
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
  if (metric === "saved") {
    return (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <FacetSavedEquivalent savedMs={stats.totals.savedMs} />
        <FacetTopApps apps={stats.topApps} valueKey="duration" />
      </div>
    );
  }
  // sessions：用次数比例 + 活跃时段呈现"频次"主题
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <FacetSessionDist dist={stats.sessionDist} />
      <FacetHeatmap heat={stats.heat} />
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
// Charts — recharts (BarChart / LineChart) with TE-themed tooltip
// ────────────────────────────────────────────────────────────────

type DailyField = "duration" | "words" | "saved" | "sessions" | "wpm";

function tooltipDisplay(value: number, field: DailyField): { value: string; unit: string } {
  if (field === "duration" || field === "saved") {
    return { value: formatHoursLong(value), unit: "" };
  }
  if (field === "wpm") {
    return { value: String(Math.round(value)), unit: "wpm" };
  }
  if (field === "sessions") {
    return { value: formatNumber(value), unit: "" };
  }
  return { value: formatNumber(value), unit: "" };
}

interface RechartsTooltipPayloadEntry {
  value?: number | string;
  payload?: { value?: number | string };
}

function ChartTooltip({
  active,
  payload,
  label,
  field,
}: {
  active?: boolean;
  payload?: RechartsTooltipPayloadEntry[];
  label?: string | number;
  field: DailyField;
}) {
  if (!active || !payload || payload.length === 0) return null;
  const raw = payload[0]?.value ?? payload[0]?.payload?.value ?? 0;
  const v = typeof raw === "number" ? raw : Number(raw) || 0;
  const { value: display, unit } = tooltipDisplay(v, field);
  return (
    <div className="border border-te-gray bg-te-bg px-3 py-2 font-mono text-[10px] uppercase tracking-widest shadow-lg">
      <div className="text-te-light-gray">{String(label ?? "")}</div>
      <div className="mt-0.5 flex items-baseline gap-1 text-te-fg">
        <span className="font-bold tabular-nums">{display}</span>
        {unit ? <span className="text-te-light-gray">{unit}</span> : null}
      </div>
    </div>
  );
}

function DailyBars({
  stats,
  field,
}: {
  stats: StatsBundle;
  field: "duration" | "words" | "saved" | "sessions";
}) {
  const data = stats.daily.map((d) => ({
    bucket: d.bucket,
    value:
      field === "duration"
        ? d.durationMs
        : field === "words"
          ? d.words
          : field === "sessions"
            ? d.sessions
            : Math.max(
                0,
                (d.words / TYPING_BASELINE_WPM) * 60_000 - d.durationMs,
              ),
  }));
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          data={data}
          margin={{ top: 4, right: 4, bottom: 4, left: 4 }}
        >
          <CartesianGrid
            stroke="var(--te-gray)"
            strokeOpacity={0.4}
            strokeDasharray="2 3"
            vertical={false}
          />
          <XAxis dataKey="bucket" hide />
          <YAxis hide domain={[0, "dataMax"]} />
          <Tooltip
            cursor={{ fill: "var(--te-accent)", fillOpacity: 0.12 }}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={
                  props.payload as unknown as RechartsTooltipPayloadEntry[]
                }
                label={props.label as string | number | undefined}
                field={field}
              />
            )}
            wrapperStyle={{ outline: "none" }}
          />
          <Bar
            dataKey="value"
            fill="var(--te-accent)"
            isAnimationActive={false}
          />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function WpmLine({ stats }: { stats: StatsBundle }) {
  const data = stats.daily.map((d) => ({
    bucket: d.bucket,
    value:
      d.durationMs > 0 ? Math.round(d.words / (d.durationMs / 60_000)) : 0,
  }));
  return (
    <div className="h-44 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart
          data={data}
          margin={{ top: 8, right: 4, bottom: 4, left: 4 }}
        >
          <CartesianGrid
            stroke="var(--te-gray)"
            strokeOpacity={0.4}
            strokeDasharray="2 3"
            vertical={false}
          />
          <XAxis dataKey="bucket" hide />
          <YAxis hide domain={[0, "dataMax"]} />
          <Tooltip
            cursor={{
              stroke: "var(--te-accent)",
              strokeOpacity: 0.5,
              strokeDasharray: "2 2",
            }}
            content={(props) => (
              <ChartTooltip
                active={props.active}
                payload={
                  props.payload as unknown as RechartsTooltipPayloadEntry[]
                }
                label={props.label as string | number | undefined}
                field="wpm"
              />
            )}
            wrapperStyle={{ outline: "none" }}
          />
          <Line
            type="monotone"
            dataKey="value"
            stroke="var(--te-accent)"
            strokeWidth={1.5}
            dot={
              data.length <= 60
                ? { r: 1.5, fill: "var(--te-accent)", stroke: "none" }
                : false
            }
            activeDot={{ r: 3, fill: "var(--te-accent)", stroke: "none" }}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
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
                      title={`${weekdays[w]} ${String(h).padStart(2, "0")}:00 · ${
                        cell?.value ?? 0
                      } sessions`}
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
          const tip = `${a.name} · ${formatHoursLong(a.durationMs)} · ${formatNumber(a.words)} 字 · ${a.sessions} sessions`;
          return (
            <div
              key={i}
              className="grid grid-cols-[6rem_1fr_4.5rem] items-center gap-2"
              title={tip}
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
