import { create } from "zustand";
import { db } from "@/lib/db";
import { newId } from "@/lib/ids";
import { deleteRecordingFile } from "@/lib/audio";
import { refineSpeechText, transcribeRecordingFile } from "@/lib/stt";
import {
  getHotwordsForRefine,
  rememberHotwordsCacheId,
} from "@/lib/hotwordsCache";
import { buildRefineContext } from "@/lib/refineContext";
import { useAuthStore } from "@/stores/auth";
import {
  useSettingsStore,
  type HistoryRetention,
} from "@/stores/settings";
import { useUIStore } from "@/stores/ui";

const DAY_MS = 24 * 60 * 60 * 1000;

// 把 retention 选项换算成"过期 cutoff_ms"。forever / off 不做时间裁剪。
function retentionCutoffMs(r: HistoryRetention): number | null {
  switch (r) {
    case "7d":
      return Date.now() - 7 * DAY_MS;
    case "30d":
      return Date.now() - 30 * DAY_MS;
    case "90d":
      return Date.now() - 90 * DAY_MS;
    default:
      return null;
  }
}

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
  /** OL-TL-005 整理后的书面化文本；仅 AI_REFINE 模式产生，其它模式为 null。 */
  refined_text?: string | null;
  status: HistoryStatus;
  error?: string | null;
  duration_ms: number;
  created_at: number; // unix ms（与 id 前缀保持一致时间轴）
  target_app?: string | null;
  /**
   * 录音文件的**相对路径**（相对 app_data_dir）。
   * 新版录音落地为 OGG Vorbis（"recordings/<id>.ogg"）；迁移前老记录仍是
   * `.wav`（16-bit PCM），读取 / 导出 / 重转写都同时兼容两种后缀。
   * null 表示无录音文件（cancelled / 录音失败 / 用户关闭了保存音频）。
   * 物理文件写入由 Rust 录音管线负责（task #13），DB 只记录引用。
   */
  audio_path?: string | null;
}

