import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { useHistoryStore } from "@/stores/history";

const STORE_FILE = "stats.json";
const SCHEMA_VERSION = 1;

// 中英文混合字数（与 Home 页同口径）：中文逐字算 1，连续拉丁/数字序列算 1 个词。
function countWords(text: string): number {
  if (!text) return 0;
  const matches = text.match(/[一-鿿]|[A-Za-z0-9][A-Za-z0-9'_-]*/g);
  return matches ? matches.length : 0;
}

interface StatsSnapshot {
  totalDurationMs: number;
  totalWords: number;
  sessionCount: number;
}

interface PersistShape extends StatsSnapshot {
  schemaVersion: number;
  // 仅作"是否已做过首次回扫"的哨兵；0 = 还没初始化过缓存。
  initializedAt: number;
}

const ZERO: StatsSnapshot = { totalDurationMs: 0, totalWords: 0, sessionCount: 0 };

interface StatsState extends StatsSnapshot {
  loaded: boolean;
  init: () => Promise<void>;
  bump: (input: { type: string; status: string; duration_ms: number; text: string }) => Promise<void>;
  reset: () => Promise<void>;
}

let storePromise: Promise<Store> | null = null;
function store(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

async function persist(snap: StatsSnapshot, initializedAt: number): Promise<void> {
  const s = await store();
  const shape: PersistShape = {
    schemaVersion: SCHEMA_VERSION,
    initializedAt,
    ...snap,
  };
  await s.set("stats", shape);
  await s.save();
}

export const useStatsStore = create<StatsState>((set, get) => ({
  ...ZERO,
  loaded: false,

  init: async () => {
    if (get().loaded) return;
    const s = await store();
    const raw = (await s.get<PersistShape>("stats")) ?? null;

    if (raw && typeof raw.initializedAt === "number" && raw.initializedAt > 0) {
      set({
        totalDurationMs: raw.totalDurationMs ?? 0,
        totalWords: raw.totalWords ?? 0,
        sessionCount: raw.sessionCount ?? 0,
        loaded: true,
      });
      return;
    }

    // 首次启用：把 DB 里现存的 success dictation 一次性聚合作为基线。
    // 依赖 useHistoryStore.init() 已完成（main.tsx 启动序列保证）。
    const items = useHistoryStore.getState().items;
    const snap: StatsSnapshot = { ...ZERO };
    for (const it of items) {
      if (it.type !== "dictation" || it.status !== "success") continue;
      snap.totalDurationMs += it.duration_ms;
      snap.totalWords += countWords(it.text);
      snap.sessionCount += 1;
    }
    const initializedAt = Date.now();
    await persist(snap, initializedAt);
    set({ ...snap, loaded: true });
  },

  bump: async (input) => {
    if (input.type !== "dictation" || input.status !== "success") return;
    if (!get().loaded) return; // 还没 init 就别累加，避免与首次回扫双计

    const next: StatsSnapshot = {
      totalDurationMs: get().totalDurationMs + input.duration_ms,
      totalWords: get().totalWords + countWords(input.text),
      sessionCount: get().sessionCount + 1,
    };
    set(next);
    await persist(next, Date.now()).catch((e) =>
      console.warn("[stats] persist failed:", e),
    );
  },

  reset: async () => {
    set({ ...ZERO });
    await persist(ZERO, Date.now()).catch((e) =>
      console.warn("[stats] reset persist failed:", e),
    );
  },
}));
