import { create } from "zustand";
import { db } from "@/lib/db";
import { newId } from "@/lib/ids";
import { deleteRecordingFile } from "@/lib/audio";
import { transcribeRecordingFile } from "@/lib/stt";
import { buildProviderRef } from "@/lib/dictation-provider-ref";
import { resolveDictationLang } from "@/lib/dictation-lang";
import { refineTextViaChatStream } from "@/lib/ai-refine";
import { handleAiRefineCustomFailure } from "@/lib/ai-refine-fallback";
import { getHotwordsArray } from "@/lib/hotwordsCache";
import { useAuthStore } from "@/stores/auth";
import {
  useSettingsStore,
  getEffectiveAiSystemPrompt,
  type HistoryRetention,
} from "@/stores/settings";
import { resolveLang } from "@/i18n";
import i18n from "@/i18n";
import { useUIStore } from "@/stores/ui";
import { useStatsStore } from "@/stores/stats";

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

export type HistoryType = "dictation" | "ask" | "translate" | "meeting";
export type HistoryStatus = "success" | "failed" | "cancelled";

/**
 * 实际调用的 ASR 通道。UI 通过 i18n key 翻译显示：
 * - "saas-realtime"：默认 OpenLoaf SaaS realtime ASR（WebSocket 流式）
 * - "saas-rest"：SaaS REST 文件转写（OL-TL-003）；realtime degrade 与 retry 路径
 * - "byo"：用户自带 STT endpoint
 */
export type AsrSource = "saas-realtime" | "saas-rest" | "byo";

/** 该次记录使用的听写分段模式（与 settings.AsrSegmentMode 对齐）。 */
export type HistorySegmentMode = "REALTIME" | "UTTERANCE";

/**
 * 实际承载本次转写的供应商通道。命名规则 `<vendor>-<channel>`：
 * - saas-realtime / saas-file：OpenLoaf SaaS realtime ASR / 文件转写
 * - tencent-realtime / tencent-file：腾讯 BYOK 实时 / 文件
 * - aliyun-realtime / aliyun-file：阿里 BYOK 实时 / 文件
 * 老条目 / 未识别值显示为 "—"。
 */
export type ProviderKind =
  | "saas-realtime"
  | "saas-file"
  | "tencent-realtime"
  | "tencent-file"
  | "aliyun-realtime"
  | "aliyun-file";

