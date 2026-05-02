import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { syncI18nFromSettings } from "@/lib/i18n-sync";
import type { LanguagePref } from "@/i18n";
import { deleteAiProviderKey } from "@/lib/secrets";
import {
  DEFAULT_AI_SYSTEM_PROMPTS,
  type AiPromptLang as AiPromptLangFromDefaults,
} from "@/lib/defaultAiPrompts";

export {
  DEFAULT_AI_SYSTEM_PROMPTS,
  getEffectiveAiSystemPrompt,
} from "@/lib/defaultAiPrompts";

// settings.json 落在 tauri-plugin-store 的 app data 路径下。只放非机密配置；
// API Key 等机密走 keyring，见 src/lib/secrets.ts。
const STORE_FILE = "settings.json";
const SCHEMA_VERSION = 10;

export type CloseBehavior = "ASK" | "HIDE" | "QUIT";
export type Sensitivity = "LOW" | "NORMAL" | "HIGH";
// 听写源：SAAS = OpenLoaf 云端（扣积分 / Pro+ 无限）；BYO = 用户自己的 REST 端点。
// 详见 docs/subscription.md。
export type DictationSource = "SAAS" | "BYO";
// 听写模式：
//   REALTIME — 实时听写，ASR partial 直接落文本（所见即所得，边说边出）
//   AI       — AI 听写（默认），松开后取 final 文本，再经 LLM 自动润色/总结后一次性注入
export type DictationMode = "REALTIME" | "AI";
// 听写模式：
//   REALTIME   — 实时转换：服务端 VAD 按停顿切句，partial 实时回填
//   UTTERANCE  — 整句听写：整段录音视为一句话，松开按键后才出转写
//   AI_REFINE  — AI 优化（默认）：UTTERANCE 流程结束后再走 AI refine 整理书面化
export type AsrSegmentMode = "REALTIME" | "UTTERANCE" | "AI_REFINE";
// 历史记录保留时长。off = 不写入数据库（仅当前会话内存可见）；其它按天数清理。
// 真正的清理任务由后端启动期 sweeper 执行（见 docs/history.md，TODO 实现）。
export type HistoryRetention = "forever" | "90d" | "30d" | "7d" | "off";
// 自动更新策略：
//   PROMPT   — 周期检查，发现新版静默下载提示用户安装（默认）
//   AUTO     — 周期检查，发现新版且系统空闲 + 非录音中时静默安装并重启
//   DISABLED — 不做任何后台检查；仅托盘/关于页手动检查
export type UpdatePolicy = "PROMPT" | "AUTO" | "DISABLED";

