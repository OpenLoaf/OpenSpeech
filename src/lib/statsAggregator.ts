import type { HistoryItem } from "@/stores/history";
import { countWords, TYPING_BASELINE_WPM } from "@/lib/wordCount";

export type Range = "today" | "7d" | "30d" | "90d" | "all";

export interface DailyPoint {
  bucket: string;
  durationMs: number;
  words: number;
  sessions: number;
}

export interface HeatCell {
  weekday: number;
  hour: number;
  value: number;
}

export interface AppRow {
  name: string;
  durationMs: number;
  words: number;
  sessions: number;
}

export interface WpmByMode {
  mode: "REALTIME" | "UTTERANCE" | "UNKNOWN";
  wpm: number;
  sessions: number;
}

export interface StatsBundle {
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

const DAY_MS = 24 * 60 * 60 * 1000;

function rangeCutoff(range: Range): number {
  if (range === "all") return 0;
  if (range === "today") {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return Date.now() - days * DAY_MS;
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function isoLocalDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

// JS getDay(): 0=Sun..6=Sat → 0=Mon..6=Sun
function weekdayMonFirst(ts: number): number {
  const d = new Date(ts).getDay();
  return (d + 6) % 7;
}

interface DailyAcc {
  durationMs: number;
  words: number;
  sessions: number;
}

interface AppAcc {
  durationMs: number;
  words: number;
  sessions: number;
}

interface ModeAcc {
  durationMs: number;
  words: number;
  sessions: number;
}

export function aggregate(
  items: HistoryItem[],
  range: Range,
  unknownLabel: string,
): StatsBundle {
  const cutoff = rangeCutoff(range);
  const useHourBucket = range === "today";

  const daily = new Map<string, DailyAcc>();
  const heat = new Map<number, number>(); // key = weekday * 24 + hour
  const apps = new Map<string, AppAcc>();
  const modes = new Map<"REALTIME" | "UTTERANCE" | "UNKNOWN", ModeAcc>();

  let totalDuration = 0;
  let totalWords = 0;
  let totalSessions = 0;
  let shortCount = 0;
  let mediumCount = 0;
  let longCount = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.status !== "success") continue;
    if (it.created_at < cutoff) continue;

    const w = countWords(it.text);
    const dur = it.duration_ms;
    const ts = it.created_at;

    totalDuration += dur;
    totalWords += w;
    totalSessions += 1;

    if (w <= 20) shortCount += 1;
    else if (w <= 100) mediumCount += 1;
    else longCount += 1;

    const d = new Date(ts);
    const hour = d.getHours();
    const bucket = useHourBucket ? pad2(hour) : isoLocalDay(ts);
    const dayAcc = daily.get(bucket);
    if (dayAcc) {
      dayAcc.durationMs += dur;
      dayAcc.words += w;
      dayAcc.sessions += 1;
    } else {
      daily.set(bucket, { durationMs: dur, words: w, sessions: 1 });
    }

    const wd = weekdayMonFirst(ts);
    const heatKey = wd * 24 + hour;
    heat.set(heatKey, (heat.get(heatKey) ?? 0) + 1);

    const appName = it.target_app && it.target_app.length > 0 ? it.target_app : unknownLabel;
    const appAcc = apps.get(appName);
    if (appAcc) {
      appAcc.durationMs += dur;
      appAcc.words += w;
      appAcc.sessions += 1;
    } else {
      apps.set(appName, { durationMs: dur, words: w, sessions: 1 });
    }

    const modeKey: "REALTIME" | "UTTERANCE" | "UNKNOWN" = it.segment_mode ?? "UNKNOWN";
    const modeAcc = modes.get(modeKey);
    if (modeAcc) {
      modeAcc.durationMs += dur;
      modeAcc.words += w;
      modeAcc.sessions += 1;
    } else {
      modes.set(modeKey, { durationMs: dur, words: w, sessions: 1 });
    }
  }

  const dailyArr: DailyPoint[] = [];
  const dailyKeys = Array.from(daily.keys()).sort();
  for (const k of dailyKeys) {
    const v = daily.get(k)!;
    dailyArr.push({ bucket: k, durationMs: v.durationMs, words: v.words, sessions: v.sessions });
  }

  const heatArr: HeatCell[] = [];
  for (let wd = 0; wd < 7; wd++) {
    for (let h = 0; h < 24; h++) {
      heatArr.push({ weekday: wd, hour: h, value: heat.get(wd * 24 + h) ?? 0 });
    }
  }

  const topApps: AppRow[] = Array.from(apps.entries())
    .map(([name, v]) => ({ name, durationMs: v.durationMs, words: v.words, sessions: v.sessions }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 6);

  const wpmByMode: WpmByMode[] = Array.from(modes.entries()).map(([mode, v]) => ({
    mode,
    wpm: v.durationMs > 0 ? Math.round(v.words / (v.durationMs / 60000)) : 0,
    sessions: v.sessions,
  }));

  const totalsWpm =
    totalDuration > 0 ? Math.round(totalWords / (totalDuration / 60000)) : 0;
  const savedMs = Math.max(0, (totalWords / TYPING_BASELINE_WPM) * 60_000 - totalDuration);

  return {
    daily: dailyArr,
    heat: heatArr,
    topApps,
    wpmByMode,
    sessionDist: { short: shortCount, medium: mediumCount, long: longCount },
    totals: {
      durationMs: totalDuration,
      words: totalWords,
      sessions: totalSessions,
      wpm: totalsWpm,
      savedMs,
    },
  };
}