export interface HistoryItem {
  id: string;
  type: HistoryType;
  text: string;
  /** AI 整理后的书面化文本；仅 UTTERANCE + aiRefine.enabled 时产生，否则 null。 */
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
  /** 实际走的 ASR 通道。null = 老记录（schema v3 之前）。 */
  asr_source?: AsrSource | null;
  /**
   * 实际用的 AI 优化模型。预格式化的展示字符串：
   * - "OpenLoaf SaaS"（saas 默认）
   * - "{provider name} · {model}"（自定义 provider）
   * null = 未启用 AI 优化 / 未尝试调用 AI。
   */
  ai_model?: string | null;
  /** 听写分段模式。null = schema v4 之前的老记录。 */
  segment_mode?: HistorySegmentMode | null;
  /** 供应商通道（vendor + 实时/文件）。null = schema v4 之前的老记录。 */
  provider_kind?: ProviderKind | null;
  /** 翻译条目的目标语言代码（如 "en"/"zh"/"ja"）。null = 非翻译条目或 schema v5 之前的老记录。 */
  target_lang?: string | null;
  /** ASR 耗时（ms）：从结束录音到拿到 final transcript。null = schema v7 之前的老记录或失败。 */
  asr_ms?: number | null;
  /** AI refine 耗时（ms）：refine chat stream 整段时长。null = 未启用 refine 或失败。 */
  refine_ms?: number | null;
  /**
   * DEV 构建捕获的 LLM 请求快照（URL / model / body 的 pretty JSON）。
   * 单次 refine 是单个 envelope；翻译模式下是包含 refine + translate 两段的 JSON 数组。
   * 正式版构建恒为 null——不为终端用户落盘 prompt / token 等敏感字段。
   * 历史详情 / 复制按钮直接消费这一列，不再前端实时拼接。
   */
  debug_payload?: string | null;
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
  asr_source?: AsrSource | null;
  ai_model?: string | null;
  segment_mode?: HistorySegmentMode | null;
  provider_kind?: ProviderKind | null;
  target_lang?: string | null;
  asr_ms?: number | null;
  refine_ms?: number | null;
  debug_payload?: string | null;
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
  asr_source: AsrSource | null;
  ai_model: string | null;
  segment_mode: HistorySegmentMode | null;
  provider_kind: ProviderKind | null;
  target_lang: string | null;
  asr_ms: number | null;
  refine_ms: number | null;
  debug_payload: string | null;
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
    asr_source: r.asr_source,
    ai_model: r.ai_model,
    segment_mode: r.segment_mode,
    provider_kind: r.provider_kind,
    target_lang: r.target_lang,
    asr_ms: r.asr_ms,
    refine_ms: r.refine_ms,
    debug_payload: r.debug_payload,
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
  /** DEV 模式：把已捕获的请求 envelope JSON 串落到 history.debug_payload。 */
  setDebugPayload: (id: string, payload: string) => Promise<void>;
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
    // type='meeting' 由 useMeetingsStore 自管列表，不混进听写主历史。
    const rows = await d.select<Row[]>(
      "SELECT id, type, text, refined_text, status, error, duration_ms, created_at, target_app, audio_path, asr_source, ai_model, segment_mode, provider_kind, target_lang, asr_ms, refine_ms, debug_payload FROM history WHERE type != 'meeting' ORDER BY created_at DESC",
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
      asr_source: input.asr_source ?? null,
      ai_model: input.ai_model ?? null,
      segment_mode: input.segment_mode ?? null,
      provider_kind: input.provider_kind ?? null,
      target_lang: input.target_lang ?? null,
      asr_ms: input.asr_ms ?? null,
      refine_ms: input.refine_ms ?? null,
      debug_payload: input.debug_payload ?? null,
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
      void useStatsStore.getState().bump(item);
      return item;
    }

