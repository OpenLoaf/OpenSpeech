import { create } from "zustand";
import { emit, emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import i18n from "@/i18n";
import type { BindingId, HotkeyBinding } from "@/lib/hotkey";
import { useSettingsStore, type AsrSegmentMode } from "@/stores/settings";
import { useHistoryStore } from "@/stores/history";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";
import {
  startAudioLevel,
  stopAudioLevel,
  startRecordingToFile,
  stopRecordingAndSave,
  cancelRecording,
  type RecordingResult,
} from "@/lib/audio";
import {
  startSttSession,
  finalizeSttSession,
  cancelSttSession,
  refineSpeechTextStream,
} from "@/lib/stt";
import {
  getHotwordsForRefine,
  rememberHotwordsCacheId,
} from "@/lib/hotwordsCache";
import { newId } from "@/lib/ids";

export type RecordingState =
  | "idle"
  | "preparing"
  | "recording"
  | "transcribing"
  | "injecting"
  | "error";

interface HotkeyEvent {
  id: BindingId;
  phase: "pressed" | "released";
}

// 波形 bar 数量；Overlay 的 Waveform 组件消费这个长度的滑动窗口。
// 15 × 50ms = 750ms 一个完整流动周期，密度够且肉眼能感受到"流过"。
const LEVEL_BUFFER_LEN = 20;

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
   * 临时覆盖 settings.general.asrSegmentMode——只用于"必须用 VAD 才有意义"的
   * 场景（目前是 Onboarding 第三步 Try-It：默认 MANUAL 没有 partial，
   * 用户按下快捷键后到松手前看不到任何实时文字，会以为坏了）。组件挂载时
   * 设为 'AUTO'、卸载时清空，不影响用户在 Settings 里选的值。
   */
  segmentModeOverride: AsrSegmentMode | null;
  setSegmentModeOverride: (mode: AsrSegmentMode | null) => void;
  initListeners: () => Promise<void>;
  syncBindings: (
    bindings: Record<BindingId, HotkeyBinding | null>,
  ) => Promise<void>;
  dismissError: () => void;
  simulateCancel: () => void;
  simulateFinalize: () => void;
}

const getEffectiveSegmentMode = (): AsrSegmentMode =>
  useRecordingStore.getState().segmentModeOverride ??
  useSettingsStore.getState().general.asrSegmentMode;

const PREPARING_MS = 300;
// 录音净时长 < MIN_RECORD_MS 视为"没说出有效内容"——直接丢弃，不转录、不保存
// WAV、不写历史。覆盖快速双击误触 + "按了一下就改主意"两类。
// 阈值 = PREPARING_MS（流准备）+ 1000（最少说话时长）
const MIN_RECORD_MS = 1000;
const TOO_SHORT_TOTAL_MS = PREPARING_MS + MIN_RECORD_MS;

// error 态最长停留时长——超过后自动回 idle，避免悬浮条因用户没注意到错误而
// 永久挂在屏幕上。Toast (2s) 提示先消失，再多给约 2s 让用户读 pill 上的错误
// 文字。需要更久阅读时间的错误应改用 toast 的 durationMs 控制。
const ERROR_AUTO_DISMISS_MS = 4000;

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
  | "open_settings_byo";
interface OverlayToastOptions {
  description?: string;
  action?: { label: string; key: OverlayToastActionKey };
  durationMs?: number;
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
  });
};

