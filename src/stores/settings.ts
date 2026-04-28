import { create } from "zustand";
import { Store } from "@tauri-apps/plugin-store";
import { syncI18nFromSettings } from "@/lib/i18n-sync";
import type { LanguagePref } from "@/i18n";

// settings.json 落在 tauri-plugin-store 的 app data 路径下。只放非机密配置；
// API Key 等机密走 keyring，见 src/lib/secrets.ts。
const STORE_FILE = "settings.json";
const SCHEMA_VERSION = 4;

export type CloseBehavior = "ASK" | "HIDE" | "QUIT";
export type InjectMethod = "CLIPBOARD + PASTE" | "SIMULATE KEYBOARD";
export type Sensitivity = "LOW" | "NORMAL" | "HIGH";
// 听写源：SAAS = OpenLoaf 云端（扣积分 / Pro+ 无限）；BYO = 用户自己的 REST 端点。
// 详见 docs/subscription.md。
export type DictationSource = "SAAS" | "BYO";
// 听写模式：
//   REALTIME — 实时听写，ASR partial 直接落文本（所见即所得，边说边出）
//   AI       — AI 听写（默认），松开后取 final 文本，再经 LLM 自动润色/总结后一次性注入
export type DictationMode = "REALTIME" | "AI";
// 分句模式（V4 OL-TL-RT-002 的 vadMode 透传，UI 用人类语义）：
//   AUTO   — 自动分句（默认 / 服务端 VAD）：按停顿自动切句，UI 实时回填 partial
//   MANUAL — 手动分句：整段录音视为一句话，松开按键后才出转写
export type AsrSegmentMode = "AUTO" | "MANUAL";

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
  injectMethod: InjectMethod;
  restoreClipboard: boolean;
  launchStartup: boolean;
  // 仅 macOS：是否在 Dock 中显示应用图标。off ⇒ 应用变成纯菜单栏应用（Accessory
  // activation policy），仍可通过托盘打开主窗口。其他平台无效果。
  showDockIcon: boolean;
  // 自动更新：启动时静默 check + 下载；发现新版本直接 downloadAndInstall
  // 触发一次 relaunch，用户感知 ≈ 启动时多了一小段"升级中"。off 则完全不检查，
  // 只能手动通过托盘"检查更新"触发。
  autoUpdate: boolean;
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
}

export interface PersonalizationSettings {
  autoPolish: boolean;
  contextStyle: boolean;
  sensitivity: Sensitivity;
}

interface PersistShape {
  schemaVersion: number;
  general: GeneralSettings;
  personalization: PersonalizationSettings;
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
  injectMethod: "CLIPBOARD + PASTE",
  restoreClipboard: true,
  launchStartup: false,
  showDockIcon: true,
  autoUpdate: true,
  closeBehavior: "ASK",
  onboardingCompleted: false,
  // 默认 MANUAL（vadMode=none）：push-to-talk 听写场景下，文档明确给出"更准、
  // 更便宜、不被 VAD 错切"。AUTO（server_vad）留给会议字幕 / 直播 / 同传等需要
  // 按句独立 transcript 的无人值守场景。详见
  // ~/.agents/skills/openloaf-saas-sdk/tools/OL-TL-RT-002-realtime-asr-llm.md
  asrSegmentMode: "MANUAL",
};

const DEFAULT_PERSONALIZATION: PersonalizationSettings = {
  autoPolish: true,
  contextStyle: false,
  sensitivity: "NORMAL",
};

interface SettingsState {
  general: GeneralSettings;
  personalization: PersonalizationSettings;
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
  return { ...(oldGeneral as Partial<GeneralSettings>), asrSegmentMode: "MANUAL" };
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

async function readPersisted(): Promise<PersistShape> {
  const s = await store();
  const raw = await s.get<unknown>("root");
  const defaults: PersistShape = {
    schemaVersion: SCHEMA_VERSION,
    general: { ...DEFAULT_GENERAL },
    personalization: { ...DEFAULT_PERSONALIZATION },
  };
  if (!raw || typeof raw !== "object") return defaults;
  const r = raw as Partial<PersistShape> & { schemaVersion?: number };

  // 迁移：v1 → v2 → v3 → v4 链式
  if (r.schemaVersion === 1) {
    const v2 = migrateV1((r.general ?? {}) as Record<string, unknown>);
    const v3 = migrateV2(v2 as Record<string, unknown>);
    const v4 = migrateV3(v3 as Record<string, unknown>);
    return {
      schemaVersion: SCHEMA_VERSION,
      general: { ...DEFAULT_GENERAL, ...v4 },
      personalization: {
        ...DEFAULT_PERSONALIZATION,
        ...(r.personalization ?? {}),
      },
    };
  }
  if (r.schemaVersion === 2) {
    const v3 = migrateV2((r.general ?? {}) as Record<string, unknown>);
    const v4 = migrateV3(v3 as Record<string, unknown>);
    return {
      schemaVersion: SCHEMA_VERSION,
      general: { ...DEFAULT_GENERAL, ...v4 },
      personalization: {
        ...DEFAULT_PERSONALIZATION,
        ...(r.personalization ?? {}),
      },
    };
  }
  if (r.schemaVersion === 3) {
    const v4 = migrateV3((r.general ?? {}) as Record<string, unknown>);
    return {
      schemaVersion: SCHEMA_VERSION,
      general: { ...DEFAULT_GENERAL, ...v4 },
      personalization: {
        ...DEFAULT_PERSONALIZATION,
        ...(r.personalization ?? {}),
      },
    };
  }

  if (r.schemaVersion !== SCHEMA_VERSION) return defaults;

  return {
    schemaVersion: SCHEMA_VERSION,
    general: { ...DEFAULT_GENERAL, ...(r.general ?? {}) },
    personalization: {
      ...DEFAULT_PERSONALIZATION,
      ...(r.personalization ?? {}),
    },
  };
}

async function writePersisted(shape: PersistShape): Promise<void> {
  const s = await store();
  await s.set("root", shape);
  await s.save();
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  general: { ...DEFAULT_GENERAL },
  personalization: { ...DEFAULT_PERSONALIZATION },
  loaded: false,

  init: async () => {
    const p = await readPersisted();
    set({
      general: p.general,
      personalization: p.personalization,
      loaded: true,
    });
    // 若读到是 v1，writePersisted 一次把 v2 结构固化到磁盘
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      general: p.general,
      personalization: p.personalization,
    });
  },

  setGeneral: async (key, value) => {
    const next = { ...get().general, [key]: value };
    set({ general: next });
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      general: next,
      personalization: get().personalization,
    });
    if (key === "interfaceLang") {
      void syncI18nFromSettings(next.interfaceLang);
    }
  },

  setPersonalization: async (key, value) => {
    const next = { ...get().personalization, [key]: value };
    set({ personalization: next });
    await writePersisted({
      schemaVersion: SCHEMA_VERSION,
      general: get().general,
      personalization: next,
    });
  },
}));
