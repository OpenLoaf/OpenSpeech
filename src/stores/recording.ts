import { create } from "zustand";
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { toast } from "sonner";
import type { BindingId, HotkeyBinding } from "@/lib/hotkey";
import { useSettingsStore } from "@/stores/settings";
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
} from "@/lib/stt";
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
const LEVEL_BUFFER_LEN = 15;

interface RecordingStore {
  state: RecordingState;
  activeId: BindingId | null;
  errorMessage: string | null;
  lastPressAt: number;
  startedListening: boolean;
  audioLevels: number[];
  /**
   * 当前会话的 history.id——pressed 时前端生成（`newId()`），同时作为 WAV
   * 文件名（`recordings/<id>.wav`）。落盘 / 写 history / 取消都走同一个 id。
   * idle 态为 null。
   */
  recordingId: string | null;
  /**
   * 实时 ASR partial 文本：Rust 转发 `openspeech://asr-partial` 事件时更新。
   * UI（悬浮录音条 / 设置预览）可以直接订阅这个字段展示流式转写结果。
   * recording → idle 过渡时清空；Final 事件到达时替换为最终文字。
   */
  liveTranscript: string;
  initListeners: () => Promise<void>;
  syncBindings: (
    bindings: Record<BindingId, HotkeyBinding | null>,
  ) => Promise<void>;
  dismissError: () => void;
  simulateCancel: () => void;
  simulateFinalize: () => void;
}

const PREPARING_MS = 300;

const emptyLevels = () => Array(LEVEL_BUFFER_LEN).fill(0) as number[];

// Mic 的生命周期归主窗口管：Rust 事件会广播到所有 webview，overlay 的 store 也
// 会走状态机，但只有主窗口知道"用户在设置里选了哪个设备"（overlay 不 init
// settingsStore），放任 overlay 也调 audio_level_start 会让 Rust 端频繁 restart
// stream（已观察到：main 传 "UGREEN…"、overlay 传 null，触发一次 stopped→started）。
const IS_MAIN_WINDOW = getCurrentWebviewWindow().label === "main";

const startMic = () => {
  if (!IS_MAIN_WINDOW) return;
  const device = useSettingsStore.getState().general.inputDevice || null;
  void startAudioLevel(device);
};
const stopMic = () => {
  if (!IS_MAIN_WINDOW) return;
  void stopAudioLevel();
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
  if (msg.includes("not authenticated")) return "未登录 OpenLoaf";
  if (msg.includes("HTTP error: 5")) return "SaaS 服务端错误（5xx）";
  if (msg.includes("HTTP error: 4")) return "SaaS 鉴权失败（4xx）";
  if (msg.includes("audio stream not running")) return "麦克风未就绪";
  if (msg.includes("network error")) return "网络不可达";
  const short = msg.split(":").pop()?.trim() || msg;
  return short.length > 60 ? short.slice(0, 60) + "…" : short;
};

// 下面几个带副作用的 recording helper 仅主窗口执行——overlay 也会跑状态机来
// 驱动自身 UI，但 Rust 侧 recording_slot / stt session 都是进程全局单例，只允许
// 一方写入。
const startRecordingSession = (id: string) => {
  if (!IS_MAIN_WINDOW) return;
  void startRecordingToFile(id).then(() => {
    // 录音 session 已建立（`audio_recording_start` 里读过 stream_info），
    // 这时调 stt_start 最稳——Rust 侧也会再读一次 stream_info 拿 sampleRate/
    // channels 塞给 realtime `send_start`。未登录 / stream 未就绪 / realtime
    // connect 失败都**不阻断本地录音**（WAV 仍落盘 + history 仍写），但用
    // sonner toast 明确告诉用户"本次没走实时转写"，避免静默失败。
    startSttSession().catch((e) => {
      const reason = humanizeSttError(e);
      console.warn("[stt] start failed (fallback to local-only recording):", e);
      toast.error("实时转写未启动", {
        description: `${reason} · 本次仅本地录音`,
      });
    });
  }).catch((e) => {
    console.error("[recording] start recording failed:", e);
    toast.error("录音启动失败", { description: String(e) });
  });
};

// STT 失败 / 超时时 history.text 的占位——保留之前"待转写"语义，区分 success 与 failed
// 状态：有 Final 文字 → success；空串 → failed（此时 text 用占位，UI 可据 status 分别展示）。
const TRANSCRIPT_PLACEHOLDER = "（未能获取转写结果）";

