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

export interface DurationDistBucket {
  key: "lt10s" | "s10_30" | "s30_60" | "s60_120" | "gt120s";
  sessions: number;
}

export interface ProviderRow {
  provider: string;
  sessions: number;
  durationMs: number;
  words: number;
  wpm: number;
}

export interface AsrSourceRow {
  source: string;
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
  durationDist: DurationDistBucket[];
  typeMix: { dictation: number; ask: number; translate: number };
  providerDist: ProviderRow[];
  aiRefineRate: { used: number; total: number; avgRefineMs: number };
  statusMix: { success: number; failed: number; cancelled: number };
  asrSourceDist: AsrSourceRow[];
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

interface ProviderAcc {
  durationMs: number;
  words: number;
  sessions: number;
}

type DurationKey = DurationDistBucket["key"];

function durationBucket(dur: number): DurationKey {
  if (dur < 10_000) return "lt10s";
  if (dur < 30_000) return "s10_30";
  if (dur < 60_000) return "s30_60";
  if (dur < 120_000) return "s60_120";
  return "gt120s";
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
  const providers = new Map<string, ProviderAcc>();
  const durBuckets = new Map<DurationKey, number>();
  const asrSources = new Map<string, number>();

  let totalDuration = 0;
  let totalWords = 0;
  let totalSessions = 0;
  let shortCount = 0;
  let mediumCount = 0;
  let longCount = 0;

  let typeDictation = 0;
  let typeAsk = 0;
  let typeTranslate = 0;

  let statusSuccess = 0;
  let statusFailed = 0;
  let statusCancelled = 0;

  let refineUsed = 0;
  let refineMsSum = 0;
  let refineMsCount = 0;

  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.created_at < cutoff) continue;

    const status = it.status;
    if (status === "success") statusSuccess += 1;
    else if (status === "failed") statusFailed += 1;
    else if (status === "cancelled") statusCancelled += 1;

    const itemType = it.type;
    if (itemType === "dictation") typeDictation += 1;
    else if (itemType === "ask") typeAsk += 1;
    else if (itemType === "translate") typeTranslate += 1;

    const asrKey = it.asr_source ?? "unknown";
    asrSources.set(asrKey, (asrSources.get(asrKey) ?? 0) + 1);

    if (status !== "success") continue;

    const w = countWords(it.text);
    const dur = it.duration_ms;
    const ts = it.created_at;

    totalDuration += dur;
    totalWords += w;
    totalSessions += 1;

    if (w <= 20) shortCount += 1;
    else if (w <= 100) mediumCount += 1;
    else longCount += 1;

    const bKey = durationBucket(dur);
    durBuckets.set(bKey, (durBuckets.get(bKey) ?? 0) + 1);

    const refined = it.refined_text;
    if (refined != null && refined.length > 0) refineUsed += 1;
    const refineMs = it.refine_ms;
    if (refineMs != null) {
      refineMsSum += refineMs;
      refineMsCount += 1;
    }

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

    const provKey = it.provider_kind ?? "unknown";
    const provAcc = providers.get(provKey);
    if (provAcc) {
      provAcc.durationMs += dur;
      provAcc.words += w;
      provAcc.sessions += 1;
    } else {
      providers.set(provKey, { durationMs: dur, words: w, sessions: 1 });
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

  const durationDistOrder: DurationKey[] = ["lt10s", "s10_30", "s30_60", "s60_120", "gt120s"];
  const durationDist: DurationDistBucket[] = durationDistOrder.map((key) => ({
    key,
    sessions: durBuckets.get(key) ?? 0,
  }));

  const providerDist: ProviderRow[] = Array.from(providers.entries())
    .map(([provider, v]) => ({
      provider,
      sessions: v.sessions,
      durationMs: v.durationMs,
      words: v.words,
      wpm: v.durationMs > 0 ? Math.round(v.words / (v.durationMs / 60000)) : 0,
    }))
    .sort((a, b) => b.sessions - a.sessions);

  const asrSourceDist: AsrSourceRow[] = Array.from(asrSources.entries())
    .map(([source, sessions]) => ({ source, sessions }))
    .sort((a, b) => b.sessions - a.sessions);

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
    durationDist,
    typeMix: { dictation: typeDictation, ask: typeAsk, translate: typeTranslate },
    providerDist,
    aiRefineRate: {
      used: refineUsed,
      total: totalSessions,
      avgRefineMs: refineMsCount > 0 ? refineMsSum / refineMsCount : 0,
    },
    statusMix: { success: statusSuccess, failed: statusFailed, cancelled: statusCancelled },
    asrSourceDist,
  };
}
