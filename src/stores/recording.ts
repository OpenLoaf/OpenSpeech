import { create } from "zustand";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import {
  writeText as writeClipboard,
  readText as readClipboard,
} from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import i18n from "@/i18n";
import type { BindingId, HotkeyBinding } from "@/lib/hotkey";
import {
  useSettingsStore,
  getEffectiveAiSystemPrompt,
  getEffectiveAiTranslationSystemPrompt,
  type AsrSegmentMode,
  type TranslateTargetLang,
} from "@/stores/settings";
import { useHistoryStore, type AsrSource } from "@/stores/history";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import {
  startAudioLevel,
  stopAudioLevel,
  startRecordingToFile,
  stopRecordingAndSave,
  cancelRecording,
  deleteRecordingFile,
  type RecordingResult,
} from "@/lib/audio";
import {
  startSttSession,
  finalizeSttSession,
  cancelSttSession,
  transcribeRecordingFile,
} from "@/lib/stt";
import { buildProviderRef } from "@/lib/dictation-provider-ref";
import { resolveDictationLang } from "@/lib/dictation-lang";
import { refineTextViaChatStream } from "@/lib/ai-refine";
import { handleAiRefineCustomFailure } from "@/lib/ai-refine-fallback";
import { resolveLang } from "@/i18n";
import { getHotwordsArray } from "@/lib/hotwordsCache";
import { getDomainNamesForPrompt } from "@/lib/domains";
import { clipHistoryEntry } from "@/lib/historyClip";
import { newId } from "@/lib/ids";
import { cuePlay, cueSetActive } from "@/lib/cue";
import { getActiveAppName } from "@/lib/activeApp";

export type RecordingState =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "injecting"
  | "translating"
  | "error";

interface HotkeyEvent {
  id: BindingId;
  phase: "pressed" | "released";
}

// 波形 bar 数量；Home / Overlay 的 Waveform 消费这个长度的滑动窗口。
// Rust audio_level emit 频率 = 20Hz（TICK_MS=50ms），60 × 50ms = 3s 一个完整流动周期。
const LEVEL_BUFFER_LEN = 60;

interface RecordingStore {
  state: RecordingState;
  activeId: BindingId | null;
  errorMessage: string | null;
  lastPressAt: number;
  startedListening: boolean;
  audioLevels: number[];
  /**
   * 当前会话的 history.id——pressed 时前端生成（`newId()`），同时作为录音
   * 文件名（`recordings/<id>.ogg`）。落盘 / 写 history / 取消都走同一个 id。
   * idle 态为 null。
   */
  recordingId: string | null;
  /**
   * 实时 ASR partial 文本：Rust 转发 `openspeech://asr-partial` 事件时更新。
   * UI（悬浮录音条 / 设置预览）可以直接订阅这个字段展示流式转写结果。
   * recording → idle 过渡时清空；Final 事件到达时替换为最终文字。
   */
  liveTranscript: string;
  /**
   * 注入末尾段提前隐藏悬浮栏：refine 流式 token 全部敲完、只剩末尾 diff
   * 那一小段兜底 paste 时置 true，让 overlay pill 在用户看到几乎全部文字时
   * 同步退场，比"全部敲完 + 800ms idle 延迟"快一拍。idle / 新一轮录音都重置为 false。
   */
  pillEarlyHide: boolean;
  /**
   * 临时覆盖 settings.general.asrSegmentMode——只用于"必须用 VAD 才有意义"的
   * 场景（目前是 Onboarding 第三步 Try-It：默认 MANUAL 没有 partial，
   * 用户按下快捷键后到松手前看不到任何实时文字，会以为坏了）。组件挂载时
   * 设为 'AUTO'、卸载时清空，不影响用户在 Settings 里选的值。
   */
  segmentModeOverride: AsrSegmentMode | null;
  setSegmentModeOverride: (mode: AsrSegmentMode | null) => void;
  /**
   * ESC 二段确认状态：第一次 ESC 后 500ms 静默期内为 false；静默超时进入
   * "armed" 阶段为 true；3s prompt 超时或第二次 ESC 取消后回到 false。
   * Home 页 LiveDictationPanel 据此切换 [Esc] 按键的视觉强调，与 overlay X 按钮的
   * armed 视觉保持一致。
   */
  escArmed: boolean;
  initListeners: () => Promise<void>;
  syncBindings: (
    bindings: Record<BindingId, HotkeyBinding | null>,
  ) => Promise<void>;
  dismissError: () => void;
  simulateCancel: () => void;
  simulateFinalize: () => void;
  /**
   * DEV-ONLY：用历史里某条听写录音的音频文件，跑一遍正常 dictation pipeline
   * （REST ASR → refine 流式 → 注入到光标），免去每次手动说话调试。
   * 不写新历史。仅 type=dictation 才允许调用，调用方自己 gate；
   * 长录音（>5min）不支持（OL-TL-003 限制）。
   */
  simulateDictationFromAudio: (audioPath: string, durationMs: number) => Promise<void>;
  /** DEV-ONLY：只跑一次 AI refine pass，返回 refined 文本；不注入、不写历史。 */
  debugRefineOnly: (text: string) => Promise<string>;
  /** DEV-ONLY：把任意文本通过 inject_type 写到当前焦点应用；不走录音/转录/refine。 */
  debugReinject: (text: string) => Promise<void>;
}

// 当前 dictation.lang resolve 后给后端的稳定 ISO code（含 follow_interface 推导）。
const currentDictationLang = (): string => {
  const s = useSettingsStore.getState();
  return resolveDictationLang(s.dictation.lang, s.general.interfaceLang);
};

const getEffectiveSegmentMode = (): AsrSegmentMode =>
  useRecordingStore.getState().segmentModeOverride ??
  useSettingsStore.getState().general.asrSegmentMode;

const TRANSLATE_LANG_NAMES: Record<TranslateTargetLang, string> = {
  en: "English",
  zh: "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  fr: "French (Français)",
  de: "German (Deutsch)",
  es: "Spanish (Español)",
};

// REALTIME 下 aiRefine 强制短路；UTTERANCE 下看用户开关。
const isAiRefineActive = (): boolean => {
  const mode = getEffectiveSegmentMode();
  if (mode !== "UTTERANCE") return false;
  return useSettingsStore.getState().aiRefine.enabled === true;
};

const PREPARING_MS = 300;
// 录音净时长 < MIN_RECORD_MS 视为"没说出有效内容"——直接丢弃，不转录、不保存
// WAV、不写历史。覆盖快速双击误触 + "按了一下就改主意"两类。
// 阈值 = PREPARING_MS（流准备）+ 1000（最少说话时长）
const MIN_RECORD_MS = 1000;
const TOO_SHORT_TOTAL_MS = PREPARING_MS + MIN_RECORD_MS;

// error 态最长停留时长——超过后自动回 idle，避免悬浮条因用户没注意到错误而
// 永久挂在屏幕上。1.5s 足以扫一眼 toast / pill 上的红字；用户随时可以按
// 激活快捷键或 ESC 立即关掉。需要更久阅读时间的错误应改用 toast 的 durationMs。
const ERROR_AUTO_DISMISS_MS = 1500;

const emptyLevels = () => Array(LEVEL_BUFFER_LEN).fill(0) as number[];

// Mic 的生命周期归主窗口管：Rust 事件会广播到所有 webview，overlay 的 store 也
// 会走状态机，但只有主窗口知道"用户在设置里选了哪个设备"（overlay 不 init
// settingsStore），放任 overlay 也调 audio_level_start 会让 Rust 端频繁 restart
// stream（已观察到：main 传 "UGREEN…"、overlay 传 null，触发一次 stopped→started）。
const IS_MAIN_WINDOW = getCurrentWebviewWindow().label === "main";

const startMic = async (): Promise<boolean> => {
  if (!IS_MAIN_WINDOW) return false;
  const device = useSettingsStore.getState().general.inputDevice || null;
  return await startAudioLevel(device);
};
const stopMic = () => {
  if (!IS_MAIN_WINDOW) return;
  const stack = new Error().stack?.split("\n").slice(2, 6).join(" | ");
  console.info(`[recording] stopMic called, caller=${stack}`);
  void stopAudioLevel();
};

// ESC 全局捕获：录音活跃期间把 Esc 注册为系统快捷键，前台 app 收不到 Esc。
// 必须保证 stop 在所有"离开 active 态"路径上被调到——否则用户在浏览器 Esc 全失效。
// 用 startedFlag 做幂等，避免对插件重复注册的隐性开销。
let escCaptureActive = false;
const escCaptureStart = () => {
  if (!IS_MAIN_WINDOW || escCaptureActive) return;
  escCaptureActive = true;
  void invoke("esc_capture_start").catch((e) => {
    escCaptureActive = false;
    console.warn("[recording] esc_capture_start failed:", e);
  });
};
const escCaptureStop = () => {
  if (!IS_MAIN_WINDOW || !escCaptureActive) return;
  escCaptureActive = false;
  void invoke("esc_capture_stop").catch((e) => {
    console.warn("[recording] esc_capture_stop failed:", e);
  });
};

// 把错误/警告/提示推到悬浮条（悬浮条窗口监听 `openspeech://overlay-toast` 事件
// 并自行 resize 渲染）。仅主窗执行，避免重复 emit；overlay 窗口里调这个等价 no-op。
//
// 这是录音链路里全部失败提示的唯一出口——历史上调用 sonner.toast 会把消息渲染
// 在主窗口的 <Toaster /> 里，主窗口在后台时用户根本看不到，再加上 gate 失败时
// 还会 invoke('show_main_window_cmd') 把主程序拉到前台，被用户视为打扰。
// 现在统一在悬浮条上方提示，必要时附 action 按钮让用户主动选择是否打开主程序。
type OverlayToastKind = "error" | "warning" | "info";
type OverlayToastActionKey =
  | "open_login"
  | "open_no_internet"
  | "open_settings_byo"
  | "switch_to_saas";
interface OverlayToastOptions {
  description?: string;
  action?: { label: string; key: OverlayToastActionKey };
  durationMs?: number;
  dismissOnDisarm?: boolean;
}
const notifyOverlay = (
  kind: OverlayToastKind,
  title: string,
  options: OverlayToastOptions = {},
) => {
  if (!IS_MAIN_WINDOW) return;
  void emitTo("overlay", "openspeech://overlay-toast", {
    kind,
    title,
    description: options.description,
    action: options.action,
    durationMs: options.durationMs,
    dismissOnDisarm: options.dismissOnDisarm,
  });
};

// 翻译模式指示条状态推送——overlay 端 TranslateIndicator 是独立 motion 元素，
// 与 toast（警告/错误语义）解耦。lang 在 active=true 时是当前界面语言下的目标
// 语言简称（"英文" / "Chinese"），active=false 时不带。
const emitTranslateActive = (active: boolean, lang?: string) => {
  if (!IS_MAIN_WINDOW) return;
  void emitTo("overlay", "openspeech://translate-active", { active, lang });
};

// 录音中跨模式切换提示（dictate_ptt ↔ translate）。overlay 收到后在 pill 中心
// 临时替换 wave 显示"切换到 X 模式"~2s 再回归正常渲染。
type ModeSwitchKind = "translate" | "dictation";
const emitModeSwitchHint = (kind: ModeSwitchKind) => {
  if (!IS_MAIN_WINDOW) return;
  void emitTo("overlay", "openspeech://mode-switch-hint", { kind });
};

// 录音中"另一种激活键"是否能触发跨模式切换——只有 dictate_ptt 与 translate
// 两个 id 共享一次录音的语义边界（都属于"按一下开始 + 录完出文字"流程），
// 才能互切；show_main_window / open_toolbox 等无录音流程的快捷键不参与。
const isModeSwitchTarget = (id: BindingId | null): boolean =>
  id === "dictate_ptt" || id === "translate";

// 拿当前界面语言下的目标语言简称（"英文" / "Chinese" 等）。i18n 找不到时回退
// 到目标语言代码大写。
const resolveTranslateLangLabel = (): string => {
  const target = useSettingsStore.getState().general.translateTargetLang;
  const langKey = `overlay:translate.lang.${target}`;
  const label = i18n.t(langKey);
  return label === langKey ? target.toUpperCase() : (label as string);
};

// DashScope qwen3-asr-flash-realtime 的已知模型层 bug：解码 token 复读循环，
// 服务端检测到后中断流并抛 "model repeat output happened"。不是参数问题、不是
// 网络问题——重连同一 realtime 通道大概率仍会复现（特定音频特征触发）。兜底策略：
// 落本地录音文件后走 REST 一次性 ASR（OL-TL-003）替代实时通道。
//
// 仅 UTTERANCE 模式触发降级——REALTIME（VAD 边说边出字）已经把前半段
// partial 注入到光标，REST 重转拿到的整段会与已注入文本拼接错乱，那条路径不降级，
// 仅 toast 让用户事后从历史里手动重试。
const isRealtimeRepeatError = (code: string, message: string): boolean => {
  const m = `${code} ${message}`.toLowerCase();
  return (
    m.includes("model repeat output happened") ||
    m.includes("repeat output happened") ||
    m.includes("repetition")
  );
};

// 当前录音是否要降级到文件转写。pressed 进 preparing 时 reset；asr-error 命中
// repeat 关键字时（非 REALTIME 模式）置 true；finalize 读取它决定是走 stt_finalize
// 还是直接 transcribe_recording_file。Module 级足够——一次录音生命周期内无并发。
let realtimeDegradedToFile = false;

// DEBUG 模拟态（仅 dev / `simulateDictationFromAudio` 路径使用）：
// - 不开真 mic、不开真 STT 会话；FSM 走 recording → transcribing → injecting → idle
// - 用 fake audio-level + emit "openspeech://debug-recording" 让 overlay 显示倒计时条
// - ESC 双击 / X 按钮 / `simulateCancel` 走 `cancelDebugSimulation()` 路径，不写历史
let debugSimulating = false;
let debugSimAbort: ((reason: unknown) => void) | null = null;
let debugFakeLevelTimer: number | null = null;

const startDebugFakeLevels = () => {
  if (debugFakeLevelTimer !== null) return;
  // overlay Waveform 直接 listen "openspeech://audio-level"——broadcast 事件走 emit
  // 即可，main 自己 store 也会跟着更新一份（无副作用）。
  debugFakeLevelTimer = window.setInterval(() => {
    const v = 0.3 + Math.random() * 0.5;
    void emit("openspeech://audio-level", v);
  }, 50);
};

const stopDebugFakeLevels = () => {
  if (debugFakeLevelTimer !== null) {
    window.clearInterval(debugFakeLevelTimer);
    debugFakeLevelTimer = null;
  }
};

const broadcastDebug = (payload: {
  active: boolean;
  totalMs?: number;
  endAtUnixMs?: number;
}) => {
  void emit("openspeech://debug-recording", payload);
};

const cancelDebugSimulation = () => {
  if (!debugSimulating) return;
  debugSimulating = false;
  stopDebugFakeLevels();
  broadcastDebug({ active: false });
  const reject = debugSimAbort;
  debugSimAbort = null;
  reject?.(new Error("debug-cancelled"));
};