type FinalizeOutcome = {
  rec: RecordingResult | null;
  text: string; // 最终转写文字，空串表示失败 / 超时
};

/**
 * 主窗口独占：并行结束 Rust 录音 + ASR finalize，两者结果 merge 写 history。
 * 顺序无强依赖（音频已在 cpal 回调里实时流给 realtime；stop_recording 只是
 * flush WAV 文件），用 allSettled 让两边互不连累。
 */
const finalizeAndWriteHistory = async (): Promise<FinalizeOutcome> => {
  if (!IS_MAIN_WINDOW) return { rec: null, text: "" };
  const [recSettled, sttSettled] = await Promise.allSettled([
    stopRecordingAndSave(),
    finalizeSttSession(),
  ]);
  const rec = recSettled.status === "fulfilled" ? recSettled.value : null;
  const text =
    sttSettled.status === "fulfilled" && sttSettled.value ? sttSettled.value : "";

  if (sttSettled.status === "rejected") {
    console.warn("[stt] finalize failed:", sttSettled.reason);
    // "no active stt session" 是 start 失败后的必然后续——start 那步已经 toast 过，
    // 这里不重复骚扰。其他错误才弹。
    const reason = String(sttSettled.reason ?? "");
    if (!reason.includes("no active stt session")) {
      toast.error("转写失败", {
        description: humanizeSttError(sttSettled.reason),
      });
    }
  } else if (sttSettled.status === "fulfilled" && !sttSettled.value) {
    // 已建连但 Final 空串——多半 send_finish 超时（FINALIZE_WAIT_MS = 3s 过了）
    // 或全程静音。此时 history 按 status=failed 落，给用户一个友好提示。
    toast.warning("未拿到转写结果", { description: "服务端超时或全程静音" });
  }
  if (recSettled.status === "rejected") {
    console.error("[recording] stop failed:", recSettled.reason);
    toast.error("录音保存失败", { description: String(recSettled.reason) });
  }

  if (rec) {
    await useHistoryStore.getState().add({
      type: "dictation",
      text: text || TRANSCRIPT_PLACEHOLDER,
      status: text ? "success" : "failed",
      error: text ? undefined : "no final transcript",
      duration_ms: rec.duration_ms,
      audio_path: rec.audio_path,
    });
  }

  // 结束阶段：把最终文字写到系统剪贴板，再通过 enigo 模拟 Cmd/Ctrl+V 粘贴
  // 到松开 PTT 时焦点所在的输入框。剪贴板写失败 / 注入失败都不致命——文字
  // 仍可在历史里查到，用户也可手动粘贴。空串跳过整段。
  if (text) {
    let clipboardOk = false;
    try {
      await writeClipboard(text);
      clipboardOk = true;
    } catch (e) {
      console.warn("[clipboard] writeText failed:", e);
      toast.warning("复制到剪贴板失败", { description: String(e) });
    }
    if (clipboardOk) {
      try {
        await invoke("inject_paste");
      } catch (e) {
        console.warn("[inject] paste failed:", e);
        toast.warning("自动粘贴失败", {
          description: "文字已复制，请手动按 Cmd/Ctrl+V",
        });
      }
    }
  }
  return { rec, text };
};

const discardRecording = () => {
  if (!IS_MAIN_WINDOW) return;
  void cancelRecording();
  void cancelSttSession();
};

// 听写开始 / 结束的提示音——Web Audio 即时合成，零素材依赖。
// 开始：上行双音（880→1320Hz），结束：单声中音（660Hz）。
// AudioContext lazy 初始化；macOS WKWebView / Windows WebView2 在桌面壳内
// 不需要 user gesture 就能 resume（与浏览器策略不同）。
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

const beep = (freq: number, durationMs: number, delayMs = 0, gain = 0.08) => {
  const ctx = ensureAudioCtx();
  if (!ctx) return;
  const t0 = ctx.currentTime + delayMs / 1000;
  const t1 = t0 + durationMs / 1000;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = "sine";
  osc.frequency.value = freq;
  // 5ms attack / 10ms release，避免 click 噪声
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
  g.gain.setValueAtTime(gain, t1 - 0.01);
  g.gain.linearRampToValueAtTime(0, t1);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t1 + 0.02);
};