/** 新增一条记录时的入参；id 与 created_at 由 store 生成。 */
export interface HistoryInput {
  type: HistoryType;
  text: string;
  refined_text?: string | null;
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
  refined_text: string | null;
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
    refined_text: r.refined_text,
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
  setRefinedText: (id: string, refined: string) => Promise<void>;
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
    // 启动期 sweep：retention 缩短只在下次启动生效（docs/history.md），这里就是
    // 那个"下次启动"。settings.init 必须先跑完，否则读到的是默认值。
    const retention = useSettingsStore.getState().general.historyRetention;
    const cutoff = retentionCutoffMs(retention);
    if (cutoff !== null) {
      try {
        const d = await db();
        const expired = await d.select<{ audio_path: string | null }[]>(
          "SELECT audio_path FROM history WHERE created_at < $1",
          [cutoff],
        );
        await d.execute("DELETE FROM history WHERE created_at < $1", [cutoff]);
        // WAV/OGG 文件逐个 best-effort 删除——单个失败不能阻塞 init。
        for (const row of expired) {
          if (row.audio_path) {
            void deleteRecordingFile(row.audio_path).catch((e) =>
              console.warn("[history] sweep: delete file failed:", row.audio_path, e),
            );
          }
        }
        if (expired.length > 0) {
          console.log(`[history] sweep: deleted ${expired.length} expired records`);
        }
      } catch (e) {
        console.warn("[history] sweep failed:", e);
      }
    }
    await get().reload();
    set({ loaded: true });
  },

  reload: async () => {
    const d = await db();
    const rows = await d.select<Row[]>(
      "SELECT id, type, text, refined_text, status, error, duration_ms, created_at, target_app, audio_path FROM history ORDER BY created_at DESC",
    );
    set({ items: rows.map(rowToItem) });
  },

  add: async (input) => {
    const item: HistoryItem = {
      id: newId(),
      created_at: Date.now(),
      error: input.error ?? null,
      target_app: input.target_app ?? null,
      audio_path: input.audio_path ?? null,
      refined_text: input.refined_text ?? null,
      type: input.type,
      text: input.text,
      status: input.status,
      duration_ms: input.duration_ms,
    };

    // retention='off'：不写 DB，只塞内存；重启后清空，与 docs/history.md 一致。
    // 同时把 audio 文件也删掉——既然不打算长期保留就别留垃圾。
    const retention = useSettingsStore.getState().general.historyRetention;
    if (retention === "off") {
      if (item.audio_path) {
        void deleteRecordingFile(item.audio_path).catch((e) =>
          console.warn("[history] retention=off delete file failed:", e),
        );
      }
      set({ items: [item, ...get().items] });
      return item;
    }

    const d = await db();
    await d.execute(
      "INSERT INTO history (id, type, text, refined_text, status, error, duration_ms, created_at, target_app, audio_path) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)",
      [
        item.id,
        item.type,
        item.text,
        item.refined_text,
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

  /** AI_REFINE 模式异步整理完后回写：仅更新 refined_text，不影响 text/status。 */
  setRefinedText: async (id: string, refined: string) => {
    const d = await db();
    await d.execute("UPDATE history SET refined_text = $1 WHERE id = $2", [refined, id]);
    set({
      items: get().items.map((it) =>
        it.id === id ? { ...it, refined_text: refined } : it,
      ),
    });
  },

  remove: async (id) => {
    const target = get().items.find((it) => it.id === id);
    const d = await db();
    await d.execute("DELETE FROM history WHERE id = $1", [id]);
    set({ items: get().items.filter((it) => it.id !== id) });
    if (target?.audio_path) {
      void deleteRecordingFile(target.audio_path).catch((e) =>
        console.warn("[history] remove: delete file failed:", e),
      );
    }
  },

  clearAll: async () => {
    const paths = get()
      .items.map((it) => it.audio_path)
      .filter((p): p is string => !!p);
    const d = await db();
    await d.execute("DELETE FROM history");
    set({ items: [] });
    for (const p of paths) {
      void deleteRecordingFile(p).catch((e) =>
        console.warn("[history] clearAll: delete file failed:", p, e),
      );
    }
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

      // 跟随当前用户偏好——AI_REFINE 时再调 OL-TL-005 整理；refine 失败回退原文，
      // 与 recording.ts::finalizeAndWriteHistory 的两步行为对齐。
      const segmentMode = useSettingsStore.getState().general.asrSegmentMode;
      let refinedText: string | null = null;
      if (text && segmentMode === "AI_REFINE") {
        const { hotwords, hotwordsCacheId } = getHotwordsForRefine();
        // 重试当前条时把这条排除掉，避免把"自己尚未刷新的旧文本"塞进上下文。
        const referenceContext = buildRefineContext(get().items, {
          excludeId: id,
        });
        try {
          const rr = await refineSpeechText({
            text,
            hotwords: hotwords || undefined,
            hotwordsCacheId,
            referenceContext,
          });
          refinedText = rr.refinedText;
          rememberHotwordsCacheId(hotwords, rr.hotwordsCacheId);
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          if (raw.includes("not authenticated") || raw.includes("unauthorized")) {
            useUIStore.getState().openLogin();
            throw new NotAuthenticatedError();
          }
          console.warn("[history] refine failed, keeping raw transcript:", e);
        }
      }

      const d = await db();
      await d.execute(
        "UPDATE history SET text = $1, refined_text = $2, status = 'success', error = NULL WHERE id = $3",
        [text, refinedText, id],
      );
      set({
        items: get().items.map((it) =>
          it.id === id
            ? { ...it, text, refined_text: refinedText, status: "success", error: null }
            : it,
        ),
      });
    } catch (e) {
      if (e instanceof NotAuthenticatedError) throw e;
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