    const d = await db();
    await d.execute(
      "INSERT INTO history (id, type, text, refined_text, status, error, duration_ms, created_at, target_app, audio_path, asr_source, ai_model, segment_mode, provider_kind, target_lang, asr_ms, refine_ms, debug_payload) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)",
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
        item.asr_source,
        item.ai_model,
        item.segment_mode,
        item.provider_kind,
        item.target_lang,
        item.asr_ms,
        item.refine_ms,
        item.debug_payload,
      ],
    );
    set({ items: [item, ...get().items] });
    void useStatsStore.getState().bump(item);
    return item;
  },

  /** refine 异步整理完后回写：仅更新 refined_text，不影响 text/status。 */
  setRefinedText: async (id: string, refined: string) => {
    const d = await db();
    await d.execute("UPDATE history SET refined_text = $1 WHERE id = $2", [refined, id]);
    set({
      items: get().items.map((it) =>
        it.id === id ? { ...it, refined_text: refined } : it,
      ),
    });
  },

  setDebugPayload: async (id: string, payload: string) => {
    const d = await db();
    await d.execute("UPDATE history SET debug_payload = $1 WHERE id = $2", [payload, id]);
    set({
      items: get().items.map((it) =>
        it.id === id ? { ...it, debug_payload: payload } : it,
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
    void useStatsStore.getState().reset();
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
      const settings = useSettingsStore.getState();
      const r = await transcribeRecordingFile({
        audioPath: target.audio_path,
        durationMs: target.duration_ms,
        lang: resolveDictationLang(settings.dictation.lang, settings.general.interfaceLang),
        provider: buildProviderRef(),
      });
      const text = r.text ?? "";
      // retry 永远走 SaaS REST 文件转写，与 recording.ts degrade 路径一致。
      const asrSource: AsrSource = "saas-rest";
      // provider_kind 直接取 Rust dispatch 的真值（saas/tencent/aliyun-file 之一）。
      const providerKind: ProviderKind = r.providerKind;

      // 跟随当前用户偏好——UTTERANCE + aiRefine.enabled 时走新 chat 通道整理；
      // refine 失败回退原文，与 recording.ts::finalizeAndWriteHistory 的两步行为对齐。
      const segmentMode = useSettingsStore.getState().general.asrSegmentMode;
      const refineEnabled =
        segmentMode === "UTTERANCE" &&
        useSettingsStore.getState().aiRefine.enabled === true;
      let refinedText: string | null = null;
      let aiModel: string | null = null;
      let debugPayload: string | null = null;
      if (text && refineEnabled) {
        const aiSettings = useSettingsStore.getState().aiRefine;
        const lang = resolveLang(useSettingsStore.getState().general.interfaceLang);
        const systemPrompt = getEffectiveAiSystemPrompt(aiSettings.customSystemPrompt, lang);
        const hotwords = getHotwordsArray();
        const requestTimeMs = Date.now();
        const requestTime = `${new Date(requestTimeMs).toISOString()} (UTC)`;
        let historyEntries: string[] | undefined;
        if (aiSettings.includeHistory) {
          const minutesAgoLabel = i18n.t("ai.minutes_ago", {
            ns: "settings",
            defaultValue: "minutes ago",
          });
          const lines = get()
            .items.filter((it) => it.id !== id && it.status === "success")
            .slice(0, 5)
            .reverse()
            .map((it) => {
              const content = (it.refined_text ?? it.text ?? "").trim();
              if (!content) return "";
              const mins = Math.max(
                1,
                Math.floor((requestTimeMs - it.created_at) / 60000),
              );
              return `[${mins} ${minutesAgoLabel}] ${content}`;
            })
            .filter((s) => s.length > 0);
          if (lines.length > 0) historyEntries = lines;
        }
        let activeProvider = null as
          | { id: string; name: string; baseUrl: string; model: string }
          | null;
        if (aiSettings.mode === "custom") {
          activeProvider =
            aiSettings.customProviders.find(
              (p) => p.id === aiSettings.activeCustomProviderId,
            ) ?? null;
        }
        aiModel =
          aiSettings.mode === "custom" && activeProvider
            ? `${activeProvider.name} · ${activeProvider.model}`
            : aiSettings.mode === "saas"
              ? "OpenLoaf SaaS"
              : null;
        try {
          if (aiSettings.mode === "custom" && !activeProvider) {
            throw new Error("no_active_custom_provider");
          }
          const rr = await refineTextViaChatStream(
            {
              mode: aiSettings.mode,
              systemPrompt,
              userText: text,
              hotwords: hotwords.length > 0 ? hotwords : undefined,
              historyEntries,
              requestTime,
              customBaseUrl: activeProvider?.baseUrl,
              customModel: activeProvider?.model,
              customKeyringId: activeProvider
                ? `ai_provider_${activeProvider.id}`
                : undefined,
              taskId: id,
            },
            () => {},
          );
          refinedText = rr.refinedText;
          if (import.meta.env.DEV && rr.requestEnvelope) {
            debugPayload = rr.requestEnvelope;
          }
        } catch (e) {
          const raw = e instanceof Error ? e.message : String(e);
          if (raw.includes("not authenticated") || raw.includes("unauthorized")) {
            useUIStore.getState().openLogin();
            throw new NotAuthenticatedError();
          }
          console.warn("[history] refine failed, keeping raw transcript:", e);
          await handleAiRefineCustomFailure(e);
        }
      }

      const d = await db();
      await d.execute(
        "UPDATE history SET text = $1, refined_text = $2, status = 'success', error = NULL, asr_source = $3, ai_model = $4, segment_mode = $5, provider_kind = $6, debug_payload = COALESCE($7, debug_payload) WHERE id = $8",
        [text, refinedText, asrSource, aiModel, segmentMode, providerKind, debugPayload, id],
      );
      set({
        items: get().items.map((it) =>
          it.id === id
            ? {
                ...it,
                text,
                refined_text: refinedText,
                status: "success",
                error: null,
                asr_source: asrSource,
                ai_model: aiModel,
                segment_mode: segmentMode,
                provider_kind: providerKind,
                debug_payload: debugPayload ?? it.debug_payload ?? null,
              }
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
