import { useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { PulsarGrid } from "@/components/PulsarGrid";
import { HotkeyDictationCard } from "@/components/HotkeyDictationCard";
import { useHistoryStore } from "@/stores/history";
import { countWords, TYPING_BASELINE_WPM } from "@/lib/wordCount";
import { useStatsStore } from "@/stores/stats";
import { useUIStore, type StatsMetric } from "@/stores/ui";
import { notifyHomeActivated } from "@/lib/updateScheduler";

type StatsView = "today" | "all";

function todayMidnightLocal(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function formatHHMM(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "00:00";
  const totalMinutes = Math.floor(ms / 60_000);
  const hh = Math.floor(totalMinutes / 60);
  const mm = totalMinutes % 60;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

/* ──────────────────────────────────────────────────────────────── */
/*  Stat card                                                        */
/* ──────────────────────────────────────────────────────────────── */

type StatProps = {
  index: string;
  label: string;
  value: string;
  unit?: string;
  onClick?: () => void;
  ariaLabel?: string;
};

function StatCard({ index, label, value, unit, onClick, ariaLabel }: StatProps) {
  return (
    <motion.button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4 }}
      className="group flex h-full cursor-pointer flex-col justify-between border border-te-gray/60 bg-te-surface p-4 text-left transition-colors hover:border-te-accent focus:outline-none focus-visible:border-te-accent"
    >
      <div className="flex items-start justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
          {label}
        </span>
        <span className="font-mono text-[10px] text-te-light-gray transition-colors group-hover:text-te-accent">
          {index}
        </span>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
          {value}
        </span>
        {unit ? (
          <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
            {unit}
          </span>
        ) : null}
      </div>
    </motion.button>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Page                                                             */
/* ──────────────────────────────────────────────────────────────── */

export default function HomePage() {
  const { t } = useTranslation();

  const historyItems = useHistoryStore((s) => s.items);
  const cachedDuration = useStatsStore((s) => s.totalDurationMs);
  const cachedWords = useStatsStore((s) => s.totalWords);
  const openStats = useUIStore((s) => s.openStats);
  const [view, setView] = useState<StatsView>("all");

  // Home 页激活即触发一次更新检查并启动 5 分钟轮询；scheduler 内部幂等。
  useEffect(() => {
    notifyHomeActivated();
  }, []);

  type CardMetric = Exclude<StatsMetric, "sessions">;
  const cardLabels: Record<CardMetric, string> = {
    duration: t("pages:home.stats.duration_label"),
    words: t("pages:home.stats.words_label"),
    wpm: t("pages:home.stats.wpm_label"),
    saved: t("pages:home.stats.saved_label"),
  };
  const aria = (m: CardMetric) =>
    t("pages:home.stats.open_dialog_aria", { label: cardLabels[m] });

  // "今日"实时扫 historyItems；"历史"= stats 缓存 + 今日实时增量
  // （缓存只到上次 init/bump 时刻，今日新发生的会话也得叠加进来）。
  const stats = useMemo(() => {
    const since = todayMidnightLocal();
    let todayDurationMs = 0;
    let todayWords = 0;
    for (const it of historyItems) {
      if (it.created_at < since) continue;
      if (it.type !== "dictation" || it.status !== "success") continue;
      todayDurationMs += it.duration_ms;
      todayWords += countWords(it.text);
    }

    const totalDurationMs = view === "today" ? todayDurationMs : cachedDuration;
    const totalWords = view === "today" ? todayWords : cachedWords;
    const minutes = totalDurationMs / 60_000;
    const wpmValue = minutes > 0 ? totalWords / minutes : 0;
    const savedMs = Math.max(
      0,
      (totalWords / TYPING_BASELINE_WPM) * 60_000 - totalDurationMs,
    );
    return {
      duration: formatHHMM(totalDurationMs),
      words: new Intl.NumberFormat().format(totalWords),
      wpm: minutes > 0 ? String(Math.round(wpmValue)) : "—",
      saved: formatHHMM(savedMs),
    };
  }, [historyItems, cachedDuration, cachedWords, view]);

  return (
    <section className="relative flex h-full flex-col overflow-hidden bg-te-bg">
      <div className="pointer-events-none absolute inset-0">
        <PulsarGrid />
      </div>

      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 90% 70% at 50% 45%, transparent 30%, var(--te-bg) 95%)",
        }}
      />

      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden px-[clamp(1rem,4vw,2.5rem)] pt-[clamp(0.5rem,2vh,1.5rem)] pb-[clamp(1rem,3vw,2rem)]">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col gap-[clamp(0.75rem,2.5vh,1.75rem)]">
          {/* HERO */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="flex min-h-0 flex-[3_1_0%] flex-col gap-4 pb-[clamp(1rem,3vh,2rem)]"
          >
            <h1 className="font-mono text-[clamp(1.75rem,5.5vw,4.5rem)] font-bold leading-[0.95] tracking-tighter text-te-fg">
              {t("pages:home.hero.title_line1")}
              <br />
              <span className="text-te-accent">
                {t("pages:home.hero.title_line2")}
              </span>
            </h1>

            <p className="max-w-xl font-sans text-sm leading-relaxed text-te-light-gray md:text-base">
              {t("pages:home.hero.description")}
            </p>
          </motion.div>

          {/* HOTKEY CARD */}
          <div className="flex min-h-0 flex-[4_1_0%] items-stretch overflow-hidden">
            <HotkeyDictationCard />
          </div>

          {/* STATS */}
          <div className="flex min-h-0 flex-[3_1_0%] flex-col">
            <div className="mb-2 flex shrink-0 items-end justify-between md:mb-3">
              <h2 className="font-mono text-base font-bold uppercase tracking-tighter text-te-fg md:text-lg">
                {view === "today"
                  ? t("pages:home.stats.section_title_today")
                  : t("pages:home.stats.section_title_all")}
              </h2>
              <div
                className="flex shrink-0 border border-te-gray/60 bg-te-surface font-mono text-[10px] uppercase tracking-widest"
                role="tablist"
              >
                {(["today", "all"] as const).map((mode) => {
                  const active = view === mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="tab"
                      aria-selected={active}
                      onClick={() => setView(mode)}
                      className={
                        active
                          ? "px-2.5 py-1 bg-te-accent text-te-bg"
                          : "px-2.5 py-1 text-te-light-gray hover:text-te-fg"
                      }
                    >
                      {t(`pages:home.stats.tab_${mode}`)}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-4 gap-px bg-te-gray/40">
              <StatCard
                index="01"
                label={cardLabels.duration}
                value={stats.duration}
                unit={t("pages:home.stats.duration_unit")}
                onClick={() => openStats("duration")}
                ariaLabel={aria("duration")}
              />
              <StatCard
                index="02"
                label={cardLabels.words}
                value={stats.words}
                unit={t("pages:home.stats.words_unit")}
                onClick={() => openStats("words")}
                ariaLabel={aria("words")}
              />
              <StatCard
                index="03"
                label={cardLabels.wpm}
                value={stats.wpm}
                unit={t("pages:home.stats.wpm_unit")}
                onClick={() => openStats("wpm")}
                ariaLabel={aria("wpm")}
              />
              <StatCard
                index="04"
                label={cardLabels.saved}
                value={stats.saved}
                unit={t("pages:home.stats.saved_unit")}
                onClick={() => openStats("saved")}
                ariaLabel={aria("saved")}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
