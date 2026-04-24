import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { BindingId, HotkeyBinding } from "@/lib/hotkey";
import { useSettingsStore } from "@/stores/settings";
import { useHistoryStore } from "@/stores/history";
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
  mode: "hold" | "toggle";
  phase: "pressed" | "released";
}

// 波形 bar 数量；Overlay 的 Waveform 组件消费这个长度的滑动窗口。
// 15 × 50ms = 750ms 一个完整流动周期，密度够且肉眼能感受到"流过"。
const LEVEL_BUFFER_LEN = 15;

interface RecordingStore {
  state: RecordingState;
  activeId: BindingId | null;
  activeMode: "hold" | "toggle" | null;
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

// 下面几个带副作用的 recording helper 仅主窗口执行——overlay 也会跑状态机来
// 驱动自身 UI，但 Rust 侧 recording_slot / stt session 都是进程全局单例，只允许
// 一方写入。
const startRecordingSession = (id: string) => {
  if (!IS_MAIN_WINDOW) return;
  void startRecordingToFile(id).then(() => {
    // 录音 session 已建立（`audio_recording_start` 里读过 stream_info），
    // 这时调 stt_start 最稳——Rust 侧也会再读一次 stream_info 拿 sampleRate/
    // channels 塞给 realtime `send_start`。未登录 / stream 未就绪 / realtime
    // connect 失败都只打警告不抛；本地录音继续，history 会以占位文字落盘。
    startSttSession().catch((e) => {
      console.warn("[stt] start failed (fallback to local-only recording):", e);
    });
  }).catch((e) => {
    console.error("[recording] start recording failed:", e);
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
  }
  if (recSettled.status === "rejected") {
    console.error("[recording] stop failed:", recSettled.reason);
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
  return { rec, text };
};

const discardRecording = () => {
  if (!IS_MAIN_WINDOW) return;
  void cancelRecording();
  void cancelSttSession();
};

export const useRecordingStore = create<RecordingStore>((set, get) => {
  const unlistens: UnlistenFn[] = [];

  return {
    state: "idle",
    activeId: null,
    activeMode: null,
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

      const u1 = await listen<HotkeyEvent>("openspeech://hotkey", (evt) => {
        console.log("[recording] event received:", evt.payload);
        const { id, mode, phase } = evt.payload;
        const now = performance.now();
        const cur = get();

        if (phase === "pressed") {
          // toggle 模式：同一绑定第二次按下 = hold 模式的 released（再按一次停）。
          // 判定放在最前，否则会被下方"非 idle/error 一律忽略"吞掉。
          if (
            mode === "toggle" &&
            cur.activeId === id &&
            (cur.state === "recording" || cur.state === "preparing")
          ) {
            const duration = now - cur.lastPressAt;
            if (duration < PREPARING_MS) {
              // < 300ms 算误触（快速双击），丢弃 samples、不写 history
              discardRecording();
              stopMic();
              set({
                state: "idle",
                activeId: null,
                activeMode: null,
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
                    activeMode: null,
                    recordingId: null,
                    liveTranscript: "",
                  });
                }, 200);
              }, 800);
            });
            return;
          }

          // Transcribing 态忽略新的触发（见 voice-input-flow.md）
          if (cur.state !== "idle" && cur.state !== "error") return;
          const recordingId = newId();
          set({
            state: "preparing",
            activeId: id,
            activeMode: mode,
            errorMessage: null,
            lastPressAt: now,
            audioLevels: emptyLevels(),
            recordingId,
            liveTranscript: "",
          });
          startMic();
          // 300ms 后 mic stream 已稳定才启动 Rust 录音 session——
          // 避免 stream_info 为 None 导致 start 失败。若此时 user 已经松手
          // 误触取消（< 300ms 分支），state 已经回到 idle，下面会 skip。
          window.setTimeout(() => {
            const s = get();
            if (s.state === "preparing" && s.activeId === id) {
              startRecordingSession(recordingId);
              set({ state: "recording" });
            }
          }, PREPARING_MS);
          return;
        }

        // released
        if (cur.activeId !== id) return;
        const duration = now - cur.lastPressAt;

        if (mode === "toggle") {
          // toggle 的 released 事件忽略，由下一次 pressed 触发停止
          return;
        }

        if (duration < PREPARING_MS) {
          // 误触：< 300ms，丢弃 samples 不写 history
          discardRecording();
          stopMic();
          set({
            state: "idle",
            activeId: null,
            activeMode: null,
            audioLevels: emptyLevels(),
            recordingId: null,
            liveTranscript: "",
          });
          return;
        }

        // 正常：停 Rust 录音 → 落盘 → 写 history → 占位 UI
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
                activeMode: null,
                recordingId: null,
                liveTranscript: "",
              });
            }, 200);
          }, 800);
        });
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
            set({
              state: "error",
              errorMessage: "余额不足，已取消本次转写",
              audioLevels: emptyLevels(),
              recordingId: null,
              liveTranscript: "",
            });
          } else if (reason === "idle_timeout" || reason === "max_duration") {
            console.warn("[stt] session closed by server:", reason);
          }
        },
      );

      unlistens.push(u1, u2, u3, u4, u5, u6, u7);
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
        activeMode: null,
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
        activeMode: null,
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
              activeMode: null,
              recordingId: null,
              liveTranscript: "",
            });
          }, 200);
        }, 800);
      });
    },
  };
});