const debugAbortableDelay = (ms: number): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    const t = window.setTimeout(() => {
      debugSimAbort = null;
      resolve();
    }, ms);
    debugSimAbort = (reason) => {
      window.clearTimeout(t);
      debugSimAbort = null;
      reject(reason);
    };
  });

// 当前 realtime 会话的 sessionId，stt-ready 事件到达时写入，stt_start 之前清空。
// finalize 后调 AI refine chat stream 时作为 task_id 透传，让服务端把 ASR 与
// 口语优化两侧日志关联起来。Module 级足够——同一时刻只有一个 stt session。
let currentSttSessionId: string | null = null;

// stt-ready 是否在本次录音生命周期内到达。WS 握手慢于录音时长时这个一直是 false：
// 期间 audio callback 因 slot=None 静默丢帧，会话一帧 PCM 都没传到服务端，
// finalize 必然空转 FINALIZE_WAIT_MS 才返回空串。finalizeAndWriteHistory 用它
// 短路掉 stt_finalize 的等待，直接走 transcribe_recording_file 的 REST 重转，
// 与历史记录里「重试」按钮同一条降级路径。
let realtimeReadyDuringRecording = false;

// Rust dispatch 完成后通过 stt-provider-resolved 事件透出本次会话最终落到的通道。
// REALTIME 主路径用它写 history.provider_kind；UTTERANCE 主路径不开 WS，由
// transcribe_recording_file 的返回值给出 providerKind。
let resolvedProviderKindForCurrentSession:
  | "saas-realtime"
  | "saas-file"
  | "tencent-realtime"
  | "tencent-file"
  | "aliyun-realtime"
  | "aliyun-file"
  | null = null;

// 录音开始瞬间抓的前台应用名，best-effort：invoke 异步返回，结束时若已回填就写
// history.target_app；超快录音 / 失败时 null，由 add() 接受 null。
let currentSessionTargetApp: string | null = null;

// 本次 finalize 是否撞过 SaaS 401。文件转写或 refine 抛出 isSaasAuthError 时置 true，
// 等 finalize 末尾 history.add 落库拿到 id 再把 id 推给 ui store，让 main.tsx 在
// 用户登录回来后用这个 id 自动续转写并弹结果 dialog。
//
// 模块级而非闭包：401 路径分散在 finalize 内三处 try/catch（file / finalize / refine），
// 用闭包要在 finalize 入口就把"标记 + reset"挂到栈上，调用面更乱；模块级配合
// "录音开始时 reset" 已经够用——同一时刻只有一次 finalize 在跑。
let pendingAuthLossThisSession = false;

// 失败原因翻译：Rust 端 stt_start 失败典型文案：
//   "not authenticated; login first"
//   "audio stream not running; start mic first"
//   "realtime connect: network error: HTTP error: 500 Internal Server Error"
//   "realtime connect: network error: ..."
//   "send_start: ..."
// 归一成一句人话给 toast——用户不需要看 Rust 层层包装的原文。
const humanizeSttError = (raw: unknown): string => {
  const msg = String(raw ?? "");
  if (msg === "byok_not_implemented_yet" || msg.includes("byok_not_implemented_yet")) {
    return i18n.t("overlay:error.byok_not_implemented");
  }
  if (msg === "byok_missing_credentials" || msg.includes("byok_missing_credentials")) {
    return i18n.t("overlay:error.byok_missing_credentials");
  }
  if (msg.startsWith("byok_keyring_error") || msg.includes("byok_keyring_error")) {
    return i18n.t("overlay:error.byok_keyring_error");
  }
  // 腾讯 BYOK 实时通道的 vendor 错误码（PR-4）。Rust 端 backends/tencent.rs 把
  // 4002 / 4004-4005 / 4008 映射成下面三个稳定字符串后透传 asr-error。
  if (msg === "unauthenticated_byok" || msg.includes("unauthenticated_byok")) {
    return i18n.t("overlay:error.unauthenticated_byok");
  }
  if (msg === "insufficient_funds" || msg.includes("insufficient_funds")) {
    return i18n.t("overlay:error.insufficient_funds");
  }
  if (msg === "idle_timeout" || msg.includes("idle_timeout")) {
    return i18n.t("overlay:error.idle_timeout");
  }
  if (msg === "rate_limited" || msg.includes("rate_limited")) {
    return i18n.t("overlay:error.rate_limited");
  }
  if (msg.includes("aliyun_invalid_audio_format")) {
    return i18n.t("overlay:error.aliyun_invalid_audio_format");
  }
  if (msg.includes("aliyun_quota_exceeded")) {
    return i18n.t("overlay:error.aliyun_quota_exceeded");
  }
  // 阿里 BYOK 文件转写（PR-7）：OSS 上传 + filetrans 异步任务两段错误链路。
  if (msg.includes("aliyun_oss_upload_failed")) {
    return i18n.t("transcribe.aliyun_oss_upload_failed", { ns: "pages" });
  }
  if (msg.includes("aliyun_file_too_large")) {
    return i18n.t("overlay:error.aliyun_file_too_large");
  }
  if (msg.includes("aliyun_filetrans_timeout")) {
    return i18n.t("overlay:error.aliyun_filetrans_timeout");
  }
  if (msg.includes("aliyun_filetrans_failed")) {
    const detail = msg.split("aliyun_filetrans_failed:").pop()?.trim() || "";
    return i18n.t("overlay:error.aliyun_filetrans_failed", { msg: detail });
  }
  if (msg.includes("aliyun_upload_failed")) {
    const detail = msg.split("aliyun_upload_failed:").pop()?.trim() || "";
    return i18n.t("overlay:error.aliyun_upload_failed", { msg: detail });
  }
  if (msg.includes("aliyun_unauthenticated")) {
    return i18n.t("overlay:error.aliyun_unauthenticated");
  }
  if (msg.includes("aliyun_rate_limited")) {
    return i18n.t("overlay:error.aliyun_rate_limited");
  }
  if (msg.includes("aliyun_network_error")) {
    return i18n.t("overlay:error.stt_network");
  }
  if (msg.includes("file_too_large_for_tencent_byok")) {
    return i18n.t("overlay:error.file_too_large_for_tencent_byok");
  }
  if (msg.includes("tencent_task_timeout")) {
    return i18n.t("overlay:error.tencent_task_timeout");
  }
  if (msg.includes("tencent_task_failed")) {
    const detail = msg.split("tencent_task_failed:").pop()?.trim() || "";
    return i18n.t("overlay:error.tencent_task_failed", { msg: detail });
  }
  if (msg.includes("tencent_unauthenticated")) {
    return i18n.t("overlay:error.tencent_unauthenticated");
  }
  if (msg.includes("tencent_rate_limited")) {
    return i18n.t("overlay:error.tencent_rate_limited");
  }
  if (msg.includes("tencent_network_error")) {
    return i18n.t("overlay:error.stt_network");
  }
  if (msg.includes("tencent_cos_bucket_required")) {
    return i18n.t("transcribe.tencent_cos_bucket_required", { ns: "pages" });
  }
  if (msg.includes("tencent_cos_upload_failed")) {
    return i18n.t("transcribe.tencent_cos_upload_failed", { ns: "pages" });
  }
  if (msg.includes("tencent_cos_unauthenticated")) {
    return i18n.t("overlay:error.tencent_cos_unauthenticated");
  }
  if (msg.includes("tencent_cos_forbidden")) {
    return i18n.t("overlay:error.tencent_cos_forbidden");
  }
  if (msg.includes("tencent_cos_network")) {
    return i18n.t("overlay:error.tencent_cos_network");
  }
  if (msg.includes("tencent_cos_unknown")) {
    return i18n.t("overlay:error.tencent_cos_unknown");
  }
  if (msg.includes("not authenticated")) return i18n.t("overlay:error.stt_not_authenticated");
  if (msg.includes("HTTP error: 5")) return i18n.t("overlay:error.stt_5xx");
  if (msg.includes("HTTP error: 4")) return i18n.t("overlay:error.stt_4xx");
  if (msg.includes("audio stream not running")) return i18n.t("overlay:error.stt_mic_not_ready");
  if (msg.includes("network error")) return i18n.t("overlay:error.stt_network");
  const short = msg.split(":").pop()?.trim() || msg;
  return short.length > 60 ? short.slice(0, 60) + "…" : short;
};

// 下面几个带副作用的 recording helper 仅主窗口执行——overlay 也会跑状态机来
// 驱动自身 UI，但 Rust 侧 recording_slot / stt session 都是进程全局单例，只允许
// 一方写入。
//
// auth 错误判定收敛到 Rust 侧返回的稳定串：transcribe / stt 用 `unauthorized`、
// `not authenticated`，ai_refine SaaS 路径用 `saas_unauthorized:`。custom 模式
// 由调用方按 `aiSettings.mode === "custom"` 路由，不进 auth-lost 流程——子串
// grep "401" 会把 BYOK 自己的 provider 401 误判成 OpenLoaf 登录过期，把用户的
// 录音 + history 一起丢掉。
const ERR_PREFIX_SAAS_AUTH = "saas_unauthorized";

const isSaasAuthError = (msg: string) =>
  msg === "unauthorized" ||
  msg === "not authenticated" ||
  msg.startsWith(`${ERR_PREFIX_SAAS_AUTH}:`) ||
  msg.startsWith(`${ERR_PREFIX_SAAS_AUTH} `) ||
  msg.startsWith("unauthorized:") ||
  msg.startsWith("not authenticated:");

// SaaS 登录已过期：弹登录框，但**不丢录音、不切 idle**。让 finalize 主流程自己
// 把已经拿到的 raw text / rec 文件写进 history（status=failed 也行），用户至少
// 能从历史里复制 / 重试。
// 仅适用于 finalize 阶段（录音已结束、转写或 refine 才发现 401）；录音还没起来
// 的场景见 `discardAndOpenLogin`。
const openLoginAfterSaasAuthLost = () => {
  if (!IS_MAIN_WINDOW) return;
  console.warn("[stt] saas auth lost (401) → opening login (recording/history preserved)");
  // 标记本次 finalize 撞了 401。finalize 末尾的 history.add 会读这个标记，把
  // 刚落库的 history id 透给 ui store，由 main.tsx 在登录回来后续转 + 弹 dialog。
  pendingAuthLossThisSession = true;
  useUIStore.getState().openLogin();
};

// 录音都没起来就 401（stt_start 阶段）：内存 PCM 还没攒、录音文件也没落盘，
// 直接清场 + 弹登录。但仍写一条 failed history 让用户事后能看到"这次按了快捷键，登录已过期"。
const discardAndOpenLogin = () => {
  if (!IS_MAIN_WINDOW) return;
  console.warn("[stt] auth lost (401) before recording → discarding session + opening login");
  recordAbortFailureHistory(i18n.t("overlay:error.stt_not_authenticated"));
  discardRecording();
  stopMic();
  useRecordingStore.setState({
    state: "idle",
    activeId: null,
    audioLevels: emptyLevels(),
    recordingId: null,
    liveTranscript: "",
  });
  useUIStore.getState().openLogin();
};

// 录音 / 转写完全没起来就失败：discard 录音 + 写一条 failed history，
// 让用户事后能在历史里看到"几点几分发生了一次启动失败 + 真实原因"。
// audio_path / duration_ms 都是 0/null（音频根本没落盘）。
const abortToIdle = (
  errorTitle: string,
  errorDesc: string,
  toastExtras?: Pick<OverlayToastOptions, "action" | "durationMs">,
) => {
  if (!IS_MAIN_WINDOW) return;
  recordAbortFailureHistory(errorDesc || errorTitle);
  discardRecording();
  stopMic();
  useRecordingStore.setState({
    state: "idle",
    activeId: null,
    audioLevels: emptyLevels(),
    recordingId: null,
    liveTranscript: "",
  });
  notifyOverlay("error", errorTitle, {
    description: errorDesc,
    ...(toastExtras ?? {}),
  });
};

// 自定义供应商配置不全 / keyring 读取失败——这两类错误都是用户自己设的 BYOK 不可
// 用，给一个一键切回云端的快捷出口。byok_provider_not_configured 由 Rust dispatch
// 上层吞掉走了 SaaS（dictation_fallback 路径），这里不会再漏出。
const isByokSwitchableError = (raw: unknown): boolean => {
  const msg = String(raw ?? "");
  return (
    msg.includes("byok_missing_credentials") || msg.includes("byok_keyring_error")
  );
};

const byokSwitchToSaasAction = (): {
  label: string;
  key: OverlayToastActionKey;
} => ({
  label: i18n.t("overlay:toast.byok_switch_to_saas.action"),
  key: "switch_to_saas",
});

const startRecordingSession = (id: string) => {
  if (!IS_MAIN_WINDOW) return;
  // 每次 start 前清掉上一次会话残留的 sessionId，避免本次 stt-ready 还没到时
  // 把上一次的 sessionId 误带给本次 refine。
  currentSttSessionId = null;
  resolvedProviderKindForCurrentSession = null;
  // 上一次的 401 标记同样属于上一会话残留，必须清——否则本次成功的录音也会
  // 被误推给 ui 触发"登录后续转"。
  pendingAuthLossThisSession = false;
  // 全局快捷键不会改变前台焦点，此刻拿到的就是用户原本在用的 app。invoke 通常
  // < 100ms 完成，录音持续 1s+，结束时大概率已回填；超短录音兜底为 null。
  currentSessionTargetApp = null;
  void getActiveAppName().then((name) => {
    currentSessionTargetApp = name;
  });
  void startRecordingToFile(id)
    .then(() => {
      // UTTERANCE 走"录音→文件转写"主路径，全程不开 WS——避免网络抖动半路截断，
      // 也省下一条 WS 心跳。WS 仅 REALTIME 模式开。
      const segmentMode = getEffectiveSegmentMode();
      if (segmentMode !== "REALTIME") return;
      startSttSession({
        mode: "auto",
        provider: buildProviderRef(),
        lang: currentDictationLang(),
      }).catch((e) => {
        const raw = String(e ?? "");
        if (isSaasAuthError(raw)) {
          discardAndOpenLogin();
          return;
        }
        console.warn("[stt] start failed → aborting recording:", e);
        const isByok = isByokSwitchableError(e);
        abortToIdle(
          i18n.t("overlay:toast.stt_start_failed.title"),
          i18n.t("overlay:toast.stt_start_failed.description", {
            reason: humanizeSttError(e),
          }),
          isByok
            ? { action: byokSwitchToSaasAction(), durationMs: 0 }
            : undefined,
        );
      });
    })
    .catch((e) => {
      console.error("[recording] start recording failed → aborting:", e);
      abortToIdle(
        i18n.t("overlay:toast.recording_start_failed.title"),
        String(e),
      );
    });
};

// STT 失败 / 超时时 history.text 的占位——保留之前"待转写"语义，区分 success 与 failed
// 状态：有 Final 文字 → success；空串 → failed（此时 text 用占位，UI 可据 status 分别展示）。
const transcriptPlaceholder = () => i18n.t("overlay:transcript.placeholder");