export interface GeneralSettings {
  interfaceLang: LanguagePref;
  dictationLang: string;
  // 空串 = 跟随系统默认麦克风；非空 = cpal 枚举出的设备名
  inputDevice: string;
  cueSound: boolean;
  // 听写源：SAAS 默认（需登录 OpenLoaf）；BYO 用户自带 REST 端点，不走 SaaS 不扣积分。
  // UI 开关尚未接入（文档已描述），字段先在 schema 里占位。
  dictationSource: DictationSource;
  endpoint: string;
  modelName: string;
  timeout: string;
  audioFormat: string;
  restoreClipboard: boolean;
  launchStartup: boolean;
  // 仅 macOS：是否在 Dock 中显示应用图标。off ⇒ 应用变成纯菜单栏应用（Accessory
  // activation policy），仍可通过托盘打开主窗口。其他平台无效果。
  showDockIcon: boolean;
  // 自动更新策略：决定后台周期检查命中新版后的行为。详见 UpdatePolicy 注释。
  // 默认 PROMPT：下载完毕后弹 toast 让用户决定何时安装。
  updatePolicy: UpdatePolicy;
  // 周期检查间隔（小时）。boot 触发一次，之后每 N 小时再触发一次。
  updateCheckIntervalHours: number;
  // 用户在自动检测到新版的 toast 上点了"跳过此版本"——记下版本号，下次启动 check
  // 命中同一版本时静默掉提示。空串 = 未跳过任何版本；用户主动点托盘 / 关于页的
  // "检查更新"时不消费这个值，仍会正常提示。
  skippedUpdateVersion: string;
  // 关闭行为（Cmd+Q / 红叉）：
  //   ASK  — 每次弹 CloseToBackgroundDialog
  //   HIDE — 直接隐藏到托盘（= 原"关闭时最小化到托盘"打开）
  //   QUIT — 直接退出（由对话框勾"不再提醒 + 退出"写入）
  closeBehavior: CloseBehavior;
  // 首次启动引导是否已完成。false ⇒ 启动时 main.tsx 会重定向到 /onboarding。
  // 设置 → 关于 里可重新触发引导（清掉这个标记）。
  onboardingCompleted: boolean;
  // V4 OL-TL-RT-002 的分句模式。AUTO = 服务端按停顿切句（多段 Final 客户端
  // 按 sentenceId 累积）；MANUAL = 整段视为一句话，松开按键后服务端才返回唯一
  // 一段 Final（中途没有 partial 回填）。
  asrSegmentMode: AsrSegmentMode;
  // 历史记录保留时长。'off' 不写入 DB；其它按天清理。
  historyRetention: HistoryRetention;
}

export interface PersonalizationSettings {
  autoPolish: boolean;
  contextStyle: boolean;
  sensitivity: Sensitivity;
}

export type AiRefineMode = "saas" | "custom";
export type AiPromptLang = AiPromptLangFromDefaults;

export interface AiCustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  model: string;
}

export interface AiRefineSettings {
  mode: AiRefineMode;
  customProviders: AiCustomProvider[];
  activeCustomProviderId: string | null;
  // null = 跟随当前 UI 语言用 DEFAULT_AI_SYSTEM_PROMPTS；非 null = 用户自定义（不分语言）。
  customSystemPrompt: string | null;
  includeHistory: boolean;
}


interface PersistShape {
  schemaVersion: number;
  general: GeneralSettings;
  personalization: PersonalizationSettings;
  aiRefine: AiRefineSettings;
}

const DEFAULT_GENERAL: GeneralSettings = {
  interfaceLang: "system",
  dictationLang: "自动检测",
  inputDevice: "",
  cueSound: true,
  dictationSource: "SAAS",
  endpoint: "",
  modelName: "",
  timeout: "30",
  audioFormat: "WAV",
  restoreClipboard: true,
  launchStartup: false,
  showDockIcon: true,
  updatePolicy: "PROMPT",
  updateCheckIntervalHours: 6,
  skippedUpdateVersion: "",
  closeBehavior: "ASK",
  onboardingCompleted: false,
  // 默认 AI_REFINE：UTTERANCE 流程拿到 final transcript 后再走 AI refine 整理。
  // UTTERANCE（vadMode=none）作为基底：push-to-talk 听写文档推荐——更准、
  // 更便宜、不被 VAD 错切。REALTIME（server_vad）留给会议字幕 / 直播 / 同传
  // 等需要按句独立 transcript 的无人值守场景。
  asrSegmentMode: "AI_REFINE",
  historyRetention: "forever",
};

const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
  autoPolish: true,
  contextStyle: false,
  sensitivity: "NORMAL",
};

const DEFAULT_AI_REFINE: AiRefineSettings = {
  mode: "saas",
  customProviders: [],
  activeCustomProviderId: null,
  customSystemPrompt: null,
  includeHistory: true,
};

