import { create } from "zustand";
import { db } from "@/lib/db";
import { newId } from "@/lib/ids";
import { transcribeRecordingFile } from "@/lib/stt";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";

/** 未登录拦截：所有"调云端能力"的操作走这里抛出，UI 层捕获后弹登录框。 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super("not authenticated");
    this.name = "NotAuthenticatedError";
  }
}

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
  /** 正在 retry 的记录 id 集合，UI 显示 loading 态。 */
  retryingIds: Set<string>;
  init: () => Promise<void>;
  reload: () => Promise<void>;
  add: (input: HistoryInput) => Promise<HistoryItem>;
  remove: (id: string) => Promise<void>;
  clearAll: () => Promise<void>;
  /**
   * 重试一条失败 / 取消的转写。Rust 端按 duration_ms 自动选 OL-TL-003 / OL-TL-004。
   * 成功时把 text/status 写回 DB 并刷新内存列表；失败抛错给 UI 层做 toast。
   */
  retry: (id: string) => Promise<void>;
}

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  items: [],
  loaded: false,
  retryingIds: new Set<string>(),

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

  retry: async (id) => {
    const target = get().items.find((it) => it.id === id);
    if (!target) throw new Error("记录不存在");
    if (!target.audio_path) throw new Error("该记录没有保存音频，无法重试");

    if (!useAuthStore.getState().isAuthenticated) {
      useUIStore.getState().openLogin();
      throw new NotAuthenticatedError();
    }

    const markRetry = (active: boolean) => {
      const next = new Set(get().retryingIds);
      if (active) next.add(id);
      else next.delete(id);
      set({ retryingIds: next });
    };

    markRetry(true);
    try {
      const r = await transcribeRecordingFile({
        audioPath: target.audio_path,
        durationMs: target.duration_ms,
      });
      const text = r.text ?? "";
      const d = await db();
      await d.execute(
        "UPDATE history SET text = $1, status = 'success', error = NULL WHERE id = $2",
        [text, id],
      );
      set({
        items: get().items.map((it) =>
          it.id === id ? { ...it, text, status: "success", error: null } : it,
        ),
      });
    } catch (e) {
      // Rust 侧 token 过期 / 启动期未恢复 → 同样兜底弹登录框，避免用户面对无意义错误。
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("not authenticated")) {
        useUIStore.getState().openLogin();
        throw new NotAuthenticatedError();
      }
      throw e;
    } finally {
      markRetry(false);
    }
  },
}));