// 写一条 audio 已被丢弃的 failed history（duration=0, audio_path=null）。
// 用于"录音中途出错强制 abort"的事件路径——audio-stream-error / worker_dead /
// insufficient_credits / startMic 失败 / abortToIdle 等：用户值得在历史里看到
// "几点几分发生了一次 X 错误"，而不是只看到悬浮条一闪而过。
const recordAbortFailureHistory = (errorMsg: string) => {
  if (!IS_MAIN_WINDOW) return;
  const wasTranslate = useRecordingStore.getState().activeId === "translate";
  void useHistoryStore
    .getState()
    .add({
      type: wasTranslate ? "translate" : "dictation",
      text: transcriptPlaceholder(),
      status: "failed",
      error: errorMsg,
      duration_ms: 0,
      target_app: currentSessionTargetApp,
      target_lang: wasTranslate
        ? useSettingsStore.getState().general.translateTargetLang
        : null,
    })
    .catch((e) => console.warn("[recording] recordAbortFailureHistory failed:", e));
};

type FinalizeOutcome = {
  rec: RecordingResult | null;
  text: string; // 最终转写文字，空串表示失败 / 超时
  /** 用户激活了录音但全程没说话（落盘前 VAD 判定）。调用方据此走 idle 而非 error，并不写历史。 */
  silent?: boolean;
};

/**
 * 主窗口独占：先停 mic 再 finalize ASR，确保 cpal 回调里最后一批 PCM 已经全部
 * 入 ctrl_tx，再让 IPC 线程发 Finish——否则 Finish 与尾部 audio 会在同一个 mpsc
 * 通道上抢生产者顺序，服务端可能在拿到完整音频前就被 client_finish 关掉，
 * 导致 0 段 Final + credits=0 的"假静音"。
 */