interface SettingsState {
  general: GeneralSettings;
  personalization: PersonalizationSettings;
  aiRefine: AiRefineSettings;
  loaded: boolean;
  init: () => Promise<void>;
  setGeneral: <K extends keyof GeneralSettings>(
    key: K,
    value: GeneralSettings[K],
  ) => Promise<void>;
  setPersonalization: <K extends keyof PersonalizationSettings>(
    key: K,
    value: PersonalizationSettings[K],
  ) => Promise<void>;
  setAiRefineMode: (mode: AiRefineMode) => Promise<void>;
  addAiProvider: (provider: AiCustomProvider) => Promise<void>;
  updateAiProvider: (id: string, patch: Partial<Omit<AiCustomProvider, "id">>) => Promise<void>;
  removeAiProvider: (id: string) => Promise<void>;
  setActiveAiProvider: (id: string | null) => Promise<void>;
  setAiSystemPrompt: (value: string | null) => Promise<void>;
  setAiIncludeHistory: (v: boolean) => Promise<void>;
}

let storePromise: Promise<Store> | null = null;

function store(): Promise<Store> {
  if (!storePromise) storePromise = Store.load(STORE_FILE);
  return storePromise;
}

// v1 → v2：删除 maxRec / closeAction / minimizeTray，合成 closeBehavior。
// 老字段若存在：minimizeTray=true ⇒ HIDE；closeAction="QUIT" ⇒ QUIT；其余 ASK。
// 老的"System Default (MacBook Pro Microphone)" 这类硬编码设备名一律清成空串，
// 让 UI 回落到"系统默认"。
function migrateV1(oldGeneral: Record<string, unknown>): Partial<GeneralSettings> {
  const cleaned: Record<string, unknown> = { ...oldGeneral };
  const minimizeTray = cleaned.minimizeTray === true;
  const closeAction = cleaned.closeAction;
  delete cleaned.maxRec;
  delete cleaned.closeAction;
  delete cleaned.minimizeTray;

  let closeBehavior: CloseBehavior = "ASK";
  if (minimizeTray) closeBehavior = "HIDE";
  else if (closeAction === "QUIT") closeBehavior = "QUIT";

  // 老的默认设备字符串没法在新设备枚举里匹配，清掉回落到系统默认。
  if (
    typeof cleaned.inputDevice === "string" &&
    cleaned.inputDevice.startsWith("System Default")
  ) {
    cleaned.inputDevice = "";
  }

  return { ...(cleaned as Partial<GeneralSettings>), closeBehavior };
}

// v2 → v3：纠正之前 asrSegmentMode 默认错配为 AUTO 的历史包袱。push-to-talk
// 听写场景文档明确推荐 MANUAL（none）：模型有完整上下文 → 更准、不被 VAD 误切。
// 老用户不论之前是默认填的 AUTO 还是主动选过 AUTO，都一并搬到 MANUAL——主动想用
// AUTO 的用户在升级后还能在设置里再切回去（v3 之后 schemaVersion 不再覆盖）。
function migrateV2(oldGeneral: Record<string, unknown>): Partial<GeneralSettings> {
  return { ...(oldGeneral as Partial<GeneralSettings>), asrSegmentMode: "UTTERANCE" };
}

// v3 → v4：interfaceLang 由 UI 文案字符串改为稳定 code（system / zh-CN / zh-TW / en）。
function migrateV3(oldGeneral: Record<string, unknown>): Partial<GeneralSettings> {
  const lang = oldGeneral.interfaceLang;
  let next: LanguagePref = "system";
  if (lang === "简体中文" || lang === "zh-CN") next = "zh-CN";
  else if (lang === "繁體中文" || lang === "繁体中文" || lang === "zh-TW") next = "zh-TW";
  else if (lang === "English" || lang === "en") next = "en";
  return { ...(oldGeneral as Partial<GeneralSettings>), interfaceLang: next };
}

