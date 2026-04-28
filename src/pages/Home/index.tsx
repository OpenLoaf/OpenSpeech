import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { PulsarGrid } from "@/components/PulsarGrid";
import { HotkeyPreview } from "@/components/HotkeyPreview";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { cn } from "@/lib/utils";
import { useRecordingStore, type RecordingState } from "@/stores/recording";
import { useHistoryStore } from "@/stores/history";

// 假设打字基线速度：用于"节省时间"估算。40 WPM 是普通用户中位打字速度。
// （专业打字员 ~70+，纯中文拼音 ~30，混合 ~40）；该值为粗估，未来可放设置项。
const TYPING_BASELINE_WPM = 40;

function todayMidnightLocal(): number {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// 中英文混合字数：中文逐字算 1，连续拉丁/数字序列算 1 个词。
// 注意 WPM 也用同一口径，避免单位不一致。
function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[一-鿿]|[A-Za-z0-9][A-Za-z0-9'_-]*/g);
  return matches ? matches.length : 0;
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
};

function StatCard({ index, label, value, unit }: StatProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4 }}
      className="group flex h-full flex-col justify-between border border-te-gray/60 bg-te-surface p-4 transition-colors hover:border-te-accent"
    >
      <div className="flex items-start justify-between">
        <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
          {label}
        </span>
        <span className="font-mono text-[10px] text-te-light-gray">
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
    </motion.div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Page                                                             */
/* ──────────────────────────────────────────────────────────────── */

export default function HomePage() {
  const { t } = useTranslation();
  const recState = useRecordingStore((s) => s.state);
  const audioLevels = useRecordingStore((s) => s.audioLevels);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const isLive = recState !== "idle";

  // 录音结束后保留最近一次结果——FSM 走完 injecting 会把 liveTranscript 清空，
  // 直接拿就拿到空串。这里在 active 阶段把最新非空 transcript 缓到 ref，
  // 检测到 active → idle 过渡时落到 resultText 让面板继续显示，等用户点 ✕
  // 或再次按快捷键开始新一轮。
  const [resultText, setResultText] = useState<string | null>(null);
  const lastTranscriptRef = useRef("");
  const prevStateRef = useRef<RecordingState>("idle");

  useEffect(() => {
    if (liveTranscript) lastTranscriptRef.current = liveTranscript;
  }, [liveTranscript]);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = recState;
    if (prev === "idle" && recState !== "idle") {
      setResultText(null);
      lastTranscriptRef.current = "";
      return;
    }
    if (prev !== "idle" && recState === "idle") {
      const captured = lastTranscriptRef.current.trim();
      setResultText(captured ? lastTranscriptRef.current : null);
    }
  }, [recState]);

  const showResult = !isLive && resultText !== null;
  const showPanel = isLive || showResult;
  const panelTranscript = isLive ? liveTranscript : (resultText ?? "");

  const historyItems = useHistoryStore((s) => s.items);
  const stats = useMemo(() => {
    const since = todayMidnightLocal();
    let totalDurationMs = 0;
    let totalWords = 0;
    for (const it of historyItems) {
      if (it.created_at < since) continue;
      if (it.type !== "dictation" || it.status !== "success") continue;
      totalDurationMs += it.duration_ms;
      totalWords += countWords(it.text);
    }
    const minutes = totalDurationMs / 60_000;
    const wpmValue = minutes > 0 ? totalWords / minutes : 0;
    // 节省时间 = 同字数按 baseline 打字耗时 - 实际口述耗时；负值 clamp 到 0。
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
  }, [historyItems]);

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

      <div className="relative z-10 flex min-h-0 flex-1 overflow-hidden px-[clamp(1rem,4vw,2.5rem)] pt-[clamp(2rem,6vh,5rem)] pb-[clamp(1rem,3vw,2rem)]">
        <div className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col">
          {/* HERO */}
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5 }}
            className="flex min-h-0 flex-[4_1_0%] flex-col justify-between"
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

            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
              <img
                src="/logo-write.png"
                alt=""
                aria-hidden
                draggable={false}
                className="size-5 shrink-0 select-none"
              />
              <span>{t("pages:home.hero.feature_push_to_talk")}</span>
              <span>{t("pages:home.hero.feature_byo")}</span>
              <span>{t("pages:home.hero.feature_cross_platform")}</span>
            </div>
          </motion.div>

          {/* HOTKEY CARD */}
          <div className="flex min-h-0 flex-[3_1_0%] items-center">
            <motion.div
              initial={{ opacity: 0, y: 16 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.4, delay: 0.03 }}
              className={cn(
                "w-full border bg-te-surface p-4 transition-colors md:p-5",
                isLive ? "border-te-accent/80" : "border-te-gray/60",
              )}
            >
              <AnimatePresence mode="wait" initial={false}>
                {showPanel ? (
                  <motion.div
                    key="live"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                  >
                    <LiveDictationPanel
                      state={recState}
                      audioLevels={audioLevels}
                      liveTranscript={panelTranscript}
                      onClose={showResult ? () => setResultText(null) : undefined}
                    />
                  </motion.div>
                ) : (
                  <motion.div
                    key="preview"
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -4 }}
                    transition={{ duration: 0.18 }}
                  >
                    <HotkeyPreview />
                    <p className="mt-3 max-w-2xl font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
                      <Trans
                        i18nKey="pages:home.hotkey_hint"
                        components={{
                          esc: <span className="mx-1 font-mono text-te-fg" />,
                        }}
                      />
                    </p>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          </div>

          {/* STATS */}
          <div className="flex min-h-0 flex-[3_1_0%] flex-col">
            <div className="mb-2 flex shrink-0 items-end justify-between md:mb-3">
              <h2 className="font-mono text-base font-bold uppercase tracking-tighter text-te-fg md:text-lg">
                {t("pages:home.stats.section_title")}
              </h2>
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                {t("pages:home.stats.live_metrics")}
              </span>
            </div>

            <div className="grid min-h-0 flex-1 grid-cols-4 gap-px bg-te-gray/40">
              <StatCard
                index="01"
                label={t("pages:home.stats.duration_label")}
                value={stats.duration}
                unit={t("pages:home.stats.duration_unit")}
              />
              <StatCard
                index="02"
                label={t("pages:home.stats.words_label")}
                value={stats.words}
                unit={t("pages:home.stats.words_unit")}
              />
              <StatCard
                index="03"
                label={t("pages:home.stats.wpm_label")}
                value={stats.wpm}
                unit={t("pages:home.stats.wpm_unit")}
              />
              <StatCard
                index="04"
                label={t("pages:home.stats.saved_label")}
                value={stats.saved}
                unit={t("pages:home.stats.saved_unit")}
              />
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