const playStartCue = () => {
  beep(880, 70, 0);
  beep(1320, 70, 90);
};
const playStopCue = () => {
  beep(660, 110, 0);
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

    initListeners: async () => {
      if (get().startedListening) {
        console.log("[recording] initListeners: already started, skip");
        return;
      }
      set({ startedListening: true });
      console.log("[recording] initListeners: attaching listeners");

      // overlay 是镜像窗口：不跑独立状态机（hidden 期间 webview JS 会被
      // 系统 throttle，状态推进不可靠），改由主窗 FSM 通过 emitTo 向 overlay
      // 单向广播；按钮交互通过 emitTo('main', ...) 反向转发。
      if (!IS_MAIN_WINDOW) {
        const um1 = await listen<{
          state: RecordingState;
          activeId: BindingId | null;
          errorMessage: string | null;
          recordingId: string | null;
          liveTranscript: string;
        }>("openspeech://overlay-fsm", (evt) => {
          const p = evt.payload;
          set({
            state: p.state,
            activeId: p.activeId,
            errorMessage: p.errorMessage,
            recordingId: p.recordingId,
            liveTranscript: p.liveTranscript,
          });
        });

        // audio-level 仍直接广播给 overlay（推进波形）；mirror 同时不再发
        // audioLevels 字段，避免 20Hz 跨窗口 IPC 浪费。
        let levelTickCount = 0;
        const um2 = await listen<number>(
          "openspeech://audio-level",
          (evt) => {
            const v = Math.max(0, Math.min(1, Number(evt.payload) || 0));
            levelTickCount += 1;
            if (levelTickCount % 20 === 0) {
              console.log(
                "[overlay] audio-level tick",
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

        unlistens.push(um1, um2);
        console.log("[overlay] mirror listeners attached");
        return;
      }

      // 主窗每次 set 后向 overlay 推送一次 FSM 快照 + 在状态过渡时播放提示音。
      // 20Hz 的 audioLevels 不在这里同步——overlay 自己 listen 'audio-level'，
      // 避免双倍 IPC 流量。
      let prevSnapshot = "";
      let prevState: RecordingState = get().state;
      useRecordingStore.subscribe((s) => {
        // 提示音：进入 recording = 开始 cue；recording → transcribing = 结束 cue。
        // 误触取消 (preparing/recording → idle 不经 transcribing) 静默，避免噪声。
        if (prevState !== "recording" && s.state === "recording") {
          playStartCue();
        } else if (prevState === "recording" && s.state === "transcribing") {
          playStopCue();
        }
        prevState = s.state;

        const snap = JSON.stringify({
          state: s.state,
          activeId: s.activeId,
          errorMessage: s.errorMessage,
          recordingId: s.recordingId,
          liveTranscript: s.liveTranscript,
        });
        if (snap === prevSnapshot) return;
        prevSnapshot = snap;
        void emitTo("overlay", "openspeech://overlay-fsm", {
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
      unlistens.push(ua);

      const u1 = await listen<HotkeyEvent>("openspeech://hotkey", async (evt) => {
        console.log("[recording] event received:", evt.payload);
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
            if (duration < PREPARING_MS) {
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
            // 正常结束：停录音 → 写 history → 占位 transcribing → injecting → idle
            stopMic();
            set({ state: "transcribing", audioLevels: emptyLevels() });
            void finalizeAndWriteHistory().finally(() => {
              window.setTimeout(() => {
                if (get().state !== "transcribing") return;
                set({ state: "injecting" });
                window.setTimeout(() => {
                  if (get().state !== "injecting") return;
                  set({
                    state: "idle",
                    activeId: null,
                    recordingId: null,
                    liveTranscript: "",
                  });
                }, 200);
              }, 800);
            });
            return;
          }

          // Transcribing / injecting 等中间态忽略新的触发（见 voice-input-flow.md）
          if (cur.state !== "idle" && cur.state !== "error") return;

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
            // Rust 在 pressed 那一刻已 invoke overlay::show；gate 拦截后 state 不
            // 离开 idle，FSM 广播也不会触发，overlay 会停在空黑框。显式收回。
            void invoke("overlay_hide").catch(() => {});
            useUIStore.getState().openLogin();
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
            console.log("[recording] gate blocked: offline (SAAS path)");
            void invoke("overlay_hide").catch(() => {});
            useUIStore.getState().openNoInternet();
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
                  console.log("[recording] health check failed → cancelling");
                  discardRecording();
                  stopMic();
                  set({
                    state: "idle",
                    activeId: null,
                    audioLevels: emptyLevels(),
                    recordingId: null,
                    liveTranscript: "",
                  });
                  useUIStore.getState().openNoInternet();
                }
              })
              .catch((e) => {
                // 命令本身抛错（极少见，比如未注册 invoke）只打日志，不打扰用户。
                console.warn("[recording] health check invoke failed:", e);
              });
          }

          const recordingId = newId();
          set({
            state: "preparing",
            activeId: id,
            errorMessage: null,
            lastPressAt: now,
            audioLevels: emptyLevels(),
            recordingId,
            liveTranscript: "",
          });
          startMic();
          // 300ms 后 mic stream 已稳定才启动 Rust 录音 session——
          // 避免 stream_info 为 None 导致 start 失败。若此时用户已第二次按下
          // （快速双击 < 300ms 分支），state 已经回到 idle，下面会 skip。
          window.setTimeout(() => {
            const s = get();
            if (s.state === "preparing" && s.activeId === id) {
              startRecordingSession(recordingId);
              set({ state: "recording" });
            }
          }, PREPARING_MS);
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
            errorMessage: `注册失败：${evt.payload.id}（${evt.payload.error}）`,
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
        set({ liveTranscript: String(evt.payload ?? "") });
      });
      const u6 = await listen<{ code: string; message: string }>(
        "openspeech://asr-error",
        (evt) => {
          console.warn("[stt] asr-error:", evt.payload);
          const { code, message } = evt.payload ?? { code: "", message: "" };
          toast.error("转写异常", {
            description: code ? `${code}: ${message}` : message || "未知错误",
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
            toast.error("余额不足", {
              description: "已取消本次转写，请前往账户页充值",
            });
            set({
              state: "error",
              errorMessage: "余额不足，已取消本次转写",
              audioLevels: emptyLevels(),
              recordingId: null,
              liveTranscript: "",
            });
          } else if (reason === "max_duration") {
            toast.warning("会话超时", { description: "达到 2 小时服务端上限" });
            console.warn("[stt] session closed by server:", reason);
          } else if (reason === "idle_timeout") {
            console.warn("[stt] session closed by server:", reason);
          }
        },
      );

      // Esc 取消——走 Rust modifier_only 的预览通道（`openspeech://key-preview`），
      // 不注册为全局快捷键（否则会拦截用户在其他应用里的 Esc；见 docs/hotkeys.md
      // 的 "Esc 处理 · 状态化"）。状态门控：只有当录音 / 转写流程活跃时才响应，
      // idle / injecting 一律忽略——injecting 几十毫秒来不及撤回，ignore。
      const u8 = await listen<{ code: string; phase: "pressed" | "released" }>(
        "openspeech://key-preview",
        (evt) => {
          if (evt.payload.phase !== "pressed") return;
          if (evt.payload.code !== "Escape") return;
          const s = get().state;
          if (s === "idle" || s === "error" || s === "injecting") return;
          console.log("[recording] Esc pressed, cancelling", { state: s });
          discardRecording();
          stopMic();
          set({
            state: "idle",
            activeId: null,
            audioLevels: emptyLevels(),
            recordingId: null,
            liveTranscript: "",
          });
        },
      );

      unlistens.push(u1, u2, u3, u4, u5, u6, u7, u8);
      console.log(
        "[recording] listeners attached (hotkey + register-failed + audio-level + asr-*)",
      );
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
          errorMessage: `同步快捷键到 Rust 失败：${String(e)}`,
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
      discardRecording();
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
      stopMic();
      set({ state: "transcribing", audioLevels: emptyLevels() });
      void finalizeAndWriteHistory().finally(() => {
        window.setTimeout(() => {
          if (get().state !== "transcribing") return;
          set({ state: "injecting" });
          window.setTimeout(() => {
            if (get().state !== "injecting") return;
            set({
              state: "idle",
              activeId: null,
                recordingId: null,
              liveTranscript: "",
            });
          }, 200);
        }, 800);
      });
    },
  };
});