// v4 → v5：AsrSegmentMode 重命名 + 加 AI_REFINE。AUTO→REALTIME, MANUAL→UTTERANCE；
// 老用户的选择保持等价语义，不强行改成 AI_REFINE（避免突然开始扣额外积分）；
// 想用 AI_REFINE 的用户自己去设置里切。
function migrateV4(oldGeneral: Record<string, unknown>): Partial<GeneralSettings> {
  const old = oldGeneral.asrSegmentMode;
  let mode: AsrSegmentMode = "AI_REFINE";
  if (old === "AUTO" || old === "REALTIME") mode = "REALTIME";
  else if (old === "MANUAL" || old === "UTTERANCE") mode = "UTTERANCE";
  else if (old === "AI_REFINE") mode = "AI_REFINE";
  return { ...(oldGeneral as Partial<GeneralSettings>), asrSegmentMode: mode };
}

// v5 → v6：把"历史记录保留时长"从 History 页本地 state 升级为持久化设置。
// 老用户没存过这个字段，直接补默认 forever。
function migrateV5(oldGeneral: Record<string, unknown>): Partial<GeneralSettings> {
  return { ...(oldGeneral as Partial<GeneralSettings>), historyRetention: "forever" };
}

// v6 → v7：移除 injectMethod。后端始终走"剪贴板 + Cmd/Ctrl+V"，"模拟键盘"分支
// 从未真正接入。直接丢弃旧字段，UI 只保留"粘贴后恢复剪贴板"开关。
function migrateV6(oldGeneral: Record<string, unknown>): Partial<GeneralSettings> {
  const cleaned = { ...oldGeneral };
  delete cleaned.injectMethod;
  return cleaned as Partial<GeneralSettings>;
}

// v7 → v8：autoUpdate(boolean) → updatePolicy(枚举) + 新增 updateCheckIntervalHours。
// true ⇒ PROMPT（保持现有"提示后才装"的行为，不做用户没要求过的自动安装）；
// false ⇒ DISABLED。老用户没设过就走默认 PROMPT。
function migrateV7(oldGeneral: Record<string, unknown>): Partial<GeneralSettings> {
  const cleaned = { ...oldGeneral };
  const legacy = cleaned.autoUpdate;
  delete cleaned.autoUpdate;
  let policy: UpdatePolicy = "PROMPT";
  if (legacy === false) policy = "DISABLED";
  return {
    ...(cleaned as Partial<GeneralSettings>),
    updatePolicy: policy,
    updateCheckIntervalHours: 6,
  };
}

// v8 → v9：加 aiRefine slice，原字段不动；缺失字段补默认值。
// v9 → v10：systemPrompts(三语 Record) 改为 customSystemPrompt(string|null)。
// 旧三语跟默认完全一致 ⇒ null（继续走默认）；否则取一条非空非默认的作为自定义值。
function mergeAiRefine(raw: unknown): AiRefineSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_AI_REFINE };
  const r = raw as Partial<AiRefineSettings> & { systemPrompts?: unknown };
  const providers = Array.isArray(r.customProviders)
    ? r.customProviders.filter(
        (p): p is AiCustomProvider =>
          !!p && typeof p === "object" && typeof p.id === "string",
      )
    : [];
  const active =
    typeof r.activeCustomProviderId === "string" &&
    providers.some((p) => p.id === r.activeCustomProviderId)
      ? r.activeCustomProviderId
      : providers[0]?.id ?? null;

  let customSystemPrompt: string | null;
  if (typeof r.customSystemPrompt === "string") {
    customSystemPrompt = r.customSystemPrompt;
  } else if (r.customSystemPrompt === null) {
    customSystemPrompt = null;
  } else if (r.systemPrompts && typeof r.systemPrompts === "object") {
    const old = r.systemPrompts as Record<string, unknown>;
    let picked: string | null = null;
    for (const lang of ["zh-CN", "zh-TW", "en"] as const) {
      const v = old[lang];
      if (typeof v === "string" && v.length > 0 && v !== DEFAULT_AI_SYSTEM_PROMPTS[lang]) {
        picked = v;
        break;
      }
    }
    customSystemPrompt = picked;
  } else {
    customSystemPrompt = null;
  }

  return {
    mode: r.mode === "custom" ? "custom" : "saas",
    customProviders: providers,
    activeCustomProviderId: active,
    customSystemPrompt,
    includeHistory: typeof r.includeHistory === "boolean" ? r.includeHistory : true,
  };
}

