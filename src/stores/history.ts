import { create } from "zustand";
import { db } from "@/lib/db";
import { newId } from "@/lib/ids";

export type HistoryType = "dictation" | "ask" | "translate";
export type HistoryStatus = "success" | "failed" | "cancelled";

export interface HistoryItem {
  id: string;
  type: HistoryType;
  text: string;
  status: HistoryStatus;
  error?: string | null;
  duration_ms: number;
  created_at: number; // unix ms（与 id 前缀保持一致时间轴）
  target_app?: string | null;
  /**
   * 录音 WAV 文件的**相对路径**（相对 app_data_dir，如 "recordings/<id>.wav"）。
   * null 表示无录音文件（cancelled / 录音失败 / 用户关闭了保存音频）。
   * 物理文件写入由 Rust 录音管线负责（task #13），DB 只记录引用。
   */
  audio_path?: string | null;
}

/** 新增一条记录时的入参；id 与 created_at 由 store 生成。 */
export interface HistoryInput {
  type: HistoryType;
  text: string;
  status: HistoryStatus;
  error?: string | null;
  duration_ms: number;
  target_app?: string | null;
  audio_path?: string | null;
}

// SQLite 取出来的原始行（bind 会回 camelCase 的字段，这里统一保留 snake_case）。
interface Row {
  id: string;
  type: HistoryType;
  text: string;
  status: HistoryStatus;
  error: string | null;
  duration_ms: number;
  created_at: number;
  target_app: string | null;
  audio_path: string | null;
}

function rowToItem(r: Row): HistoryItem {
  return {
    id: r.id,
    type: r.type,
    text: r.text,
    status: r.status,
    error: r.error,
    duration_ms: r.duration_ms,
    created_at: r.created_at,
    target_app: r.target_app,
    audio_path: r.audio_path,
  };
}

interface HistoryStore {
  items: HistoryItem[];
  loaded: boolean;
  init: () => Promise<void>;
  reload: () => Promise<void>;
  add: (input: HistoryInput) => Promise<HistoryItem>;
  remove: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  items: [],
  loaded: false,

  init: async () => {
    if (get().loaded) return;
    await get().reload();
    set({ loaded: true });
  },

  reload: async () => {
    const d = await db();
    const rows = await d.select<Row[]>(
      "SELECT id, type, text, status, error, duration_ms, created_at, target_app, audio_path FROM history ORDER BY created_at DESC",
    );
    set({ items: rows.map(rowToItem) });
  },

  add: async (input) => {
    const d = await db();
    const item: HistoryItem = {
      id: newId(),
      created_at: Date.now(),
      error: input.error ?? null,
      target_app: input.target_app ?? null,
      audio_path: input.audio_path ?? null,
      type: input.type,
      text: input.text,
      status: input.status,
      duration_ms: input.duration_ms,
    };
    await d.execute(
      "INSERT INTO history (id, type, text, status, error, duration_ms, created_at, target_app, audio_path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
      [
        item.id,
        item.type,
        item.text,
        item.status,
        item.error,
        item.duration_ms,
        item.created_at,
        item.target_app,
        item.audio_path,
      ],
    );
    set({ items: [item, ...get().items] });
    return item;
  },

  remove: async (id) => {
    const d = await db();
    await d.execute("DELETE FROM history WHERE id = $1", [id]);
    set({ items: get().items.filter((it) => it.id !== id) });
  },

  clearAll: async () => {
    const d = await db();
    await d.execute("DELETE FROM history");
    set({ items: [] });
  },
}));