const finalizeAndWriteHistory = async (): Promise<FinalizeOutcome> => {
  if (!IS_MAIN_WINDOW) return { rec: null, text: "" };
  const segmentModeAtStop = getEffectiveSegmentMode();
  console.info(`[recording] finalizeAndWriteHistory entering, mode=${segmentModeAtStop}`);
  // 端到端耗时分段统计（写入 history.asr_ms / refine_ms，UI 可在 result 模式展示）。
  // asr 起点 = finalize 入口（用户结束录音的瞬间）；终点在拿到 final transcript 时记录。
  const finalizeStartedAt = performance.now();
  let asrMsForHistory: number | null = null;
  let refineMsForHistory: number | null = null;
  // ASR 路径上的真实错误（人话，已 i18n）。任何"用户能感知到的失败"都要落到这里，
  // 最终写进 history.error 让用户事后能在历史里看到具体原因，而不是只看到悬浮条一闪而过。
  let asrErrorMsg: string | null = null;
  // refine / 翻译 phase2 的错误。raw transcript 已拿到但 AI 整理 / 翻译失败时填这里。
  // - 听写 + AI refine 失败：status=success，error 仅作备注（用户拿到了 raw 文字）。
  // - 翻译模式 phase2 失败：status=failed（用户期望的是译文，没拿到 == 未达成意图）。
  let refineErrorMsg: string | null = null;
  const recSettled = await Promise.allSettled([stopRecordingAndSave()]).then((r) => r[0]);

  // 离线 VAD 判定整段无人声：录音文件未落盘（audio_path 空串）、跳过 ASR / 历史 / 注入，
  // 走 silent 分支让调用方把 pill 切到 error 态显示提示。**不发独立 toast**——
  // 否则 pill 立即 exit + toast 单独出现，视觉上是"内容跳一下"。让 pill 中心
  // 从 transcribing 进度条 crossfade 到 ERROR + 提示文字，过渡平滑。
  if (recSettled.status === "fulfilled" && recSettled.value.voiced === false) {
    const recv = recSettled.value;
    console.info(
      `[recording] silent recording (no voice) raw=${recv.raw_duration_ms}ms → skip stt + history`,
    );
    void cancelSttSession();
    resetIncrementalInject();
    return { rec: null, text: "", silent: true };
  }

  // UTTERANCE：主路径直接走文件转写——录音过程压根没开 WS，没有 finalize 可调。
  // 与原"WS 握手没到 → degrade"分支语义合并；保留 realtimeDegradedToFile 仅给
  // REALTIME 失败兜底用。
  if (segmentModeAtStop !== "REALTIME") {
    realtimeDegradedToFile = true;
  } else if (
    !realtimeReadyDuringRecording &&
    !realtimeDegradedToFile
  ) {
    // REALTIME 但 WS 握手始终没到：会话一帧 audio 都没送到服务端，
    // stt_finalize 必然空转 FINALIZE_WAIT_MS 后返回空串。直接 cancel ws 走文件转写兜底。
    console.info("[stt] ws never ready during recording → degrade to file transcribe");
    realtimeDegradedToFile = true;
    void cancelSttSession();
  }

  // degrade 时跳过 finalize 的 3s 兜底等待——asr-error / ws-not-ready / UTTERANCE
  // 主路径都拿不到 Final，等待纯属浪费用户从松手到出字的延迟。
  const sttSettled: PromiseSettledResult<string> = realtimeDegradedToFile
    ? { status: "fulfilled", value: "" }
    : await Promise.allSettled([finalizeSttSession()]).then((r) => r[0]);
  const rec = recSettled.status === "fulfilled" ? recSettled.value : null;
  let text =
    sttSettled.status === "fulfilled" && sttSettled.value ? sttSettled.value : "";
  console.info(
    `[finalize] mode=${segmentModeAtStop} sttStatus=${sttSettled.status} textLen=${text.length} recDurMs=${rec?.duration_ms ?? "n/a"} degraded=${realtimeDegradedToFile}`,
  );

  // 文件转写主线：
  //   - UTTERANCE 主路径——录音结束后整段提交（无 partial，松手才出字）。
  //   - REALTIME repeat-bug / WS 握手没到的兜底——复用同一文件转写接口。
  // 5min 上限护栏只对 UTTERANCE 主路径触发：REALTIME 失败兜底已经把前半段 partial
  // 注入到光标，超长拒转更难收尾，按现状放过（后续 REALTIME 文件兜底另行限制）。
  if (realtimeDegradedToFile) {
    if (rec) {
      const TOO_LONG_MS = 5 * 60 * 1000;
      if (segmentModeAtStop !== "REALTIME" && rec.duration_ms > TOO_LONG_MS) {
        console.warn(
          `[stt] utterance recording too long (${rec.duration_ms}ms) → skip transcribe`,
        );
        const tooLongMsg = i18n.t("transcribe.too_long_for_utterance", { ns: "pages" });
        notifyOverlay("error", tooLongMsg, {
          durationMs: 6000,
        });
        asrErrorMsg = tooLongMsg;
        text = "";
      } else {
        try {
          console.info(
            "[stt] file transcribe, audio=",
            rec.audio_path,
            "duration=",
            rec.duration_ms,
          );
          const r = await transcribeRecordingFile({
            audioPath: rec.audio_path,
            durationMs: rec.duration_ms,
            lang: currentDictationLang(),
            provider: buildProviderRef(),
          });
          text = r.text;
          resolvedProviderKindForCurrentSession = r.providerKind;
          console.info(
            `[stt] file transcribe → got ${r.text.length} chars (variant=${r.variant} kind=${r.providerKind})`,
          );
        } catch (e) {
          const raw = String(e ?? "");
          if (isSaasAuthError(raw)) {
            // SaaS 转写过期：弹登录但保留录音 + 让 finalize 把 history 标 failed
            // 写下去，用户能在历史里看到这次失败 + 录音文件。不再切 idle。
            openLoginAfterSaasAuthLost();
            asrErrorMsg = i18n.t("overlay:error.stt_not_authenticated");
            text = "";
          } else {
            console.warn("[stt] file transcribe failed:", e);
            const desc = humanizeSttError(e);
            const isByok = isByokSwitchableError(e);
            notifyOverlay("error", i18n.t("overlay:toast.transcribe_failed.title"), {
              description: desc,
              ...(isByok
                ? { action: byokSwitchToSaasAction(), durationMs: 0 }
                : {}),
            });
            asrErrorMsg = desc;
            text = "";
          }
        }
      }
    } else {
      console.warn("[stt] degraded but no rec; can't file transcribe");
    }
  } else if (sttSettled.status === "rejected") {
    console.warn("[stt] finalize failed:", sttSettled.reason);
    // "no active stt session" 是 start 失败后的必然后续——start 那步已经 toast 过，
    // 这里不重复骚扰。其他错误才弹。
    const reason = String(sttSettled.reason ?? "");
    if (!reason.includes("no active stt session")) {
      const desc = humanizeSttError(sttSettled.reason);
      const isByok = isByokSwitchableError(sttSettled.reason);
      notifyOverlay("error", i18n.t("overlay:toast.transcribe_failed.title"), {
        description: desc,
        ...(isByok
          ? { action: byokSwitchToSaasAction(), durationMs: 0 }
          : {}),
      });
      asrErrorMsg = desc;
    } else {
      // start 已经记录过原因（错误已经经 abortToIdle 落 history），但本次 finalize
      // 还是要给个非空错误码，否则 history.add 会兜底成 "no final transcript"。
      asrErrorMsg = i18n.t("overlay:error.stt_mic_not_ready");
    }
  } else if (sttSettled.status === "fulfilled" && !sttSettled.value) {
    // 0 段 Final：可能是真静音、也可能是服务端没识别成功。无论哪种用户都该
    // 看到反馈，否则"按了快捷键啥都没发生"比错误提示更糟。toast 几秒自动消失。
    console.warn("[stt] no final transcript (silent or timeout)");
    const desc = i18n.t("overlay:toast.transcribe_failed.no_transcript");
    notifyOverlay("error", i18n.t("overlay:toast.transcribe_failed.title"), {
      description: desc,
      durationMs: 5000,
    });
    asrErrorMsg = desc;
  }

  // 拿到 transcript 后切到 "injecting"（"输出中"）的时机分两种：
  // - 非 refine：直接整段贴到光标，没有"模型思考"阶段，立即切。
  // - refine 启用：模型还在思考、首 token 没到，UI 留在 transcribing
  //   （"思考中"）。等 onDelta 拿到第一个 chunk 再切；catch 路径在 try 块
  //   出来时兜底切，保证非正常路径也能进入"输出中"。
  // text 已最终敲定（无论 REALTIME finalize 还是 UTTERANCE file transcribe 走完）——
  // 这一刻就是 ASR 阶段的终点，记录耗时供 history.asr_ms 落库。失败路径同样记录，
  // 反映"用户从结束录音到响应（哪怕是错误响应）等了多久"。
  asrMsForHistory = Math.round(performance.now() - finalizeStartedAt);
  const segmentMode = getEffectiveSegmentMode();
  // 翻译听写：activeId === "translate" 时强制走 chat stream 走翻译 prompt，
  // 把 transcript 译成目标语言后再注入；忽略 aiRefine.enabled。
  const translateMode = useRecordingStore.getState().activeId === "translate";
  const refineActive = translateMode || isAiRefineActive();
  if (
    text &&
    IS_MAIN_WINDOW &&
    useRecordingStore.getState().state === "transcribing" &&
    !refineActive
  ) {
    useRecordingStore.setState({ state: "injecting", pillEarlyHide: false });
  }
  if (recSettled.status === "rejected") {
    console.error("[recording] stop failed:", recSettled.reason);
    const desc = String(recSettled.reason);
    notifyOverlay("error", i18n.t("overlay:toast.recording_save_failed.title"), {
      description: desc,
    });
    // 录音落盘失败时优先记这个原因——比 "transcribe failed" 更接近根因。
    asrErrorMsg = `${i18n.t("overlay:toast.recording_save_failed.title")}: ${desc}`;
  }

  // refine 启用：拿到原始 transcript 后强制走 AI refine chat stream，每个 Delta 通过
  // injectIncremental 实时敲到光标位置（剪贴板 + Cmd/Ctrl+V 单字符段）。
  // 流结束后把整段 refinedText 写回剪贴板，覆盖最后一段 delta，让用户后续
  // Cmd+V / Cmd+C 都拿到完整内容。
  //
  // 热词：dictionary 派生 hotwords + 进程内缓存 cacheId（v0.3.6+）。后端优先
  // 走 cacheId 命中路径，410 时自动回退明文重发，前端只需透传两者。
  //
  // 流式失败 / auth 异常时 refinedText 保持 null，最终 finalText = text，
  // 走原 UTTERANCE 路径整段贴到光标。
  let refinedText: string | null = null;
  // 翻译模式专用：phase2 LLM 的 *仅译文* 输出。bilingual 注入/剪贴板用 streamedSoFar
  // （原文 + 换行 + 译文），但 history.refined_text 只该存译文，让 result 模式能把
  // 原文（history.text）和译文（history.refined_text）分组渲染、不重复。
  let translationOnlyText: string | null = null;
  // history 详情底部要显示"实际调用的 AI 模型"。即便 refine 失败也要记录"试过谁"。
  let aiModelLabel: string | null = null;
  // DEV 构建：累积发出的 LLM 请求快照，最后写到 history.debug_payload。
  // 单段 refine 是单 envelope；翻译模式收集 phase1+phase2 两条；正式版恒空。
  const debugEnvelopes: string[] = [];
  console.info(
    `[refine] gate textLen=${text.length} segmentMode=${segmentMode} refineEnabled=${refineActive} willCallRefine=${!!text && refineActive}`,
  );
  if (text && refineActive) {
    const hotwords = getHotwordsArray();
    resetIncrementalInject();
    let streamedSoFar = "";
    const refineStart = performance.now();
    const aiSettings = useSettingsStore.getState().aiRefine;
    const generalSettings = useSettingsStore.getState().general;
    const lang = resolveLang(generalSettings.interfaceLang);
    const targetLang = generalSettings.translateTargetLang;
    const targetLangName = TRANSLATE_LANG_NAMES[targetLang] ?? targetLang;
    // 翻译走 pipeline：phase 1 用 refine prompt 清洗（处理"嗯/啊/呃"和撤回信号），
    // phase 2 用独立 translation prompt 翻译 phase 1 输出。两个 prompt 各自缓存。
    const refineSystemPrompt = getEffectiveAiSystemPrompt(
      aiSettings.customSystemPrompt,
      lang,
    );
    const translationSystemPrompt = translateMode
      ? `${getEffectiveAiTranslationSystemPrompt(
          aiSettings.customTranslationSystemPrompt,
          lang,
        )}\n\nTarget language: ${targetLangName}`
      : null;
    const bilingual =
      translateMode && generalSettings.translateOutputMode === "bilingual";
    const HISTORY_TURNS = 5;
    const requestTimeMs = Date.now();
    const requestTime = `${new Date(requestTimeMs).toISOString()} (UTC)`;
    let historyEntries: string[] | undefined;
    if (aiSettings.includeHistory) {
      const items = useHistoryStore.getState().items;
      const picked = items
        .filter((it) => it.status === "success")
        .slice(0, HISTORY_TURNS)
        .reverse();
      const minutesAgoLabel = i18n.t("ai.minutes_ago", {
        ns: "settings",
        defaultValue: "minutes ago",
      });
      const lines = picked
        .map((it) => {
          const content = (it.refined_text ?? it.text ?? "").trim();
          if (!content) return "";
          const clipped = clipHistoryEntry(content);
          const mins = Math.max(1, Math.floor((requestTimeMs - it.created_at) / 60000));
          return `[${mins} ${minutesAgoLabel}] ${clipped}`;
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
    aiModelLabel =
      aiSettings.mode === "custom" && activeProvider
        ? `${activeProvider.name} · ${activeProvider.model}`
        : aiSettings.mode === "saas"
          ? "OpenLoaf SaaS"
          : null;
    console.info(
      `[ai-refine] stream start mode=${aiSettings.mode} textLen=${text.length} hotwordsLen=${hotwords.length} historyLen=${historyEntries?.length ?? 0} provider=${activeProvider?.id ?? "saas"}`,
    );
    // 翻译流程的 phase1（refine）是否完成。catch 块据此区分 phase1 / phase2 失败。
    let translatePhase1Done = false;
    try {
      if (aiSettings.mode === "custom" && !activeProvider) {
        throw new Error("no_active_custom_provider");
      }
      const customParams = {
        customBaseUrl: activeProvider?.baseUrl,
        customModel: activeProvider?.model,
        customKeyringId: activeProvider
          ? `ai_provider_${activeProvider.id}`
          : undefined,
      };
      const onChunk = (chunk: string) => {
        streamedSoFar += chunk;
        if (
          IS_MAIN_WINDOW &&
          useRecordingStore.getState().state === "transcribing"
        ) {
          useRecordingStore.setState({ state: "injecting", pillEarlyHide: false });
        }
        // Home Live 面板也跟着 refine 流式输出；同时让 idle 转换时
        // lastTranscriptRef 拿到清洗后的最终文本，result 模式才能挂留它。
        useRecordingStore.setState({ liveTranscript: streamedSoFar });
        injectIncremental(streamedSoFar);
      };
      // phase 1 = refine：处理填充词、撤回信号、长段分段。
      // - non-translate / bilingual：流式注入（用户实时看到清洗后的原文）
      // - target_only：静默累计 token（pill 留在"思考中"），等 phase 2 才注入译文
      const noopChunk = (_chunk: string) => {};
      const phase1OnChunk =
        translateMode && !bilingual ? noopChunk : onChunk;
      const domainsForPrompt = getDomainNamesForPrompt(aiSettings.selectedDomains);
      const r = await refineTextViaChatStream(
        {
          mode: aiSettings.mode,
          systemPrompt: refineSystemPrompt,
          userText: text,
          hotwords: hotwords.length > 0 ? hotwords : undefined,
          historyEntries,
          requestTime,
          targetApp: currentSessionTargetApp ?? undefined,
          domains: domainsForPrompt.length > 0 ? domainsForPrompt : undefined,
          ...customParams,
          taskId: currentSttSessionId ?? undefined,
        },
        phase1OnChunk,
      );
      if (import.meta.env.DEV && r.requestEnvelope) {
        debugEnvelopes.push(r.requestEnvelope);
      }
      const refinedSrc = r.refinedText;
      translatePhase1Done = true;
      // phase 2 = translate：用独立 translation prompt 翻译 phase 1 的清洗版。
      // bilingual 在原文与译文之间注入空行；target_only 跳过分隔（streamedSoFar 仍是 ""）。
      if (translateMode) {
        // phase 2 期间 pill 显示"翻译中"。onChunk 仅在 state==="transcribing" 时切到
        // injecting，所以这里手动切到 translating 后整个 phase 2 都保持 translating。
        if (IS_MAIN_WINDOW) {
          useRecordingStore.setState({
            state: "translating",
            pillEarlyHide: false,
          });
        }
        if (bilingual) {
          // 原文 / 译文之间用单个换行分隔；phase 1 末尾 LLM 自带 \n 时不再叠加
          const trailing = /\n*$/.exec(streamedSoFar)?.[0].length ?? 0;
          const need = Math.max(0, 1 - trailing);
          if (need > 0) {
            streamedSoFar += "\n".repeat(need);
            injectIncremental(streamedSoFar);
          }
        }
        let phase2FirstChunkPending = bilingual;
        const phase2OnChunk = (chunk: string) => {
          if (phase2FirstChunkPending) {
            chunk = chunk.replace(/^\s+/, "");
            if (!chunk) return;
            phase2FirstChunkPending = false;
          }
          onChunk(chunk);
        };
        const r2 = await refineTextViaChatStream(
          {
            mode: aiSettings.mode,
            systemPrompt: translationSystemPrompt!,
            userText: refinedSrc,
            hotwords: hotwords.length > 0 ? hotwords : undefined,
            requestTime,
            domains: domainsForPrompt.length > 0 ? domainsForPrompt : undefined,
            ...customParams,
            taskId: currentSttSessionId ?? undefined,
          },
          phase2OnChunk,
        );
        if (import.meta.env.DEV && r2.requestEnvelope) {
          debugEnvelopes.push(r2.requestEnvelope);
        }
        refinedText = bilingual ? streamedSoFar : r2.refinedText;
        translationOnlyText = r2.refinedText;
      } else {
        refinedText = refinedSrc;
      }
      refineMsForHistory = Math.round(performance.now() - refineStart);
      console.info(
        `[ai-refine] stream done refinedLen=${refinedText.length} elapsedMs=${refineMsForHistory}`,
      );
      flushPendingInject();
      // 流式 token 已全部排队，剩下的只是 injectChain 中的最后几次 paste +
      // 末尾 diff 兜底。这一刻让 overlay pill 提前 exit，用户视感是"还有一点点
      // 文字时悬浮栏淡出"，而不是"全部敲完才消失"，节奏快一拍。
      if (IS_MAIN_WINDOW) {
        useRecordingStore.setState({ pillEarlyHide: true });
      }
      try {
        await injectChain;
      } catch {}
      // ESC 在流末/末尾兜底之前完成取消时，state 已切 idle——不再覆盖用户剪贴板。
      // 用户关了"自动复制到剪贴板"时也跳过——若一次性 paste 路径内部用过剪贴板，
      // pasteAllAtOnce 已自行还原。
      if (
        isInjectFlowActive() &&
        useSettingsStore.getState().dictation.clipboardCopy
      ) {
        try {
          await writeClipboard(refinedText);
        } catch (e) {
          console.warn("[clipboard] post-refine writeText failed:", e);
        }
      }
    } catch (e) {
      const raw = String(e ?? "");
      // 区分 phase1（refine）/ phase2（翻译）失败 — 翻译模式下 phase2 失败的语义
      // 是"用户期望的译文没拿到"，写 history 时要标 failed；phase1 失败则只是
      // raw 文字 → 失败 fallback。前缀让用户在历史里一眼看出"是 AI 哪一步出问题"。
      const phaseLabel = translateMode
        ? translatePhase1Done
          ? `${i18n.t("errors:phase.translate")}: `
          : `${i18n.t("errors:phase.refine")}: `
        : `${i18n.t("errors:phase.refine")}: `;
      // 优先按 mode 路由：custom 401 是用户自己的 provider key 错，绝不能弹
      // OpenLoaf 登录框；saas 401 才是真过期。
      if (aiSettings.mode === "custom") {
        console.warn(
          `[refine] custom failed after ${Math.round(performance.now() - refineStart)}ms: ${raw}`,
        );
        const desc = humanizeSttError(e);
        const handled = await handleAiRefineCustomFailure(e);
        if (!handled) {
          notifyOverlay(
            "warning",
            i18n.t("overlay:toast.transcribe_failed.title"),
            { description: desc },
          );
        }
        refineErrorMsg = `${phaseLabel}${desc}`;
      } else if (isSaasAuthError(raw)) {
        console.warn(
          `[refine] saas auth lost after ${Math.round(performance.now() - refineStart)}ms: ${raw}`,
        );
        // 弹登录，但**不丢录音、不切 idle**：raw text 已拿到，外面会继续走
        // 末尾兜底 paste + history.add（status=success / refined_text=null）。
        openLoginAfterSaasAuthLost();
        refineErrorMsg = `${phaseLabel}${i18n.t("overlay:error.stt_not_authenticated")}`;
      } else {
        console.warn(
          `[refine] stream failed after ${Math.round(performance.now() - refineStart)}ms, falling back to raw transcript:`,
          e,
        );
        const desc = humanizeSttError(e);
        notifyOverlay(
          "warning",
          i18n.t("overlay:toast.transcribe_failed.title"),
          { description: desc },
        );
        refineErrorMsg = `${phaseLabel}${desc}`;
      }
    }
    // refine / translate 一个 chunk 都没到就抛错（network / auth / 0 token） →
    // 仍停留在 transcribing 或 translating。切到 injecting 让"输出中"在末尾兜底 paste 时显示。
    if (
      IS_MAIN_WINDOW &&
      (useRecordingStore.getState().state === "transcribing" ||
        useRecordingStore.getState().state === "translating")
    ) {
      useRecordingStore.setState({ state: "injecting", pillEarlyHide: false });
    }
    void streamedSoFar;
  } else if (text && !refineActive) {
    console.info(`[refine] skipped, segmentMode=${segmentMode} refineEnabled=${refineActive}`);
  }
  const finalText = refinedText ?? text;

  // ESC 取消（state 已切 idle）：不写"success/failed"历史条目——和
  // simulateCancel/discardRecording 的语义保持一致（取消即不留 history）；
  // 录音文件仍然在 rec.audio_path，以后想做"取消也保留音频"再单独走 abort 路径。
  if (rec && isInjectFlowActive()) {
    const asrSource: AsrSource = realtimeDegradedToFile
      ? "saas-rest"
      : "saas-realtime";
    // PR-3：providerKind 优先取 Rust dispatch 给的真值（stt-provider-resolved
    // 事件 / transcribe 返回值）；缺失时按当前模式兜默认（兼容老调用 + degrade
    // 但 transcribe 出错没拿到 kind 的极端路径）。
    const providerKind =
      resolvedProviderKindForCurrentSession ??
      (segmentMode === "REALTIME" ? "saas-realtime" : "saas-file");
    // 状态判定优先级：
    //   1) 没拿到 raw transcript → failed
    //   2) 拿到 raw 但翻译 phase2 失败 → failed（用户要的是译文，没拿到 = 未达成意图）
    //   3) 拿到 raw + refine 失败（非 translate）→ success（用户已拿到原文），error 字段记备注
    //   4) 全成功 → success
    const translatePhase2Failed = translateMode && refineErrorMsg !== null;
    let status: "success" | "failed";
    let errorForHistory: string | undefined;
    if (!text) {
      status = "failed";
      errorForHistory = asrErrorMsg ?? "no final transcript";
    } else if (translatePhase2Failed) {
      status = "failed";
      errorForHistory = refineErrorMsg!;
    } else if (refineErrorMsg !== null) {
      status = "success";
      errorForHistory = refineErrorMsg;
    } else {
      status = "success";
      errorForHistory = undefined;
    }
    // DEV：单段 envelope 直接落串；多段（翻译 phase1+phase2）合成 JSON 数组保存。
    let debugPayload: string | null = null;
    if (import.meta.env.DEV && debugEnvelopes.length > 0) {
      if (debugEnvelopes.length === 1) {
        debugPayload = debugEnvelopes[0];
      } else {
        try {
          debugPayload = JSON.stringify(
            debugEnvelopes.map((s) => JSON.parse(s)),
            null,
            2,
          );
        } catch {
          debugPayload = debugEnvelopes.join("\n\n");
        }
      }
    }
    const addedItem = await useHistoryStore.getState().add({
      type: translateMode ? "translate" : "dictation",
      text: text || transcriptPlaceholder(),
      refined_text: translateMode ? translationOnlyText : refinedText,
      status,
      error: errorForHistory,
      duration_ms: rec.duration_ms,
      audio_path: rec.audio_path,
      target_app: currentSessionTargetApp,
      asr_source: asrSource,
      ai_model: aiModelLabel,
      segment_mode: segmentMode,
      provider_kind: providerKind,
      target_lang: translateMode
        ? useSettingsStore.getState().general.translateTargetLang
        : null,
      asr_ms: asrMsForHistory,
      refine_ms: refineMsForHistory,
      debug_payload: debugPayload,
    });

    // 401 路径只对"raw STT 都没跑通"的情形挂 pending —— text 是空、status=failed、
    // audio 还在盘上时才有重转价值。如果 raw text 已经拿到（仅 refine 401），
    // 用户已经能在末尾兜底 paste 拿到原文，再弹一个续转 dialog 反而打扰。
    if (
      pendingAuthLossThisSession &&
      status === "failed" &&
      !text &&
      addedItem.audio_path
    ) {
      console.info(
        `[recording] saas auth lost during finalize → pending recovery historyId=${addedItem.id}`,
      );
      useUIStore.getState().setPendingAuthRecoveryHistoryId(addedItem.id);
    }
    pendingAuthLossThisSession = false;
  }

  // 末尾兜底：把"还没敲到光标的剩余部分"补完。三种模式统一走 lastInjectedText
  // diff，不再以"流过任何一段"作为整段 paste 的开关——refine 流式中途抛错
  // 或 startsWith 短路（前缀被纠错）会让 lastInjectedText 落后于真实 finalText，
  // 之前用 aiRefineStreamed 一刀切跳过 paste 会导致"前半敲到了、后半凭空丢失"，
  // 而历史 / 剪贴板里仍是完整文本——这正是用户报告的"另一半没了"根因。
  //
  // 前缀对不上（catch 后 finalText 退回原始 transcript，与已敲下的 refined 不一致）
  // → 不强行接尾，避免拼成半 refined 半 raw 的串，把整段 finalText 写剪贴板让
  // 用户手动 Cmd/Ctrl+V 拿到完整结果。
  if (finalText && isInjectFlowActive()) {
    try {
      await injectChain;
    } catch {}
    // 等 chain 排空后再确认一次：用户可能刚好在 await 期间双击 ESC 取消。
    if (!isInjectFlowActive()) {
      console.log("[inject] tail skipped: flow no longer active (esc / cancel)");
      resetIncrementalInject();
      return { rec, text: finalText };
    }
    console.log("[inject] tail enter", {
      finalLen: finalText.length,
      injectedLen: lastInjectedText.length,
      prefixMatch: finalText.startsWith(lastInjectedText),
    });
    if (finalText.startsWith(lastInjectedText)) {
      const remaining = finalText.slice(lastInjectedText.length);
      if (remaining) {
        // 用户关掉"逐字流式"：整段一次 paste（绕开微信输入法 / 部分全拼 IME 的
        // 逐字符拦截）。clipboardCopy=false 时 pasteAllAtOnce 还会还原原剪贴板。
        const streaming =
          useSettingsStore.getState().dictation.streamingInject;
        if (!streaming) {
          try {
            console.log("[inject] tail → paste-all", {
              remaining: remaining.length,
            });
            await pasteAllAtOnce(remaining);
            console.log("[inject] tail paste-all ok");
          } catch (e) {
            console.error("[inject] tail paste-all failed:", e);
            notifyOverlay("warning", i18n.t("overlay:toast.paste_failed.title"), {
              description: i18n.t("overlay:toast.paste_failed.description"),
            });
          }
        } else {
          // 末尾兜底走 inject_type 直接键入：和流式路径一致，不污染用户剪贴板。
          // 上面 L446-450 已经把整段 refinedText 写过一次剪贴板供用户手动复用，
          // 这里 remaining 不需要再走剪贴板。
          try {
            console.log("[inject] tail → type", { remaining: remaining.length });
            await invoke("inject_type", { text: remaining });
            console.log("[inject] tail type ok");
          } catch (e) {
            console.warn("[inject] tail type failed, fallback to paste:", e);
            // type 失败时降级到剪贴板路径，保证文字最终落得到。
            try {
              await writeClipboard(remaining);
              await invoke("inject_paste");
              console.log("[inject] tail paste fallback ok");
            } catch (e2) {
              console.error("[inject] tail paste fallback also failed:", e2);
              notifyOverlay("warning", i18n.t("overlay:toast.paste_failed.title"), {
                description: i18n.t("overlay:toast.paste_failed.description"),
              });
            }
          }
        }
      } else {
        console.log("[inject] tail no-op: remaining is empty (stream covered all)");
      }
    } else {
      // 前缀对不上一般是 refine 流式抛错后 finalText 退回原始 transcript，与已敲下
      // 的 refined 不一致。直接续敲会拼成"半 refined 半 raw"——不安全。退而求
      // 其次：把整段 finalText 写剪贴板，让用户手动 Ctrl/Cmd+V。
      console.warn(
        "[inject] tail prefix mismatch → clipboard-only fallback",
        {
          finalLen: finalText.length,
          injectedLen: lastInjectedText.length,
          finalHead: finalText.slice(0, 24),
          injectedHead: lastInjectedText.slice(0, 24),
        },
      );
      try {
        await writeClipboard(finalText);
        console.log("[inject] clipboard-only write ok");
      } catch (e) {
        console.error("[clipboard] writeText failed:", e);
      }
      notifyOverlay("warning", i18n.t("overlay:toast.paste_failed.title"), {
        description: i18n.t("overlay:toast.paste_failed.description"),
      });
    }
    resetIncrementalInject();
  } else if (!finalText) {
    console.log("[inject] tail skipped: empty finalText");
  }
  return { rec, text: finalText };
};

// 流式增量注入：每次上游产生新 delta，立即 invoke("inject_type") 把这段
// Unicode 字符直接键入到当前焦点输入框（enigo text()，不走剪贴板、不发 Cmd+V）。
// 多个 delta 通过 injectChain Promise 串行排队，保证字符按顺序敲下去。
//
// 不再做节流 / 批量 paste：上游 token 怎么来，键盘就怎么敲，stream 节奏即视感节奏。
// enigo text() 单字符 macOS ~5ms / Windows ~3ms / Linux X11 ~15ms，60 字符/s 完全跟得上。
let lastInjectedText = "";
let injectChain: Promise<void> = Promise.resolve();

// transcribing/injecting 期间被 ESC 取消后，FSM 切到 idle/error，但 AI refine
// 流式 stream 在 Rust 侧没有 abort 通道、deltas 仍会陆续到达——所有可能"敲到
// 用户光标 / 写用户剪贴板 / 写历史"的副作用都按这条门控就地短路。
const isInjectFlowActive = () => {
  const s = useRecordingStore.getState().state;
  return s === "transcribing" || s === "injecting" || s === "translating";
};

const flushPendingInject = () => {
  // 兼容保留：以前外部调用此函数 flush 节流 buffer，新路径无 buffer，这里成为 no-op。
  // injectChain 本身已串行排队，调用方继续 await injectChain 即可。
};

const resetIncrementalInject = () => {
  lastInjectedText = "";
};

const injectIncremental = (fullText: string) => {
  if (!IS_MAIN_WINDOW) return;
  if (!isInjectFlowActive()) return;
  // 用户关闭了"逐字流式输出"——本轮全部跳过，让末尾兜底走整段 paste。
  // 不更新 lastInjectedText，保证 finalize 时 remaining = 完整 finalText。
  if (!useSettingsStore.getState().dictation.streamingInject) return;
  // 服务端纠错把已注入的前缀改写时（极少），无法回退已敲下去的字符；
  // 跳过本轮增量，等末尾兜底 diff 把"剩余的"再敲一次（用户视觉上会出现重复，
  // 但比反复抖动更可控）。
  if (!fullText.startsWith(lastInjectedText)) return;
  const delta = fullText.slice(lastInjectedText.length);
  if (!delta) return;
  lastInjectedText = fullText;
  injectChain = injectChain.then(async () => {
    if (!isInjectFlowActive()) return;
    try {
      await invoke("inject_type", { text: delta });
    } catch (e) {
      // 把累计 + 当次 delta 一起带上，事后看日志能立刻判断是"中途某个 delta
      // 失败"还是"从头到尾就没敲进去"——后者通常是 enigo 静默失败的伴随信号。
      console.warn("[inject] incremental type failed", {
        deltaLen: delta.length,
        cumulativeLen: lastInjectedText.length,
        err: String(e),
      });
    }
  });
};

// 整段一次粘贴：写剪贴板 → invoke("inject_paste") → 视 clipboardCopy 决定是否
// 还原用户原剪贴板内容。clipboardCopy=true（默认）时保留写入的整段，方便用户
// 再次手动粘贴；false 时把粘贴前备份的旧内容写回，避免污染。
const pasteAllAtOnce = async (text: string): Promise<void> => {
  if (!text) return;
  const keepClipboard =
    useSettingsStore.getState().dictation.clipboardCopy;
  let backup: string | null = null;
  if (!keepClipboard) {
    try {
      backup = await readClipboard();
    } catch (e) {
      console.warn("[inject] read clipboard for backup failed:", e);
    }
  }
  await writeClipboard(text);
  await invoke("inject_paste");
  if (!keepClipboard) {
    // 给目标应用一点时间消化 Ctrl/Cmd+V，避免还原比 paste 更早落地。
    await new Promise((r) => setTimeout(r, 80));
    try {
      await writeClipboard(backup ?? "");
    } catch (e) {
      console.warn("[inject] restore clipboard failed:", e);
    }
  }
};

const discardRecording = () => {
  if (!IS_MAIN_WINDOW) return;
  const stack = new Error().stack?.split("\n").slice(2, 6).join(" | ");
  console.info(`[recording] discardRecording called, caller=${stack}`);
  void cancelRecording();
  void cancelSttSession();
  resetIncrementalInject();
};

// preflight：进入 preparing 之前同步检查 (1) 麦克风权限 (2) 至少有一个输入设备。
// 失败时返回 reason，跳过 preparing 状态直接 toast，避免"按了快捷键 → 进入 preparing
// flicker → 100ms 后失败 toast"的卡顿体验。
type PreflightResult = { ok: true } | { ok: false; reason: string };
const preflightMic = async (): Promise<PreflightResult> => {
  try {
    const status = await invoke<string>("permission_check_microphone");
    if (status !== "granted") {
      return { ok: false, reason: i18n.t("overlay:error.preflight_permission_denied") };
    }
  } catch (e) {
    console.warn("[recording] preflight: permission check threw, assume granted", e);
  }
  try {
    const devices = await invoke<{ name: string; is_default: boolean }[]>(
      "audio_list_input_devices",
    );
    if (!devices || devices.length === 0) {
      return { ok: false, reason: i18n.t("overlay:error.preflight_no_device") };
    }
  } catch (e) {
    console.warn("[recording] preflight: device list threw", e);
    return { ok: false, reason: i18n.t("overlay:error.preflight_no_device") };
  }
  return { ok: true };
};

// 中止录音 = 保存音频文件到历史，但跳过转录。区别于 discardRecording（什么都不留）。
// ESC 双击 / X 按钮触发；调用方负责把 FSM 设回 idle 与 stopMic。
// 异步：包含一次 stopRecordingAndSave + history.add，平均 50~100ms，不阻塞 FSM 切回 idle。
const abortAndSaveHistory = async (): Promise<void> => {
  if (!IS_MAIN_WINDOW) return;
  const stack = new Error().stack?.split("\n").slice(2, 6).join(" | ");
  console.info(`[recording] abortAndSaveHistory called, caller=${stack}`);
  console.log("[recording] abort: saving audio without transcription");
  // 在 cancel/stopMic 把 activeId 清成 null 之前先抓快照
  const wasTranslate = useRecordingStore.getState().activeId === "translate";
  // stt 直接 cancel，不等结果
  void cancelSttSession();
  resetIncrementalInject();
  let rec: RecordingResult | null = null;
  try {
    rec = await stopRecordingAndSave();
  } catch (e) {
    // 没有活跃 session（例：用户连按导致重复 abort）→ 静默；其他错误也只 log 不打扰
    console.warn("[recording] abort: stopRecordingAndSave failed:", e);
  }
  // 整段无人声 → Rust 已跳过落盘，前端再丢弃一切。
  if (rec && !rec.voiced) {
    return;
  }
  // < 1s 的取消视作误触：不写历史，并把录音文件清掉，避免列表里堆一堆短噪声条目。
  const ABORT_MIN_KEEP_MS = 1000;
  if (rec && rec.duration_ms < ABORT_MIN_KEEP_MS) {
    if (rec.audio_path) {
      void deleteRecordingFile(rec.audio_path).catch((e: unknown) =>
        console.warn("[recording] abort: discard short clip file failed:", e),
      );
    }
    return;
  }
  if (rec) {
    const segmentMode = getEffectiveSegmentMode();
    const providerKind =
      resolvedProviderKindForCurrentSession ??
      (segmentMode === "REALTIME" ? "saas-realtime" : "saas-file");
    try {
      await useHistoryStore.getState().add({
        type: wasTranslate ? "translate" : "dictation",
        text: i18n.t("overlay:transcript.aborted_placeholder"),
        status: "cancelled",
        duration_ms: rec.duration_ms,
        audio_path: rec.audio_path,
        target_app: currentSessionTargetApp,
        segment_mode: segmentMode,
        provider_kind: providerKind,
      });
    } catch (e) {
      console.warn("[recording] abort: history.add failed:", e);
    }
  }
  toast.info(i18n.t("overlay:toast.aborted_saved.title"), {
    description: rec
      ? i18n.t("overlay:toast.aborted_saved.description")
      : undefined,
  });
};

export const useRecordingStore = create<RecordingStore>((set, get) => {
  const unlistens: UnlistenFn[] = [];

  return {
    state: "idle",
    activeId: null,
    errorMessage: null,
    lastPressAt: 0,
    startedListening: false,
    audioLevels: emptyLevels(),
    recordingId: null,
    liveTranscript: "",
    pillEarlyHide: false,
    segmentModeOverride: null,
    escArmed: false,

    setSegmentModeOverride: (mode) => set({ segmentModeOverride: mode }),

    initListeners: async () => {
      if (get().startedListening) {
        console.log("[recording] initListeners: already started, skip");
        return;
      }
      set({ startedListening: true });
      console.log("[recording] initListeners: attaching listeners");

      // overlay 不再调用 initListeners——main.tsx 的 overlay 分支只 sync i18n，
      // overlay 状态机由 OverlayPage 内的 useOverlayMachine + useOverlayListeners
      // 自管。这里 IS_MAIN_WINDOW 守卫保留作为防御性检查（HMR / 误用兜底）。
      if (!IS_MAIN_WINDOW) {
        console.log("[recording] non-main window: skip initListeners");
        return;
      }

      // 提示音子系统在 Rust 侧（src-tauri/src/cue.rs），此处不需要预热 webview
      // AudioContext —— hotkey 按下时 Rust 直接同帧播 startCue，零 IPC。

      // 主窗每次 set 后向 overlay 推送一次 FSM 快照 + 在状态过渡时播放提示音。
      // 20Hz 的 audioLevels 不在这里同步——overlay 自己 listen 'audio-level'，
      // 避免双倍 IPC 流量。
      let prevSnapshot = "";
      let prevState: RecordingState = get().state;
      let errorDismissTimer: number | null = null;
      let prevErrorState = get().state === "error";
      let prevErrorMessage: string | null = get().errorMessage;
      useRecordingStore.subscribe((s) => {
        // 提示音 FSM：startCue 由 Rust hotkey 派发同帧播；stop / cancel 在状态
        // 过渡时通过 Rust cue 命令补播，保证音色与 start 一致。cueSetActive 把
        // "录音流程是否进行中"同步给 Rust，下一次 hotkey 按下时 Rust 据此决定
        // 是否再播 startCue（toggle off 路径不重复播）。
        const wasActiveAny = prevState !== "idle" && prevState !== "error";
        const isActiveAny = s.state !== "idle" && s.state !== "error";
        if (wasActiveAny !== isActiveAny) {
          void cueSetActive(isActiveAny);
        }
        if (prevState === "recording" && s.state === "transcribing") {
          void cuePlay("stop");
        } else if (
          (prevState === "preparing" || prevState === "recording") &&
          s.state === "idle"
        ) {
          void cuePlay("cancel");
        }

        // 翻译模式 indicator 收起：录音流程结束（preparing/recording → 任意非
        // 活跃态）时 emit active=false。state 切换时 activeId 可能已被清空，
        // 这里幂等发送：overlay 端 active 已是 false 时再发一次仍是 false，
        // 比追踪 prevActiveId 简单可靠。
        const wasInRecOrPrep =
          prevState === "preparing" || prevState === "recording";
        const stillInRecOrPrep =
          s.state === "preparing" || s.state === "recording";
        if (wasInRecOrPrep && !stillInRecOrPrep) {
          emitTranslateActive(false);
        }

        // ESC 全局捕获：preparing/recording/transcribing 期间吞掉 Esc，避免
        // 用户在 Cursor / 编辑器里按 Esc 取消录音时同时退出 vim 模式 / 关 IME 候选窗。
        // injecting 不开（注入只持续几十 ms，开了反而可能漏到下一次 active 期）。
        const wasActive =
          prevState === "preparing" ||
          prevState === "recording" ||
          prevState === "transcribing";
        const isActive =
          s.state === "preparing" ||
          s.state === "recording" ||
          s.state === "transcribing";
        if (!wasActive && isActive) escCaptureStart();
        else if (wasActive && !isActive) escCaptureStop();
        // 离开 preparing/recording（toggle off → transcribing、双击丢弃 → idle、
        // 取消 → idle 等）时同步清掉 ESC 状态。ESC 提示「再按一下取消」只对录音
        // 窗口有意义，转写阶段继续显示会和「正在思考中」叠在一起；timer 也得清，
        // 否则后续误触发 disarm/cancel。
        const wasInRecording =
          prevState === "preparing" || prevState === "recording";
        const isInRecording =
          s.state === "preparing" || s.state === "recording";
        if (
          wasInRecording &&
          !isInRecording &&
          (escFirstAt > 0 || escPendingTimer !== null || escPromptTimer !== null)
        ) {
          clearEscTimers();
          escFirstAt = 0;
          void emitTo("overlay", "openspeech://esc-disarmed", null);
        }

        prevState = s.state;

        // error 自愈：1.5s 后回 idle。subscribe 会在每次 set 时触发，但 error 期间
        // 还有 audio-level（20Hz，cpal 停流尾巴 / 设置页预览）、asr-partial/final、
        // liveTranscript 等无关写入——若每次都重置 timer，错误条会被永远推到下一帧，
        // 用户必须手动按 X / 快捷键才能消除。只在「进入 error」或「errorMessage 换了」
        // 时重置，给最近一次错误一个完整的阅读窗口。
        const isError = s.state === "error";
        if (isError && (!prevErrorState || s.errorMessage !== prevErrorMessage)) {
          if (errorDismissTimer !== null) window.clearTimeout(errorDismissTimer);
          errorDismissTimer = window.setTimeout(() => {
            errorDismissTimer = null;
            if (useRecordingStore.getState().state === "error") {
              useRecordingStore.getState().dismissError();
            }
          }, ERROR_AUTO_DISMISS_MS);
        } else if (!isError && errorDismissTimer !== null) {
          window.clearTimeout(errorDismissTimer);
          errorDismissTimer = null;
        }
        prevErrorState = isError;
        prevErrorMessage = s.errorMessage;

        const snap = JSON.stringify({
          state: s.state,
          activeId: s.activeId,
          errorMessage: s.errorMessage,
          recordingId: s.recordingId,
          liveTranscript: s.liveTranscript,
          pillEarlyHide: s.pillEarlyHide,
        });
        if (snap === prevSnapshot) return;
        prevSnapshot = snap;
        // 全局广播 recording-phase：所有 webview 都能消费，overlay listeners.ts
        // 是当前唯一订阅者，但未来 Live 面板、调试 / 监控工具可以共用同一个事件。
        void emit("openspeech://recording-phase", {
          state: s.state,
          activeId: s.activeId,
          errorMessage: s.errorMessage,
          recordingId: s.recordingId,
          liveTranscript: s.liveTranscript,
          pillEarlyHide: s.pillEarlyHide,
        });
      });

      // 接收 overlay 上 ×/✓ 按钮转发的动作。overlay 不直接动 Rust，避免
      // 主窗 store 与 Rust 状态机分裂。
      const ua = await listen<"cancel" | "finalize">(
        "openspeech://overlay-action",
        (evt) => {
          const action = evt.payload;
          console.log("[recording] overlay-action:", action);
          if (action === "cancel") {
            get().simulateCancel();
          } else if (action === "finalize") {
            get().simulateFinalize();
          }
        },
      );

      // overlay 启动握手：overlay 任意时间启动（重启 / HMR / 第一次加载）
      // 都会广播 overlay-ready，主窗收到后立即重发一次 recording-phase，避免
      // overlay 监听器挂上之前的状态变化丢失。
      const ur = await listen("openspeech://overlay-ready", () => {
        const s = get();
        void emit("openspeech://recording-phase", {
          state: s.state,
          activeId: s.activeId,
          errorMessage: s.errorMessage,
          recordingId: s.recordingId,
          liveTranscript: s.liveTranscript,
          pillEarlyHide: s.pillEarlyHide,
        });
        console.log("[recording] overlay-ready → resent recording-phase snapshot");
      });
      unlistens.push(ua, ur);

      const u1 = await listen<HotkeyEvent>("openspeech://hotkey", async (evt) => {
        console.log("[recording] event received:", evt.payload, {
          curState: get().state,
          curActiveId: get().activeId,
        });
        const { id, phase } = evt.payload;
        const now = performance.now();
        const cur = get();

        // 全系统统一 toggle：released 不参与状态机推进（仅 pressed 触发开始 / 结束）。
        if (phase === "released") return;

        if (phase === "pressed") {
          // 同一绑定第二次按下 = 结束本次录音。判定放在最前，否则会被下方
          // "非 idle/error 一律忽略"吞掉。< 300ms 视为快速双击误触，丢弃整段。
          if (
            cur.activeId === id &&
            (cur.state === "recording" || cur.state === "preparing")
          ) {
            const duration = now - cur.lastPressAt;
            // 只对 translate 这一条做"OS / Webview 注入二连发"兜底：Windows Webview2
            // 在窗口聚焦时对默认翻译热键 Alt+Shift 会引发 rdev 看到一次 press → release
            // → press 循环，第二次 press 在原有 toggle 分支里被当成用户 toggle off →
            // too-short discard 回 idle，用户感知"按下立马退出"。<100ms 的二连发不可能
            // 是真人双击（双击下限 ~150ms），就地忽略；其它 binding（dictate_ptt 等）
            // 不受影响。
            const OS_INJECTED_DUPLICATE_MS = 100;
            if (id === "translate" && duration < OS_INJECTED_DUPLICATE_MS) {
              console.log(
                "[recording] toggle (translate): ignored (likely OS/webview-injected duplicate press)",
                { duration, threshold: OS_INJECTED_DUPLICATE_MS },
              );
              return;
            }
            if (duration < TOO_SHORT_TOTAL_MS) {
              console.log(
                "[recording] toggle: too short → discard (no save / no transcribe)",
                { duration, threshold: TOO_SHORT_TOTAL_MS },
              );
              discardRecording();
              stopMic();
              set({
                state: "idle",
                activeId: null,
                audioLevels: emptyLevels(),
                recordingId: null,
                liveTranscript: "",
              });
              return;
            }
            console.log("[recording] toggle: stopping → transcribing", {
              duration,
            });
            // 正常结束：停录音 → 写 history → transcribing 占位 800ms → idle。
            // injecting 中间态原本是给 ✓ 反馈用的 200ms padding，✓ 已移除，
            // 多一帧空白 state 没意义，直接跳过。
            stopMic();
            set({ state: "transcribing", audioLevels: emptyLevels() });
            void finalizeAndWriteHistory().then((outcome) => {
              // silent：用户没说话——pill 中心 crossfade 到 ERROR + 提示文案，
              // ERROR_AUTO_DISMISS_MS 后自然回 idle。语义上不是"错误"而是"无内容"，
              // 但走 error 路径让 pill 内容连续过渡，比独立 toast 体验顺。
              if (outcome.silent) {
                set({
                  state: "error",
                  activeId: null,
                  recordingId: null,
                  liveTranscript: "",
                  errorMessage: i18n.t("overlay:toast.silent_recording.title"),
                });
                return;
              }
              // 转写没拿到任何文字（0 段 Final / 超时 / 异常）：进入 error 态，
              // ERROR_AUTO_DISMISS_MS 后自动回 idle；用户也可以主动按激活快捷键 /
              // ESC 立刻关掉提示开始下一次录音。
              if (!outcome.text) {
                set({
                  state: "error",
                  activeId: null,
                  recordingId: null,
                  liveTranscript: "",
                  errorMessage: i18n.t("overlay:toast.transcribe_failed.title"),
                });
                return;
              }
              window.setTimeout(() => {
                const cur = get().state;
                if (cur !== "transcribing" && cur !== "injecting") return;
                set({
                  state: "idle",
                  activeId: null,
                  recordingId: null,
                  liveTranscript: "",
                });
              }, 800);
            });
            return;
          }

          // 跨模式切换：录音中按"另一种"激活键（dictate_ptt ↔ translate）。
          // 仅 UTTERANCE（整句）模式支持——整句模式 finalize 阶段才决定走听写还是
          // 翻译路径，录音过程纯采集 PCM，切 activeId 没有副作用。REALTIME 边录边
          // 出字已经把"听写阶段的字"流式注入到光标，半道切翻译会让"已注入听写文本
          // + 后续翻译输出"拼接成乱码，禁止。判定放在"toggle off (cur.activeId===id)"
          // 之后、"非 idle 忽略"之前——前者已捕获同 id 二次按下的结束语义，本分支
          // 处理 cur.activeId !== id 的真正跨模式按键。
          if (
            cur.activeId !== id &&
            isModeSwitchTarget(cur.activeId) &&
            isModeSwitchTarget(id) &&
            (cur.state === "recording" || cur.state === "preparing") &&
            getEffectiveSegmentMode() === "UTTERANCE"
          ) {
            console.log("[recording] mode switch:", cur.activeId, "→", id);
            // 切 activeId + 重置 lastPressAt（让下一次"同 id toggle off"以新激活
            // 时间为准，避免按了切换键立刻被 too-short 判定丢弃）。
            set({ activeId: id, lastPressAt: now });
            // translate indicator 跟随 activeId：切到 translate → 出现；切到
            // dictate_ptt → 退场。indicator 独立元素自己 motion 渐变。
            if (id === "translate") {
              emitTranslateActive(true, resolveTranslateLangLabel());
            } else {
              emitTranslateActive(false);
            }
            // pill 中心临时显示"切换到 X 模式"提示几秒——overlay 收到 hint 自管
            // timer，到点回退到 wave 渲染。
            emitModeSwitchHint(id === "translate" ? "translate" : "dictation");
            return;
          }

          // error 态：把"再按一次激活快捷键"当作用户主动放弃当前失败提示、
          // 立刻发起下一次录音。dismissError 把 state 切回 idle，继续 fall through
          // 到 gate / preflight / startMic 正常流程。配套：ESC 在 error 态也会
          // 立即 dismiss（见 key-preview 监听器）。
          if (cur.state === "error") {
            console.log("[recording] press on error → dismiss & start new", { id });
            get().dismissError();
          } else if (cur.state !== "idle") {
            // transcribing / injecting / preparing：流程未完成，避免抢资源。
            console.warn(
              "[recording] press IGNORED: state not idle and activeId mismatch",
              {
                pressed_id: id,
                cur_state: cur.state,
                cur_activeId: cur.activeId,
              },
            );
            return;
          }

          // 提示音"按下即响"：startCue 由 Rust hotkey dispatch 在收到按键
          // 同帧播放（src-tauri/src/cue.rs），此处无需再触发——避免 IPC 往返
          // + WebView AudioContext 冷启动叠加成的"慢一拍"。

          // Gate：转写后端必须至少一条可用，否则录了一段没人转的废录音是浪费。
          // saas 路径：已登录 OpenLoaf；custom 路径：BYOK 自带凭证，跳过登录 gate。
          // 主窗 / overlay 都会跑到这里：overlay 没 init auth/settings，默认值
          // 也会判 blocked → return；openLogin 在 overlay 里写自己 store 没渲染 dialog，
          // 等价于 no-op，主窗弹窗由主窗 store 驱动。
          const dictationModeAtGate = useSettingsStore.getState().dictation.mode;
          const usingCustomDictation = dictationModeAtGate === "custom";
          let auth = useAuthStore.getState();
          let saasReady = auth.isAuthenticated;
          // 未登录但 keychain 里可能还有 refresh_token（启动时网络断或本地后端
          // 没起导致 bootstrap 没恢复成功）——把"按下快捷键"当作主动重试信号，
          // 静默尝试用 refresh_token 换一次 access_token。1.5s 超时兜底，避免
          // 服务器很慢时让用户感觉"按了没反应"；超时后走原弹登录 dialog 路径。
          if (!saasReady && !usingCustomDictation) {
            const recovered = await Promise.race([
              invoke<boolean>("openloaf_try_recover").catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
            ]);
            if (recovered) {
              auth = useAuthStore.getState();
              saasReady = auth.isAuthenticated;
            }
          }
          if (!saasReady && !usingCustomDictation) {
            console.log("[recording] gate blocked: no STT backend available");
            // 只有主窗"完全藏起来"（hide 到 tray / 最小化）时才推悬浮条 toast——
            // 此时用户多半在别的 app 里输入，强行拉前台打扰。其余只要主窗 visible
            // 且未最小化（无论 input focus 是否在主窗 webview——子 dialog / 边栏
            // 控件 / 拖拽都会让 isFocused 短暂为 false），都直接弹 LoginDialog，
            // 否则用户在主程序里按快捷键却只看到悬浮条提示，体验割裂。
            let mainActive = false;
            if (IS_MAIN_WINDOW) {
              const w = getCurrentWebviewWindow();
              const [focused, visible, minimized] = await Promise.all([
                w.isFocused().catch(() => false),
                w.isVisible().catch(() => false),
                w.isMinimized().catch(() => false),
              ]);
              mainActive = focused || (visible && !minimized);
            }
            if (mainActive) {
              useUIStore.getState().openLogin();
            } else {
              notifyOverlay("error", i18n.t("overlay:toast.not_logged_in.title"), {
                description: i18n.t("overlay:toast.not_logged_in.description"),
                action: {
                  label: i18n.t("overlay:toast.not_logged_in.action"),
                  key: "open_login",
                },
                durationMs: 0,
              });
            }
            return;
          }

          // 网络 gate：SAAS 路径必须连得上互联网，否则 realtime WebSocket 握手
          // 必然失败、本地录音也无人转写。
          // 双重判定：
          //   1) 同步 `navigator.onLine === false` —— 系统层链路就断了，必拦，最快
          //   2) 异步 `invoke("openloaf_health_check")` —— SDK 0.2.7+ 通过
          //      `payment.list_plans()` 探活公开端点，可识别"链路通但 SaaS 挂掉
          //      / captive portal / DNS 挂"等系统层捕获不到的场景；
          //      fire-and-forget 启动录音的同时跑，1-2s 后若 false，且录音仍在
          //      preparing/recording 阶段则 cancel + 弹窗。
          // 与登录 gate 一样，overlay 也会跑到这里——openNoInternet 写自己 store
          // 不渲染 dialog 等价 no-op，主窗 dialog 由主窗 ui store 驱动。
          // 离线 gate 不分 saas / custom：腾讯 / 阿里 BYOK 同样走云端 ASR，离线一样
          // 必然失败，先拦住避免空跑。
          if (typeof navigator !== "undefined" && navigator.onLine === false) {
            console.warn("[recording] gate blocked: offline — silent");
            return;
          }
          // custom 听写通道直连 vendor，不经过 SaaS — 跳过 health probe，避免无意义网络开销。
          const usingSaasDictation = !usingCustomDictation && saasReady;
          // 异步健康探针——只在主窗执行（IS_MAIN_WINDOW）以避免重复 invoke。
          if (usingSaasDictation && IS_MAIN_WINDOW) {
            invoke<boolean>("openloaf_health_check")
              .then((healthy) => {
                if (healthy) return;
                // 录音仍在进行才取消；用户可能已经主动结束，这时不要打断 transcribing。
                const s = get();
                if (s.state === "preparing" || s.state === "recording") {
                  console.warn("[recording] health check failed → cancelling silently");
                  recordAbortFailureHistory(
                    i18n.t("errors:network.service_unreachable_desc"),
                  );
                  discardRecording();
                  stopMic();
                  set({
                    state: "idle",
                    activeId: null,
                    audioLevels: emptyLevels(),
                    recordingId: null,
                    liveTranscript: "",
                  });
                }
              })
              .catch((e) => {
                // 命令本身抛错（极少见，比如未注册 invoke）只打日志，不打扰用户。
                console.warn("[recording] health check invoke failed:", e);
              });
          }

          // preflight：mic 权限 / 设备列表预检；失败时不进入 preparing，避免
          // "按键 → preparing flicker → 100ms 后失败 toast"的闪烁体验。
          const pre = await preflightMic();
          if (!pre.ok) {
            console.warn("[recording] preflight failed:", pre.reason);
            notifyOverlay(
              "error",
              i18n.t("overlay:toast.preflight_failed.title"),
              { description: pre.reason },
            );
            // preflight 阶段 activeId 还没设到 store 里，先打上当前按键的 type 再写。
            const isTranslateBinding = id === "translate";
            void useHistoryStore
              .getState()
              .add({
                type: isTranslateBinding ? "translate" : "dictation",
                text: transcriptPlaceholder(),
                status: "failed",
                error: pre.reason,
                duration_ms: 0,
                target_lang: isTranslateBinding
                  ? useSettingsStore.getState().general.translateTargetLang
                  : null,
              })
              .catch((e) =>
                console.warn("[recording] preflight: history.add failed:", e),
              );
            return;
          }

          const recordingId = newId();
          resetIncrementalInject();
          realtimeDegradedToFile = false;
          realtimeReadyDuringRecording = false;
          set({
            state: "preparing",
            activeId: id,
            errorMessage: null,
            lastPressAt: now,
            audioLevels: emptyLevels(),
            recordingId,
            pillEarlyHide: false,
            liveTranscript: "",
          });
          // 翻译听写：emit 持续型 indicator 状态——overlay 端独立组件渲染
          // "翻译为<目标语言>"，与 toast 警告语义解耦。subscriber 在录音流程
          // 结束边沿 emit active=false。
          if (id === "translate") {
            emitTranslateActive(true, resolveTranslateLangLabel());
          }
          // Rust audio_level_start 现在同步等到 cpal stream 真正起来才返回。
          // 失败 / 超时 → 直接退回 idle 并提示，不再走 stt_start 撞 "audio
          // stream not running"。中途用户若再按一次（state 已变），下方守卫会 skip。
          //
          // 异步竞态兜底：startMic 期间（macOS cpal 冷启动 ~1s）用户如果按 ESC /
          // 再次按下快捷键 / 触发任意"回 idle"路径，那条路径里的 stopMic 跑在
          // ref_count 还是 0 的时刻——保护到 0 实际什么都没干。等 startMic resolve
          // 时 Rust 已经把 ref_count +1，但前端 state 已被改写、不会进入下面的正常
          // 流程，于是 mic 永久残留在 ref_count=1（macOS 状态栏录音指示常驻）。
          // 因此 state-mismatch 分支必须主动补一次 stopMic 把 ref_count 平回去。
          void startMic().then((ok) => {
            const s = get();
            if (s.state !== "preparing" || s.activeId !== id) {
              if (ok) {
                console.warn(
                  "[recording] startMic resolved after state changed → balancing stopMic",
                  { resolvedFor: id, curState: s.state, curActiveId: s.activeId },
                );
                stopMic();
              }
              return;
            }
            if (!ok) {
              const desc = i18n.t("overlay:error.stt_mic_not_ready");
              recordAbortFailureHistory(desc);
              set({
                state: "idle",
                activeId: null,
                audioLevels: emptyLevels(),
                recordingId: null,
                liveTranscript: "",
              });
              notifyOverlay("error", i18n.t("overlay:toast.recording_start_failed.title"), {
                description: desc,
              });
              return;
            }
            startRecordingSession(recordingId);
            set({ state: "recording" });
          });
          return;
        }
      });

      const u3 = await listen<number>(
        "openspeech://audio-level",
        (evt) => {
          const v = Math.max(0, Math.min(1, Number(evt.payload) || 0));
          set((s) => ({
            audioLevels: [v, ...s.audioLevels.slice(0, -1)],
          }));
        },
      );

      // cpal 运行时致命错误（设备拔出 / 被独占 / OS 抢占）：Rust audio thread
      // 已自行退出 + 清 stream_info；前端这里是平衡 ref_count 与 UI 的最后一道。
      // 若不收尾，活跃的录音会卡在 recording 态、ref_count 不归零，下次按下快捷键
      // 撞 "audio stream not running"。
      const u9 = await listen<string>(
        "openspeech://audio-stream-error",
        (evt) => {
          const detail = String(evt.payload ?? "");
          console.warn("[audio] stream-error:", detail);
          const cur = get();
          // 活跃录音中：取消当前 session、停 mic、切 error。已 idle 时仍 stopMic
          // 一次平衡可能残留的 ref_count（设置页 mic 预览也会 hold 引用）。
          if (
            cur.state === "preparing" ||
            cur.state === "recording" ||
            cur.state === "transcribing"
          ) {
            const desc = i18n.t("overlay:error.stt_mic_not_ready");
            recordAbortFailureHistory(desc);
            discardRecording();
            stopMic();
            set({
              state: "error",
              activeId: null,
              errorMessage: desc,
              audioLevels: emptyLevels(),
              recordingId: null,
              liveTranscript: "",
            });
            notifyOverlay("error", i18n.t("overlay:toast.recording_start_failed.title"), {
              description: desc,
            });
          } else {
            stopMic();
          }
        },
      );

      // 实时 ASR 事件——Rust stt worker 把 RealtimeEvent 转成这些 Tauri emit。
      // partial / final 更新 liveTranscript（UI 可订阅）；error / closed
      // （尤其 insufficient_credits）切到 error 态。
      const u4 = await listen<string>("openspeech://asr-partial", (evt) => {
        set({ liveTranscript: String(evt.payload ?? "") });
      });
      const u5 = await listen<string>("openspeech://asr-final", (evt) => {
        const text = String(evt.payload ?? "");
        set({ liveTranscript: text });
        // AUTO（VAD）模式下，每次服务端 Final 立刻把新增段敲到当前焦点输入框，
        // 实现"边说边出字"。MANUAL 只会出一段 Final 且与 finalize 几乎同时到达，
        // 走原 finalize 的整段粘贴更省事，这里跳过。
        const mode = getEffectiveSegmentMode();
        // 翻译模式：不能边录边敲原文——否则等翻译 stream 来了再敲译文，焦点上
        // 会出现"中文 + 英文"拼接。等 finalize 拿到 transcript 走翻译 prompt
        // 后再把译文整段流到光标。
        const translateMode = get().activeId === "translate";
        if (mode === "REALTIME" && !translateMode) {
          injectIncremental(text);
        }
      });
      const u6 = await listen<{ code: string; message: string }>(
        "openspeech://asr-error",
        (evt) => {
          console.warn("[stt] asr-error:", evt.payload);
          const { code, message } = evt.payload ?? { code: "", message: "" };

          // DashScope realtime 模型层复读 bug 兜底：标记本次录音降级走 REST
          // 文件转写。REALTIME 模式因为已增量注入到光标，降级会让前后半段重复，
          // 只 toast 不降级；其他模式静默降级，finalize 时由 fallback 分支接手。
          if (isRealtimeRepeatError(code, message)) {
            const mode = getEffectiveSegmentMode();
            if (mode === "REALTIME") {
              notifyOverlay(
                "warning",
                i18n.t("overlay:toast.realtime_degraded.title"),
                {
                  description: i18n.t(
                    "overlay:toast.realtime_degraded.realtime_mode",
                  ),
                },
              );
            } else {
              realtimeDegradedToFile = true;
              notifyOverlay(
                "info",
                i18n.t("overlay:toast.realtime_degraded.title"),
                {
                  description: i18n.t(
                    "overlay:toast.realtime_degraded.description",
                  ),
                },
              );
            }
            return;
          }

          notifyOverlay("error", i18n.t("overlay:toast.asr_error.title"), {
            description: code
              ? `${code}: ${message}`
              : message || i18n.t("overlay:toast.asr_error.unknown"),
          });
          // 不直接切 error 态——finalize 结果会被 allSettled 捕获，history 按
          // status=failed 落盘；若用户正在按键中（recording 态），保留继续录音
          // 的机会，由用户松手后走 failed 分支。
        },
      );
      const u7 = await listen<{ reason: string; totalCredits: number }>(
        "openspeech://asr-closed",
        (evt) => {
          const { reason } = evt.payload ?? { reason: "unknown", totalCredits: 0 };
          if (reason === "insufficient_credits") {
            recordAbortFailureHistory(
              i18n.t("overlay:toast.insufficient_credits.error_message"),
            );
            discardRecording();
            stopMic();
            notifyOverlay("error", i18n.t("overlay:toast.insufficient_credits.title"), {
              description: i18n.t("overlay:toast.insufficient_credits.description"),
            });
            set({
              state: "error",
              errorMessage: i18n.t("overlay:toast.insufficient_credits.error_message"),
              audioLevels: emptyLevels(),
              recordingId: null,
              liveTranscript: "",
            });
          } else if (reason === "worker_dead") {
            // Rust worker 因协议错误（连续 decode 失败 / 网络断）异常退出。
            // 不能等用户松手再走 finalize —— 那条路只会拿到 segs=0 + 整段音频白录。
            // 立即停止音频流、丢弃当前录音、切 error 让 UI 解锁。
            console.warn("[stt] worker_dead, aborting recording", evt.payload);
            recordAbortFailureHistory(i18n.t("overlay:toast.worker_dead.error_message"));
            discardRecording();
            stopMic();
            notifyOverlay("error", i18n.t("overlay:toast.worker_dead.title"), {
              description: i18n.t("overlay:toast.worker_dead.description"),
            });
            set({
              state: "error",
              errorMessage: i18n.t("overlay:toast.worker_dead.error_message"),
              audioLevels: emptyLevels(),
              recordingId: null,
              liveTranscript: "",
            });
          } else if (reason === "max_duration") {
            notifyOverlay("warning", i18n.t("overlay:toast.session_timeout.title"), {
              description: i18n.t("overlay:toast.session_timeout.description"),
            });
            console.warn("[stt] session closed by server:", reason);
          } else if (reason === "idle_timeout") {
            console.warn("[stt] session closed by server:", reason);
          }
        },
      );
      // realtime WS 握手成功后服务端首条事件，把 sessionId 透出来。
      // 缓存到 module 级 currentSttSessionId，给 finalize 后调 AI refine 时
      // 作为 task_id 透传，关联 ASR 与口语优化两侧日志。
      const u7r = await listen<{ sessionId: string }>(
        "openspeech://stt-ready",
        (evt) => {
          const sid = evt.payload?.sessionId ?? "";
          realtimeReadyDuringRecording = true;
          if (sid) {
            currentSttSessionId = sid;
            console.info(`[stt] session ready, id=${sid}`);
          }
        },
      );
      // Rust dispatch 完成后立刻广播本次会话最终落到了哪条通道。
      // 主路径（REALTIME / 文件转写）写 history 时直接读这个值，不再凭设置反推。
      const u7p = await listen<string>(
        "openspeech://stt-provider-resolved",
        (evt) => {
          const kind = evt.payload;
          if (
            kind === "saas-realtime" ||
            kind === "saas-file" ||
            kind === "tencent-realtime" ||
            kind === "tencent-file" ||
            kind === "aliyun-realtime" ||
            kind === "aliyun-file"
          ) {
            resolvedProviderKindForCurrentSession = kind;
            console.info(`[stt] provider resolved: ${kind}`);
          }
        },
      );

      // Rust dispatch 发现 mode=custom 但 active provider 没配齐时，会自动走 SaaS
      // 并把这条事件发出来——前端只需要弹一次 toast 解释为什么"明明选了自定义却走了云端"。
      const u7f = await listen<{ reason?: string }>(
        "openspeech://dictation-fallback",
        () => {
          notifyOverlay(
            "warning",
            i18n.t("overlay:toast.dictation_fallback.title"),
            { description: i18n.t("overlay:toast.dictation_fallback.description") },
          );
        },
      );

      // Esc 取消——走 Rust modifier_only 的预览通道（`openspeech://key-preview`），
      // 不注册为全局快捷键（否则会拦截用户在其他应用里的 Esc）。状态门控：录音 /
      // 转写 / 注入全流程都响应，仅 idle 忽略。注入态生效要点：AI refine 流式
      // stream 在 Rust 侧没有 abort 通道，取消后剩余 deltas 仍会回流——靠
      // injectIncremental / 尾段兜底里的状态 gate 兜住，FSM 切回 idle 即等同
      // "停止继续敲下去"。
      //
      // 双段确认：
      //   ESC#1 + Recording → EscPending（0.5s 静默窗口，不弹提示、不发 esc-armed）
      //   ESC#2 在 0.5s 内 → 直接取消（用户已确认意图，不打扰）
      //   0.5s 超时 → EscPrompt（弹"再按一下中止"提示 + esc-armed 黄闪 X 按钮，3s 自动 disarm）
      //   ESC during EscPrompt → 取消
      // 这样快速双击的用户不会被无谓的提示打扰；犹豫的用户会看到提示。
      const ESC_PENDING_MS = 500;
      const ESC_PROMPT_MS = 3000;
      let escFirstAt = 0;
      let escPendingTimer: number | null = null;
      let escPromptTimer: number | null = null;

      const clearEscTimers = () => {
        if (escPendingTimer !== null) {
          window.clearTimeout(escPendingTimer);
          escPendingTimer = null;
        }
        if (escPromptTimer !== null) {
          window.clearTimeout(escPromptTimer);
          escPromptTimer = null;
        }
      };

      const cancelByEsc = (s: RecordingState) => {
        console.log("[recording] Esc confirmed, cancelling", { state: s });
        clearEscTimers();
        escFirstAt = 0;
        set({ escArmed: false });
        void emitTo("overlay", "openspeech://esc-disarmed", null);
        // DEBUG 模拟：没有真 mic / STT 会话，跳过 abort/discard/stopMic 那一整套，
        // 只清 debug 标志 + FSM 切 idle，注入回路靠 isInjectFlowActive() 短路。
        if (debugSimulating) {
          cancelDebugSimulation();
          set({
            state: "idle",
            activeId: null,
            audioLevels: emptyLevels(),
            recordingId: null,
            liveTranscript: "",
          });
          return;
        }
        // preparing/recording 时保存音频到历史（用户语义：取消转录但留下录音）；
        // transcribing 时音频已落盘 + stt 在跑，只丢 stt 结果即可。
        if (s === "preparing" || s === "recording") {
          void abortAndSaveHistory();
        } else {
          discardRecording();
        }
        stopMic();
        set({
          state: "idle",
          activeId: null,
          audioLevels: emptyLevels(),
          recordingId: null,
          liveTranscript: "",
        });
      };

      const u8 = await listen<{
        code: string;
        phase: "pressed" | "released";
        isRepeat?: boolean;
      }>(
        "openspeech://key-preview",
        (evt) => {
          if (evt.payload.phase !== "pressed") return;
          if (evt.payload.code !== "Escape") return;
          // macOS 长按 Esc 会以 ~30ms 间隔触发 KeyPress——is_repeat=true 必须丢弃。
          if (evt.payload.isRepeat) return;
          const s = get().state;
          // error 态：ESC 立即关掉失败提示回到 idle，让用户能马上再次按
          // 激活快捷键开始新一次录音，不必等 ERROR_AUTO_DISMISS_MS 自然消失。
          if (s === "error") {
            console.log("[recording] Esc on error → dismiss");
            get().dismissError();
            return;
          }
          if (s === "idle") return;

          // 已经 armed（任意阶段：pending 或 prompt）→ 第二次 ESC = 取消。
          if (escFirstAt > 0) {
            cancelByEsc(s);
            return;
          }

          // 第一次 ESC：进入 EscPending 静默窗口。0.5s 内的第二次 ESC 不会被这条
          // 分支拦——它由上面 `escFirstAt > 0` 命中。
          escFirstAt = performance.now();
          console.log("[recording] Esc #1 → pending", { state: s });
          escPendingTimer = window.setTimeout(() => {
            escPendingTimer = null;
            // 0.5s 内没有第二次 ESC → 切到 EscPrompt：先标 X 按钮 armed，再弹
            // 提示。两步并发到达 overlay 时 reducer 都能正确处理，但顺序确保：
            // 即便 toast 略迟，X 按钮的描边变化也已经先到，没有"先红一下再变黄"
            // 的视觉错觉。
            console.log("[recording] Esc pending timeout → prompt");
            set({ escArmed: true });
            void emitTo("overlay", "openspeech://esc-armed", null);
            // info 风格：te-light-gray 描边 + 白字，与 te-accent（黄）/ 任何
            // 错误（红）风格都拉开距离，避免被误读为"录音条出错了"。
            notifyOverlay("info", i18n.t("overlay:toast.esc_arm.title"), {
              durationMs: ESC_PROMPT_MS,
              dismissOnDisarm: true,
            });
            escPromptTimer = window.setTimeout(() => {
              escPromptTimer = null;
              escFirstAt = 0;
              set({ escArmed: false });
              void emitTo("overlay", "openspeech://esc-disarmed", null);
              console.log("[recording] Esc prompt timeout → disarmed");
            }, ESC_PROMPT_MS);
          }, ESC_PENDING_MS);
        },
      );

      unlistens.push(u1, u3, u4, u5, u6, u7, u7r, u7p, u7f, u8, u9);
      console.log(
        "[recording] listeners attached (hotkey + audio-level + asr-* + stream-error)",
      );
      // 主窗自身 listeners 全部就绪后也广播一次 overlay-ready ——overlay 已经
      // 在更早时间发过的话，主窗那时还没挂 ur 听不到；这里反向重补一次让 overlay
      // 也能从主窗触发的握手得到首份快照（互相兜底，至少一边会收到）。
      void emit("openspeech://overlay-ready");
    },

    syncBindings: async (bindings) => {
      console.log("[recording] syncBindings → invoking apply_hotkey_config", bindings);
      try {
        await invoke("apply_hotkey_config", {
          payload: { bindings },
        });
        console.log("[recording] syncBindings OK");
      } catch (e) {
        console.error("[recording] syncBindings FAILED:", e);
        set({
          state: "error",
          errorMessage: i18n.t("overlay:error.sync_hotkey_failed", { error: String(e) }),
        });
      }
    },

    dismissError: () => {
      set({
        state: "idle",
        activeId: null,
        errorMessage: null,
        audioLevels: emptyLevels(),
        recordingId: null,
        liveTranscript: "",
      });
    },

    simulateCancel: () => {
      // DEBUG 模拟：跳过 abort/discard/stopMic（没有真实 mic/STT 会话）
      if (debugSimulating) {
        cancelDebugSimulation();
        set({
          state: "idle",
          activeId: null,
          audioLevels: emptyLevels(),
          recordingId: null,
          liveTranscript: "",
        });
        return;
      }
      const cur = get();
      if (cur.state === "preparing" || cur.state === "recording") {
        void abortAndSaveHistory();
      } else {
        discardRecording();
      }
      stopMic();
      set({
        state: "idle",
        activeId: null,
        audioLevels: emptyLevels(),
        recordingId: null,
        liveTranscript: "",
      });
    },

    simulateDictationFromAudio: async (audioPath: string, durationMs: number) => {
      if (!IS_MAIN_WINDOW) return;
      const cur = get().state;
      if (cur !== "idle") {
        toast.warning("[DEBUG] 当前正在录音/转写，先结束再试");
        return;
      }
      if (durationMs > 5 * 60 * 1000) {
        toast.error("[DEBUG] 录音超过 5 分钟，REST ASR 不支持");
        return;
      }

      // 进入"假录音"态：和真听写一样跑 FSM，但不开 mic/STT。
      // 倒计时 = 音频时长，期间 overlay 显示 DEBUG 倒计时条 + 假波形。
      // 用户在这段窗口内 Cmd+Tab 到目标输入框；ESC 双击随时取消。
      resetIncrementalInject();
      realtimeDegradedToFile = false;
      realtimeReadyDuringRecording = false;
      currentSttSessionId = `debug-${newId()}`;
      debugSimulating = true;
      const endAtUnixMs = Date.now() + durationMs;
      // overlay 窗口的 show 平时由 Rust 在全局快捷键 pressed 时调；DEBUG 路径
      // 不经过快捷键，需要前端显式拉起一次，否则 pill / debug strip 全在隐藏窗口里。
      void invoke("overlay_show").catch((e) =>
        console.warn("[debug] overlay_show failed:", e),
      );
      broadcastDebug({ active: true, totalMs: durationMs, endAtUnixMs });
      startDebugFakeLevels();
      set({
        state: "recording",
        liveTranscript: "",
        pillEarlyHide: false,
        audioLevels: emptyLevels(),
        lastPressAt: performance.now(),
      });

      try {
        await debugAbortableDelay(durationMs);
      } catch {
        // ESC 取消 / 外部 cancelDebugSimulation()：FSM 已被 simulateCancel 切回 idle，
        // 直接退出，不进 transcribing/injecting。
        return;
      }

      stopDebugFakeLevels();
      broadcastDebug({ active: false });
      // 切 transcribing 之前确认还在 debug 模拟中——可能在边界条件下已被取消。
      if (!debugSimulating) return;
      set({ state: "transcribing", liveTranscript: "", pillEarlyHide: false });

      try {
        let text = "";
        try {
          const r = await transcribeRecordingFile({
            audioPath,
            durationMs,
            lang: currentDictationLang(),
            provider: buildProviderRef(),
          });
          text = r.text ?? "";
        } catch (e) {
          console.warn("[debug] transcribe failed:", e);
          const isByok = isByokSwitchableError(e);
          notifyOverlay("error", i18n.t("overlay:toast.transcribe_failed.title"), {
            description: humanizeSttError(e),
            ...(isByok
              ? { action: byokSwitchToSaasAction(), durationMs: 0 }
              : {}),
          });
          set({ state: "idle", liveTranscript: "" });
          return;
        }

        if (!text) {
          notifyOverlay("warning", i18n.t("overlay:toast.transcribe_failed.title"), {
            description: i18n.t("overlay:toast.transcribe_failed.no_transcript"),
          });
          set({ state: "idle", liveTranscript: "" });
          return;
        }

      // 复用 finalize 里的 refine 流式注入逻辑——这里只内联必要部分，不写历史，
      // 不动录音/STT 会话状态机。切 injecting 的时机与正常路径对齐：非 refine
      // 立即切；refine 启用时等首个 chunk 到达再切，让 UI 区分"模型思考"与"流式输出"。
      const refineActive = isAiRefineActive();
      if (!refineActive) {
        set({ state: "injecting", pillEarlyHide: false });
      }
      let refinedText: string | null = null;
      if (refineActive) {
        const hotwords = getHotwordsArray();
        let streamedSoFar = "";
        const aiSettings = useSettingsStore.getState().aiRefine;
        const lang = resolveLang(useSettingsStore.getState().general.interfaceLang);
        const systemPrompt = getEffectiveAiSystemPrompt(aiSettings.customSystemPrompt, lang);
        const requestTimeMs = Date.now();
        const requestTime = `${new Date(requestTimeMs).toISOString()} (UTC)`;
        let historyEntries: string[] | undefined;
        if (aiSettings.includeHistory) {
          const items = useHistoryStore.getState().items;
          const picked = items
            .filter((it) => it.status === "success")
            .slice(0, 5)
            .reverse();
          const minutesAgoLabel = i18n.t("ai.minutes_ago", {
            ns: "settings",
            defaultValue: "minutes ago",
          });
          const lines = picked
            .map((it) => {
              const content = (it.refined_text ?? it.text ?? "").trim();
              if (!content) return "";
              const clipped = clipHistoryEntry(content);
              const mins = Math.max(1, Math.floor((requestTimeMs - it.created_at) / 60000));
              return `[${mins} ${minutesAgoLabel}] ${clipped}`;
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
        try {
          if (aiSettings.mode === "custom" && !activeProvider) {
            throw new Error("no_active_custom_provider");
          }
          const debugDomains = getDomainNamesForPrompt(aiSettings.selectedDomains);
          const r = await refineTextViaChatStream(
            {
              mode: aiSettings.mode,
              systemPrompt,
              userText: text,
              hotwords: hotwords.length > 0 ? hotwords : undefined,
              historyEntries,
              requestTime,
              targetApp: currentSessionTargetApp ?? undefined,
              domains: debugDomains.length > 0 ? debugDomains : undefined,
              customBaseUrl: activeProvider?.baseUrl,
              customModel: activeProvider?.model,
              customKeyringId: activeProvider
                ? `ai_provider_${activeProvider.id}`
                : undefined,
              taskId: currentSttSessionId ?? undefined,
            },
            (chunk) => {
              streamedSoFar += chunk;
              if (get().state === "transcribing") {
                set({ state: "injecting", pillEarlyHide: false });
              }
              injectIncremental(streamedSoFar);
            },
          );
          refinedText = r.refinedText;
          set({ pillEarlyHide: true });
          try {
            await injectChain;
          } catch {}
          if (isInjectFlowActive()) {
            try {
              await writeClipboard(refinedText);
            } catch (e) {
              console.warn("[debug] clipboard write failed:", e);
            }
          }
        } catch (e) {
          const raw = String(e ?? "");
          if (aiSettings.mode === "custom") {
            console.warn("[debug] refine custom failed:", e);
            const handled = await handleAiRefineCustomFailure(e);
            if (!handled) {
              notifyOverlay(
                "warning",
                i18n.t("overlay:toast.transcribe_failed.title"),
                { description: humanizeSttError(e) },
              );
            }
          } else if (isSaasAuthError(raw)) {
            openLoginAfterSaasAuthLost();
          } else {
            console.warn("[debug] refine failed:", e);
            notifyOverlay(
              "warning",
              i18n.t("overlay:toast.transcribe_failed.title"),
              { description: humanizeSttError(e) },
            );
          }
        }
        // refine 0 chunk 抛错路径兜底：留在 transcribing 时补切 injecting，
        // 与正常路径一致，让"输出中"在末尾兜底 paste 时显示。
        if (get().state === "transcribing") {
          set({ state: "injecting", pillEarlyHide: false });
        }
        void streamedSoFar;
      }

      const finalText = refinedText ?? text;

      if (finalText && isInjectFlowActive()) {
        try {
          await injectChain;
        } catch {}
        if (!isInjectFlowActive()) {
          resetIncrementalInject();
          set({ state: "idle", liveTranscript: "" });
          return;
        }
        if (finalText.startsWith(lastInjectedText)) {
          const remaining = finalText.slice(lastInjectedText.length);
          if (remaining) {
            try {
              await invoke("inject_type", { text: remaining });
            } catch (e) {
              console.warn("[debug] tail type failed:", e);
              try {
                await writeClipboard(remaining);
                await invoke("inject_paste");
              } catch (e2) {
                console.warn("[debug] tail paste fallback failed:", e2);
              }
            }
          }
        } else {
          try {
            await writeClipboard(finalText);
          } catch {}
        }
        resetIncrementalInject();
      }

        set({ state: "idle", liveTranscript: "" });
        toast.success("[DEBUG] 模拟完成", {
          description: `text=${finalText.length} chars`,
        });
      } finally {
        // 不论 ASR/refine/inject 任何一步出口，确保 debug 标志清掉、波形 ticker 关掉、
        // overlay 倒计时条收回。被 simulateCancel 提前清过也无所谓——幂等。
        debugSimulating = false;
        stopDebugFakeLevels();
        broadcastDebug({ active: false });
      }
    },

    debugRefineOnly: async (text: string) => {
      if (!IS_MAIN_WINDOW) throw new Error("not main window");
      const trimmed = text.trim();
      if (!trimmed) throw new Error("empty text");
      const aiSettings = useSettingsStore.getState().aiRefine;
      const lang = resolveLang(useSettingsStore.getState().general.interfaceLang);
      const systemPrompt = getEffectiveAiSystemPrompt(aiSettings.customSystemPrompt, lang);
      const hotwords = getHotwordsArray();
      const requestTime = `${new Date().toISOString()} (UTC)`;
      let activeProvider = null as
        | { id: string; name: string; baseUrl: string; model: string }
        | null;
      if (aiSettings.mode === "custom") {
        activeProvider =
          aiSettings.customProviders.find(
            (p) => p.id === aiSettings.activeCustomProviderId,
          ) ?? null;
        if (!activeProvider) throw new Error("no_active_custom_provider");
      }
      const debugRefineDomains = getDomainNamesForPrompt(aiSettings.selectedDomains);
      const r = await refineTextViaChatStream(
        {
          mode: aiSettings.mode,
          systemPrompt,
          userText: trimmed,
          hotwords: hotwords.length > 0 ? hotwords : undefined,
          requestTime,
          domains: debugRefineDomains.length > 0 ? debugRefineDomains : undefined,
          customBaseUrl: activeProvider?.baseUrl,
          customModel: activeProvider?.model,
          customKeyringId: activeProvider
            ? `ai_provider_${activeProvider.id}`
            : undefined,
          taskId: `debug-refine-${newId()}`,
        },
        () => {},
      );
      return r.refinedText;
    },

    debugReinject: async (text: string) => {
      if (!IS_MAIN_WINDOW) throw new Error("not main window");
      const payload = text;
      if (!payload) throw new Error("empty text");
      try {
        await invoke("inject_type", { text: payload });
      } catch (e) {
        console.warn("[debug] inject_type failed, fallback paste:", e);
        await writeClipboard(payload);
        await invoke("inject_paste");
      }
    },

    simulateFinalize: () => {
      const cur = get();
      if (cur.state !== "recording" && cur.state !== "preparing") return;
      const duration = performance.now() - cur.lastPressAt;
      if (duration < TOO_SHORT_TOTAL_MS) {
        console.log(
          "[recording] finalize: too short → discard (no save / no transcribe)",
          { duration, threshold: TOO_SHORT_TOTAL_MS },
        );
        discardRecording();
        stopMic();
        set({
          state: "idle",
          activeId: null,
          audioLevels: emptyLevels(),
          recordingId: null,
          liveTranscript: "",
        });
        return;
      }
      stopMic();
      set({ state: "transcribing", audioLevels: emptyLevels() });
      void finalizeAndWriteHistory().then((outcome) => {
        if (outcome.silent) {
          set({
            state: "idle",
            activeId: null,
            recordingId: null,
            liveTranscript: "",
          });
          return;
        }
        if (!outcome.text) {
          set({
            state: "error",
            activeId: null,
            recordingId: null,
            liveTranscript: "",
            errorMessage: i18n.t("overlay:toast.transcribe_failed.title"),
          });
          return;
        }
        window.setTimeout(() => {
          if (get().state !== "transcribing") return;
          set({
            state: "idle",
            activeId: null,
            recordingId: null,
            liveTranscript: "",
          });
        }, 800);
      });
    },
  };
});