async function readPersisted(): Promise<PersistShape> {
  const s = await store();
  const raw = await s.get<unknown>("root");
  const defaults: PersistShape = {
    schemaVersion: SCHEMA_VERSION,
    general: { ...DEFAULT_GENERAL },
    personalization: { ...DEFAULT_PERSONALIZATION },
    aiRefine: { ...DEFAULT_AI_REFINE },
  };
  if (!raw || typeof raw !== "object") return defaults;
  const r = raw as Partial<PersistShape> & { schemaVersion?: number };

  const finalize = (general: Partial<GeneralSettings>): PersistShape => ({
    schemaVersion: SCHEMA_VERSION,
    general: { ...DEFAULT_GENERAL, ...general },
    personalization: {
      ...DEFAULT_PERSONALIZATION,
      ...(r.personalization ?? {}),
    },
    aiRefine: mergeAiRefine((r as { aiRefine?: unknown }).aiRefine),
  });

  // 迁移：v1 → v2 → ... → v8 → v9 链式
  if (r.schemaVersion === 1) {
    const v2 = migrateV1((r.general ?? {}) as Record<string, unknown>);
    const v3 = migrateV2(v2 as Record<string, unknown>);
    const v4 = migrateV3(v3 as Record<string, unknown>);
    const v5 = migrateV4(v4 as Record<string, unknown>);
    const v6 = migrateV5(v5 as Record<string, unknown>);
    const v7 = migrateV6(v6 as Record<string, unknown>);
    const v8 = migrateV7(v7 as Record<string, unknown>);
    return finalize(v8);
  }
  if (r.schemaVersion === 2) {
    const v3 = migrateV2((r.general ?? {}) as Record<string, unknown>);
    const v4 = migrateV3(v3 as Record<string, unknown>);
    const v5 = migrateV4(v4 as Record<string, unknown>);
    const v6 = migrateV5(v5 as Record<string, unknown>);
    const v7 = migrateV6(v6 as Record<string, unknown>);
    const v8 = migrateV7(v7 as Record<string, unknown>);
    return finalize(v8);
  }
  if (r.schemaVersion === 3) {
    const v4 = migrateV3((r.general ?? {}) as Record<string, unknown>);
    const v5 = migrateV4(v4 as Record<string, unknown>);
    const v6 = migrateV5(v5 as Record<string, unknown>);
    const v7 = migrateV6(v6 as Record<string, unknown>);
    const v8 = migrateV7(v7 as Record<string, unknown>);
    return finalize(v8);
  }
  if (r.schemaVersion === 4) {
    const v5 = migrateV4((r.general ?? {}) as Record<string, unknown>);
    const v6 = migrateV5(v5 as Record<string, unknown>);
    const v7 = migrateV6(v6 as Record<string, unknown>);
    const v8 = migrateV7(v7 as Record<string, unknown>);
    return finalize(v8);
  }
  if (r.schemaVersion === 5) {
    const v6 = migrateV5((r.general ?? {}) as Record<string, unknown>);
    const v7 = migrateV6(v6 as Record<string, unknown>);
    const v8 = migrateV7(v7 as Record<string, unknown>);
    return finalize(v8);
  }
  if (r.schemaVersion === 6) {
    const v7 = migrateV6((r.general ?? {}) as Record<string, unknown>);
    const v8 = migrateV7(v7 as Record<string, unknown>);
    return finalize(v8);
  }
  if (r.schemaVersion === 7) {
    const v8 = migrateV7((r.general ?? {}) as Record<string, unknown>);
    return finalize(v8);
  }
  if (r.schemaVersion === 8 || r.schemaVersion === 9) {
    return finalize((r.general ?? {}) as Partial<GeneralSettings>);
  }

  if (r.schemaVersion !== SCHEMA_VERSION) return defaults;

  return finalize((r.general ?? {}) as Partial<GeneralSettings>);
}