// 失败原因翻译：Rust 端 stt_start 失败典型文案：
//   "not authenticated; login first"
//   "audio stream not running; start mic first"
//   "realtime connect: network error: HTTP error: 500 Internal Server Error"
//   "realtime connect: network error: ..."
//   "send_start: ..."
// 归一成一句人话给 toast——用户不需要看 Rust 层层包装的原文。
const humanizeSttError = (raw: unknown): string => {
  const msg = String(raw ?? "");
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
// Rust stt_start / 文件转写 401 后返回的稳定错误码。识别它就直接走"会话过期"
// 路径——cancel 当前录音 + 弹登录框，不再用兜底 toast 静默 fallback 到本地录音。
const isAuthError = (msg: string) =>
  msg === "unauthorized" ||
  msg === "not authenticated" ||
  msg.includes("not authenticated") ||
  msg.includes("unauthorized") ||
  msg.includes("401");

// 401 / 未登录时的统一兜底：丢弃本次录音、回到 idle，并把用户直接推到登录入口。
// 不留"仅本地录音"的兜底——用户没登录就不该让录音继续偷偷消耗麦克风。
const handleAuthLost = () => {
  if (!IS_MAIN_WINDOW) return;
  console.warn("[stt] auth lost (401) → cancelling recording + opening login");
  discardRecording();
  stopMic();
  useRecordingStore.setState({
    state: "idle",
    activeId: null,
    audioLevels: emptyLevels(),
    recordingId: null,
    liveTranscript: "",
  });
  // openLogin 会拉回主窗口 + 弹 LoginDialog；不在这里再叠 toast 干扰。
  useUIStore.getState().openLogin();
};

const abortToIdle = (errorTitle: string, errorDesc: string) => {
  if (!IS_MAIN_WINDOW) return;
  discardRecording();
  stopMic();
  useRecordingStore.setState({
    state: "idle",
    activeId: null,
    audioLevels: emptyLevels(),
    recordingId: null,
    liveTranscript: "",
  });
  notifyOverlay("error", errorTitle, { description: errorDesc });
};

const startRecordingSession = (id: string) => {
  if (!IS_MAIN_WINDOW) return;
  void startRecordingToFile(id)
    .then(() => {
      const segmentMode = getEffectiveSegmentMode();
      const sttMode = segmentMode === "REALTIME" ? "auto" : "manual";
      startSttSession({ mode: sttMode }).catch((e) => {
        const raw = String(e ?? "");
        if (isAuthError(raw)) {
          handleAuthLost();
          return;
        }
        console.warn("[stt] start failed → aborting recording:", e);
        abortToIdle(
          i18n.t("overlay:toast.stt_start_failed.title"),
          i18n.t("overlay:toast.stt_start_failed.description", {
            reason: humanizeSttError(e),
          }),
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

type FinalizeOutcome = {
  rec: RecordingResult | null;
  text: string; // 最终转写文字，空串表示失败 / 超时
};

/**
 * 主窗口独占：先停 mic 再 finalize ASR，确保 cpal 回调里最后一批 PCM 已经全部
 * 入 ctrl_tx，再让 IPC 线程发 Finish——否则 Finish 与尾部 audio 会在同一个 mpsc
 * 通道上抢生产者顺序，服务端可能在拿到完整音频前就被 client_finish 关掉，
 * 导致 0 段 Final + credits=0 的"假静音"。
 */
const finalizeAndWriteHistory = async (): Promise<FinalizeOutcome> => {
  if (!IS_MAIN_WINDOW) return { rec: null, text: "" };
  const recSettled = await Promise.allSettled([stopRecordingAndSave()]).then((r) => r[0]);
  const sttSettled = await Promise.allSettled([finalizeSttSession()]).then((r) => r[0]);
  const rec = recSettled.status === "fulfilled" ? recSettled.value : null;
  const text =
    sttSettled.status === "fulfilled" && sttSettled.value ? sttSettled.value : "";

  if (sttSettled.status === "rejected") {
    console.warn("[stt] finalize failed:", sttSettled.reason);
    // "no active stt session" 是 start 失败后的必然后续——start 那步已经 toast 过，
    // 这里不重复骚扰。其他错误才弹。
    const reason = String(sttSettled.reason ?? "");
    if (!reason.includes("no active stt session")) {
      notifyOverlay("error", i18n.t("overlay:toast.transcribe_failed.title"), {
        description: humanizeSttError(sttSettled.reason),
      });
    }
  } else if (sttSettled.status === "fulfilled" && !sttSettled.value) {
    // 0 段 Final：可能是真静音、也可能是服务端没识别成功。无论哪种用户都该
    // 看到反馈，否则"按了快捷键啥都没发生"比错误提示更糟。toast 几秒自动消失。
    console.warn("[stt] no final transcript (silent or timeout)");
    notifyOverlay("error", i18n.t("overlay:toast.transcribe_failed.title"), {
      description: i18n.t("overlay:toast.transcribe_failed.no_transcript"),
      durationMs: 5000,
    });
  }

  // 拿到 transcript 后切到 "injecting"——overlay 把"思考中"切成"输出中"，
  // 反映真实进度（接下来要么走 AI_REFINE 流式逐字敲、要么末尾整段 paste）。
  if (text && IS_MAIN_WINDOW && useRecordingStore.getState().state === "transcribing") {
    useRecordingStore.setState({ state: "injecting" });
  }
  if (recSettled.status === "rejected") {
    console.error("[recording] stop failed:", recSettled.reason);
    notifyOverlay("error", i18n.t("overlay:toast.recording_save_failed.title"), {
      description: String(recSettled.reason),
    });
  }

  // AI_REFINE：拿到原始 transcript 后强制走流式 OL-TL-005，每个 Delta 通过
  // injectIncremental 实时敲到光标位置（剪贴板 + Cmd/Ctrl+V 单字符段）。
  // 流结束后把整段 refinedText 写回剪贴板，覆盖最后一段 delta，让用户后续
  // Cmd+V / Cmd+C 都拿到完整内容。
  //
  // 热词：dictionary 派生 hotwords + 进程内缓存 cacheId（v0.3.6+）。后端优先
  // 走 cacheId 命中路径，410 时自动回退明文重发，前端只需透传两者。
  //
  // 流式失败 / auth 异常时 refinedText 保持 null，最终 finalText = text，
  // 走原 UTTERANCE 路径整段贴到光标。
  const segmentMode = getEffectiveSegmentMode();
  let refinedText: string | null = null;
  console.info(
    `[refine] gate textLen=${text.length} segmentMode=${segmentMode} willCallRefine=${!!text && segmentMode === "AI_REFINE"}`,
  );
  if (text && segmentMode === "AI_REFINE") {
    const { hotwords, hotwordsCacheId } = getHotwordsForRefine();
    resetIncrementalInject();
    let streamedSoFar = "";
    const refineStart = performance.now();
    console.info(
      `[refine] stream start textLen=${text.length} hotwordsLen=${hotwords?.length ?? 0} cacheId=${hotwordsCacheId ? "yes" : "no"}`,
    );
    try {
      const r = await refineSpeechTextStream(
        { text, hotwords: hotwords || undefined, hotwordsCacheId },
        (chunk) => {
          streamedSoFar += chunk;
          injectIncremental(streamedSoFar);
        },
      );
      refinedText = r.refinedText;
      console.info(
        `[refine] stream done refinedLen=${refinedText.length} elapsedMs=${Math.round(performance.now() - refineStart)} credits=${r.creditsConsumed ?? "?"}`,
      );
      rememberHotwordsCacheId(hotwords, r.hotwordsCacheId);
      try {
        await injectChain;
      } catch {}
      try {
        await writeClipboard(refinedText);
      } catch (e) {
        console.warn("[clipboard] post-refine writeText failed:", e);
      }
    } catch (e) {
      const raw = String(e ?? "");
      if (isAuthError(raw)) {
        console.warn(
          `[refine] auth lost after ${Math.round(performance.now() - refineStart)}ms: ${raw}`,
        );
        handleAuthLost();
      } else {
        console.warn(
          `[refine] stream failed after ${Math.round(performance.now() - refineStart)}ms, falling back to raw transcript:`,
          e,
        );
        notifyOverlay(
          "warning",
          i18n.t("overlay:toast.transcribe_failed.title"),
          { description: humanizeSttError(e) },
        );
      }
    }
    void streamedSoFar;
  } else if (text && segmentMode !== "AI_REFINE") {
    console.info(`[refine] skipped, segmentMode=${segmentMode}`);
  }
  const finalText = refinedText ?? text;

  if (rec) {
    await useHistoryStore.getState().add({
      type: "dictation",
      text: text || transcriptPlaceholder(),
      refined_text: refinedText,
      status: text ? "success" : "failed",
      error: text ? undefined : "no final transcript",
      duration_ms: rec.duration_ms,
      audio_path: rec.audio_path,
    });
  }

  // 末尾兜底：把"还没敲到光标的剩余部分"补完。三种模式统一走 lastInjectedText
  // diff，不再以"流过任何一段"作为整段 paste 的开关——AI_REFINE 流式中途抛错
  // 或 startsWith 短路（前缀被纠错）会让 lastInjectedText 落后于真实 finalText，
  // 之前用 aiRefineStreamed 一刀切跳过 paste 会导致"前半敲到了、后半凭空丢失"，
  // 而历史 / 剪贴板里仍是完整文本——这正是用户报告的"另一半没了"根因。
  //
  // 前缀对不上（catch 后 finalText 退回原始 transcript，与已敲下的 refined 不一致）
  // → 不强行接尾，避免拼成半 refined 半 raw 的串，把整段 finalText 写剪贴板让
  // 用户手动 Cmd/Ctrl+V 拿到完整结果。
  if (finalText) {
    try {
      await injectChain;
    } catch {}
    if (finalText.startsWith(lastInjectedText)) {
      const remaining = finalText.slice(lastInjectedText.length);
      if (remaining) {
        let clipboardOk = false;
        try {
          await writeClipboard(remaining);
          clipboardOk = true;
        } catch (e) {
          console.warn("[clipboard] writeText failed:", e);
          notifyOverlay("warning", i18n.t("overlay:toast.clipboard_failed.title"), {
            description: String(e),
          });
        }
        if (clipboardOk) {
          try {
            await invoke("inject_paste");
          } catch (e) {
            console.warn("[inject] paste failed:", e);
            notifyOverlay("warning", i18n.t("overlay:toast.paste_failed.title"), {
              description: i18n.t("overlay:toast.paste_failed.description"),
            });
          }
        }
      }
    } else {
      console.warn(
        "[stt] finalText prefix mismatch with injected text → fallback to clipboard-only",
        { injected: lastInjectedText.length, final: finalText.length },
      );
      try {
        await writeClipboard(finalText);
      } catch (e) {
        console.warn("[clipboard] writeText failed:", e);
      }
      notifyOverlay("warning", i18n.t("overlay:toast.paste_failed.title"), {
        description: i18n.t("overlay:toast.paste_failed.description"),
      });
    }
    resetIncrementalInject();
  }
  return { rec, text: finalText };
};

// AUTO（VAD）模式下的增量注入状态：每次服务端 Final 到达，asr-final payload 是
// 当前为止「所有已 Final 段拼起来的整段」。我们把超出 lastInjectedText 的差量
// 写剪贴板 + 模拟 Cmd/Ctrl+V，让用户边说边看到字落到焦点输入框里。
//
// injectChain 串行化：enigo 的 Cmd+V 不会被打断，但 writeClipboard 是异步，
// 多次 final 几乎同时到达时会撞剪贴板（后写覆盖前写、前一段没贴完就被改）。
// 用一个 Promise 串行链兜住。
let lastInjectedText = "";
let injectChain: Promise<void> = Promise.resolve();

const resetIncrementalInject = () => {
  lastInjectedText = "";
};

const injectIncremental = (fullText: string) => {
  if (!IS_MAIN_WINDOW) return;
  // 服务端纠错把已注入的前缀改写时（极少），无法回退已敲下去的字符；
  // 跳过本轮增量，等 finalize 走原路径把"剩余的"再贴一次（用户视觉上会出现重复，
  // 但比反复抖动更可控）。
  if (!fullText.startsWith(lastInjectedText)) return;
  const delta = fullText.slice(lastInjectedText.length);
  if (!delta) return;
  lastInjectedText = fullText;
  injectChain = injectChain.then(async () => {
    try {
      await writeClipboard(delta);
      await invoke("inject_paste");
    } catch (e) {
      console.warn("[stt] incremental inject failed:", e);
    }
  });
};

const discardRecording = () => {
  if (!IS_MAIN_WINDOW) return;
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
  console.log("[recording] abort: saving audio without transcription");
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
  if (rec) {
    try {
      await useHistoryStore.getState().add({
        type: "dictation",
        text: i18n.t("overlay:transcript.aborted_placeholder"),
        status: "cancelled",
        duration_ms: rec.duration_ms,
        audio_path: rec.audio_path,
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

// 听写提示音：Web Audio 即时合成，零素材依赖。
// 桌面壳 WebView 内不需 user gesture 即可 resume（与浏览器策略不同）。
let audioCtx: AudioContext | null = null;
const ensureAudioCtx = () => {
  if (!IS_MAIN_WINDOW) return null;
  if (!audioCtx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  if (audioCtx.state === "suspended") void audioCtx.resume();
  return audioCtx;
};

// 柔和"叮咚"：sine 基频 + 一点八度泛音，串 lowpass 软化高频；30ms attack + 指数衰减，避免敲击的硬边缘
const ding = (
  freq: number,
  durationMs: number,
  delayMs = 0,
  peakGain = 0.09,
) => {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delayMs / 1000;
  const t1 = t0 + durationMs / 1000;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.value = freq * 2.2;
  filter.Q.value = 0.4;
  filter.connect(ctx.destination);
  const partials = [
    { ratio: 1, gain: 1 },
    { ratio: 2, gain: 0.18 },
  ] as const;
  for (const p of partials) {
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq * p.ratio;
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(peakGain * p.gain, t0 + 0.03);
    g.gain.exponentialRampToValueAtTime(0.0001, t1);
    osc.connect(g).connect(filter);
    osc.start(t0);
    osc.stop(t1 + 0.05);
  }
};

const playStartCue = () => {
  ding(440, 280, 0); // A4
  ding(659.25, 420, 160); // E5，上行纯五度，温暖的"叮咚"
};
const playStopCue = () => {
  ding(523.25, 460, 0); // C5 单音，柔和收尾
};
const playCancelCue = () => {
  ding(659.25, 260, 0); // E5
  ding(440, 460, 160); // A4，下行表撤回
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
    segmentModeOverride: null,

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

      // 主窗每次 set 后向 overlay 推送一次 FSM 快照 + 在状态过渡时播放提示音。
      // 20Hz 的 audioLevels 不在这里同步——overlay 自己 listen 'audio-level'，
      // 避免双倍 IPC 流量。
      let prevSnapshot = "";
      let prevState: RecordingState = get().state;
      let errorDismissTimer: number | null = null;
      useRecordingStore.subscribe((s) => {
        // 提示音三条 FSM 边触发——startCue 放在进入 preparing 时（按下即响），
        // 不等 PREPARING_MS 后才到 recording，否则用户感觉"按了 300ms 才有反馈"。
        // cancelCue 覆盖 ESC 双击、overlay × 按钮、快速双击误触三条收尾路径。
        if (
          (prevState === "idle" || prevState === "error") &&
          s.state === "preparing"
        ) {
          playStartCue();
        } else if (prevState === "recording" && s.state === "transcribing") {
          playStopCue();
        } else if (
          (prevState === "preparing" || prevState === "recording") &&
          s.state === "idle"
        ) {
          playCancelCue();
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
        else if (wasActive && !isActive) {
          escCaptureStop();
          // 离开 active 态（提交 / 完成 / 别处取消）时同步清掉 ESC 状态：
          // 否则 timer 仍在跑，下一次进入录音的瞬间可能误触发 disarm/cancel。
          if (escFirstAt > 0 || escPendingTimer !== null || escPromptTimer !== null) {
            clearEscTimers();
            escFirstAt = 0;
            void emitTo("overlay", "openspeech://esc-disarmed", null);
          }
        }

        prevState = s.state;

        // error 自愈：每次状态变化先清旧定时器；若进入 error 则重新计时。
        // 同样的 error 重复 set（errorMessage 变了）也会重置——给"最近一次错误"
        // 完整的 ERROR_AUTO_DISMISS_MS 阅读窗口。
        if (errorDismissTimer !== null) {
          window.clearTimeout(errorDismissTimer);
          errorDismissTimer = null;
        }
        if (s.state === "error") {
          errorDismissTimer = window.setTimeout(() => {
            errorDismissTimer = null;
            if (useRecordingStore.getState().state === "error") {
              useRecordingStore.getState().dismissError();
            }
          }, ERROR_AUTO_DISMISS_MS);
        }

        const snap = JSON.stringify({
          state: s.state,
          activeId: s.activeId,
          errorMessage: s.errorMessage,
          recordingId: s.recordingId,
          liveTranscript: s.liveTranscript,
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
              // 转写没拿到任何文字（0 段 Final / 超时 / 异常）：进入 error 态，
              // 让 PTT 在 ERROR_AUTO_DISMISS_MS（4s）内被忽略，避免用户看到失败
              // toast 之前又触发一次新的录音、连环失败。
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

          // 中间态 / error 态都忽略新的 PTT 触发：
          // - transcribing / injecting / preparing：流程未完成，避免抢资源；
          // - error：刚失败的 toast 还在显示（ERROR_AUTO_DISMISS_MS=4s 后自动回 idle），
          //   立刻让用户再录一遍多半是同样的失败，反而盖过提示信息。
          if (cur.state !== "idle") {
            console.warn(
              "[recording] press IGNORED: state not idle/error and activeId mismatch",
              {
                pressed_id: id,
                cur_state: cur.state,
                cur_activeId: cur.activeId,
              },
            );
            return;
          }

          // Gate：转写后端必须至少一条可用，否则录了一段没人转的废录音是浪费。
          //   saasReady = 已登录 OpenLoaf（默认 dictationSource=SAAS 走云端）
          //   byoReady  = dictationSource=BYO 且填了 endpoint（用户自带 REST STT）
          // 两者皆无则拦截：弹登录窗口（同时给"使用自己的 STT 端点"按钮跳设置）。
          // 主窗 / overlay 都会跑到这里：overlay 没 init auth/settings，默认值
          // 也会判 blocked → return；openLogin 在 overlay 里写自己 store 没渲染 dialog，
          // 等价于 no-op，主窗弹窗由主窗 store 驱动。
          let auth = useAuthStore.getState();
          const settingsGeneral = useSettingsStore.getState().general;
          let saasReady = auth.isAuthenticated;
          const byoReady =
            settingsGeneral.dictationSource === "BYO" &&
            settingsGeneral.endpoint.trim() !== "";
          // 未登录但 keychain 里可能还有 refresh_token（启动时网络断或本地后端
          // 没起导致 bootstrap 没恢复成功）——把"按下快捷键"当作主动重试信号，
          // 静默尝试用 refresh_token 换一次 access_token。1.5s 超时兜底，避免
          // 服务器很慢时让用户感觉"按了没反应"；超时后走原弹登录 dialog 路径。
          if (!saasReady && !byoReady) {
            const recovered = await Promise.race([
              invoke<boolean>("openloaf_try_recover").catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 1500)),
            ]);
            if (recovered) {
              auth = useAuthStore.getState();
              saasReady = auth.isAuthenticated;
            }
          }
          if (!saasReady && !byoReady) {
            console.log("[recording] gate blocked: no STT backend available");
            // 主窗聚焦时（用户正在主程序里按快捷键），overlay 实际不可见，
            // toast 推过去也看不到——直接在主窗弹 LoginDialog 才合理。
            // 主窗失焦时（用户在别的 app 里按快捷键）才走悬浮条 toast + 动作按钮，
            // 避免被强行拉前台。
            const mainFocused = IS_MAIN_WINDOW
              ? await getCurrentWebviewWindow()
                  .isFocused()
                  .catch(() => false)
              : false;
            if (mainFocused) {
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
          // 必然失败、本地录音也无人转写。BYO 用户允许 endpoint 指 localhost / LAN，跳过。
          // 双重判定：
          //   1) 同步 `navigator.onLine === false` —— 系统层链路就断了，必拦，最快
          //   2) 异步 `invoke("openloaf_health_check")` —— SDK 0.2.7+ 通过
          //      `payment.list_plans()` 探活公开端点，可识别"链路通但 SaaS 挂掉
          //      / captive portal / DNS 挂"等系统层捕获不到的场景；
          //      fire-and-forget 启动录音的同时跑，1-2s 后若 false，且录音仍在
          //      preparing/recording 阶段则 cancel + 弹窗。
          // 与登录 gate 一样，overlay 也会跑到这里——openNoInternet 写自己 store
          // 不渲染 dialog 等价 no-op，主窗 dialog 由主窗 ui store 驱动。
          const usingSaas =
            saasReady && settingsGeneral.dictationSource !== "BYO";
          if (
            usingSaas &&
            typeof navigator !== "undefined" &&
            navigator.onLine === false
          ) {
            console.warn("[recording] gate blocked: offline (SAAS path) — silent");
            return;
          }
          // 异步健康探针——只在主窗执行（IS_MAIN_WINDOW）以避免重复 invoke。
          if (usingSaas && IS_MAIN_WINDOW) {
            invoke<boolean>("openloaf_health_check")
              .then((healthy) => {
                if (healthy) return;
                // 录音仍在进行才取消；用户可能已经主动结束，这时不要打断 transcribing。
                const s = get();
                if (s.state === "preparing" || s.state === "recording") {
                  console.warn("[recording] health check failed → cancelling silently");
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
            return;
          }

          const recordingId = newId();
          resetIncrementalInject();
          set({
            state: "preparing",
            activeId: id,
            errorMessage: null,
            lastPressAt: now,
            audioLevels: emptyLevels(),
            recordingId,
            liveTranscript: "",
          });
          // Rust audio_level_start 现在同步等到 cpal stream 真正起来才返回。
          // 失败 / 超时 → 直接退回 idle 并提示，不再走 stt_start 撞 "audio
          // stream not running"。中途用户若再按一次（state 已变），下方守卫会 skip。
          void startMic().then((ok) => {
            const s = get();
            if (s.state !== "preparing" || s.activeId !== id) return;
            if (!ok) {
              set({
                state: "idle",
                activeId: null,
                audioLevels: emptyLevels(),
                recordingId: null,
                liveTranscript: "",
              });
              notifyOverlay("error", i18n.t("overlay:toast.recording_start_failed.title"), {
                description: i18n.t("overlay:error.stt_mic_not_ready"),
              });
              return;
            }
            startRecordingSession(recordingId);
            set({ state: "recording" });
          });
          return;
        }
      });

      const u2 = await listen<{ id: string; error: string }>(
        "openspeech://hotkey/register-failed",
        (evt) => {
          console.warn("[recording] register-failed:", evt.payload);
          discardRecording();
          stopMic();
          set({
            state: "error",
            errorMessage: i18n.t("overlay:error.register_failed", {
              id: evt.payload.id,
              error: evt.payload.error,
            }),
            audioLevels: emptyLevels(),
            recordingId: null,
            liveTranscript: "",
          });
        },
      );

      let levelTickCount = 0;
      const u3 = await listen<number>(
        "openspeech://audio-level",
        (evt) => {
          const v = Math.max(0, Math.min(1, Number(evt.payload) || 0));
          levelTickCount += 1;
          // 每秒打一次（20Hz emit），便于在 overlay devtools 里观察事件是否到达
          if (levelTickCount % 20 === 0) {
            console.log(
              "[recording] audio-level tick",
              levelTickCount,
              "v=",
              v.toFixed(3),
            );
          }
          set((s) => ({
            audioLevels: [...s.audioLevels.slice(1), v],
          }));
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
        if (mode === "REALTIME") {
          injectIncremental(text);
        }
      });
      const u6 = await listen<{ code: string; message: string }>(
        "openspeech://asr-error",
        (evt) => {
          console.warn("[stt] asr-error:", evt.payload);
          const { code, message } = evt.payload ?? { code: "", message: "" };
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

      // Esc 取消——走 Rust modifier_only 的预览通道（`openspeech://key-preview`），
      // 不注册为全局快捷键（否则会拦截用户在其他应用里的 Esc）。状态门控：仅当录音 /
      // 转写流程活跃时响应，idle / injecting 忽略。
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
        void emitTo("overlay", "openspeech://esc-disarmed", null);
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
          if (s === "idle" || s === "error" || s === "injecting") return;

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
            void emitTo("overlay", "openspeech://esc-armed", null);
            // info 风格：te-light-gray 描边 + 白字，与 te-accent（黄）/ 任何
            // 错误（红）风格都拉开距离，避免被误读为"录音条出错了"。
            notifyOverlay("info", i18n.t("overlay:toast.esc_arm.title"), {
              durationMs: ESC_PROMPT_MS,
            });
            escPromptTimer = window.setTimeout(() => {
              escPromptTimer = null;
              escFirstAt = 0;
              void emitTo("overlay", "openspeech://esc-disarmed", null);
              console.log("[recording] Esc prompt timeout → disarmed");
            }, ESC_PROMPT_MS);
          }, ESC_PENDING_MS);
        },
      );

      unlistens.push(u1, u2, u3, u4, u5, u6, u7, u8);
      console.log(
        "[recording] listeners attached (hotkey + register-failed + audio-level + asr-*)",
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