async function writePersisted(shape: PersistShape): Promise<void> {
  const s = await store();
  await s.set("root", shape);
  await s.save();
}

export const useSettingsStore = create<SettingsState>((set, get) => {
  const persist = async (patch: Partial<PersistShape> = {}) => {
    const shape: PersistShape = {
      schemaVersion: SCHEMA_VERSION,
      general: get().general,
      personalization: get().personalization,
      aiRefine: get().aiRefine,
      ...patch,
    };
    await writePersisted(shape);
  };

  return {
    general: { ...DEFAULT_GENERAL },
    personalization: { ...DEFAULT_PERSONALIZATION },
    aiRefine: { ...DEFAULT_AI_REFINE },
    loaded: false,

    init: async () => {
      const p = await readPersisted();
      set({
        general: p.general,
        personalization: p.personalization,
        aiRefine: p.aiRefine,
        loaded: true,
      });
      await writePersisted(p);
    },

    setGeneral: async (key, value) => {
      const next = { ...get().general, [key]: value };
      set({ general: next });
      await persist({ general: next });
      if (key === "interfaceLang") {
        void syncI18nFromSettings(next.interfaceLang);
      }
    },

    setPersonalization: async (key, value) => {
      const next = { ...get().personalization, [key]: value };
      set({ personalization: next });
      await persist({ personalization: next });
    },

    setAiRefineMode: async (mode) => {
      const next = { ...get().aiRefine, mode };
      set({ aiRefine: next });
      await persist({ aiRefine: next });
    },

    addAiProvider: async (provider) => {
      const cur = get().aiRefine;
      if (cur.customProviders.some((p) => p.id === provider.id)) return;
      const customProviders = [...cur.customProviders, provider];
      const activeCustomProviderId = cur.activeCustomProviderId ?? provider.id;
      const next = { ...cur, customProviders, activeCustomProviderId };
      set({ aiRefine: next });
      await persist({ aiRefine: next });
    },

    updateAiProvider: async (id, patch) => {
      const cur = get().aiRefine;
      const customProviders = cur.customProviders.map((p) =>
        p.id === id ? { ...p, ...patch } : p,
      );
      const next = { ...cur, customProviders };
      set({ aiRefine: next });
      await persist({ aiRefine: next });
    },

    removeAiProvider: async (id) => {
      const cur = get().aiRefine;
      const customProviders = cur.customProviders.filter((p) => p.id !== id);
      const activeCustomProviderId =
        cur.activeCustomProviderId === id
          ? customProviders[0]?.id ?? null
          : cur.activeCustomProviderId;
      const next = { ...cur, customProviders, activeCustomProviderId };
      set({ aiRefine: next });
      await persist({ aiRefine: next });
      try {
        await deleteAiProviderKey(id);
      } catch (e) {
        console.warn("[ai-refine] deleteAiProviderKey failed:", e);
      }
    },

    setActiveAiProvider: async (id) => {
      const cur = get().aiRefine;
      const exists = id === null || cur.customProviders.some((p) => p.id === id);
      if (!exists) return;
      const next = { ...cur, activeCustomProviderId: id };
      set({ aiRefine: next });
      await persist({ aiRefine: next });
    },

    setAiSystemPrompt: async (value) => {
      const cur = get().aiRefine;
      const next = { ...cur, customSystemPrompt: value };
      set({ aiRefine: next });
      await persist({ aiRefine: next });
    },

    setAiIncludeHistory: async (v) => {
      const cur = get().aiRefine;
      const next = { ...cur, includeHistory: v };
      set({ aiRefine: next });
      await persist({ aiRefine: next });
    },
  };
});
