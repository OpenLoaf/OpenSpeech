import { create } from "zustand";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { BindingId, HotkeyBinding } from "@/lib/hotkey";
import { useSettingsStore } from "@/stores/settings";
import { startAudioLevel, stopAudioLevel } from "@/lib/audio";

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
              // < 300ms 算误触（快速双击），不进转写
              stopMic();
              set({
                state: "idle",
                activeId: null,
                activeMode: null,
                audioLevels: emptyLevels(),
              });
              return;
            }
            // 正常结束：进入 transcribing → injecting → idle（占位，task #13 接入真实 STT）
            stopMic();
            set({ state: "transcribing", audioLevels: emptyLevels() });
            window.setTimeout(() => {
              if (get().state !== "transcribing") return;
              set({ state: "injecting" });
              window.setTimeout(() => {
                if (get().state !== "injecting") return;
                set({ state: "idle", activeId: null, activeMode: null });
              }, 200);
            }, 800);
            return;
          }

          // Transcribing 态忽略新的触发（见 voice-input-flow.md）
          if (cur.state !== "idle" && cur.state !== "error") return;
          set({
            state: "preparing",
            activeId: id,
            activeMode: mode,
            errorMessage: null,
            lastPressAt: now,
            audioLevels: emptyLevels(),
          });
          startMic();
          window.setTimeout(() => {
            const s = get();
            if (s.state === "preparing" && s.activeId === id) {
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
          // 误触：< 300ms
          stopMic();
          set({
            state: "idle",
            activeId: null,
            activeMode: null,
            audioLevels: emptyLevels(),
          });
          return;
        }

        // 正常：进入 transcribing → 暂时占位（task #13 接入真实 STT）
        stopMic();
        set({ state: "transcribing", audioLevels: emptyLevels() });
        // 模拟转写 + 注入的占位延迟，保证 UI 可观察
        window.setTimeout(() => {
          if (get().state !== "transcribing") return;
          set({ state: "injecting" });
          window.setTimeout(() => {
            if (get().state !== "injecting") return;
            set({ state: "idle", activeId: null, activeMode: null });
          }, 200);
        }, 800);
      });

      const u2 = await listen<{ id: string; error: string }>(
        "openspeech://hotkey/register-failed",
        (evt) => {
          console.warn("[recording] register-failed:", evt.payload);
          stopMic();
          set({
            state: "error",
            errorMessage: `注册失败：${evt.payload.id}（${evt.payload.error}）`,
            audioLevels: emptyLevels(),
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

      unlistens.push(u1, u2, u3);
      console.log(
        "[recording] listeners attached (hotkey + register-failed + audio-level)",
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
      });
    },

    simulateCancel: () => {
      stopMic();
      set({
        state: "idle",
        activeId: null,
        activeMode: null,
        audioLevels: emptyLevels(),
      });
    },

    simulateFinalize: () => {
      const cur = get();
      if (cur.state !== "recording" && cur.state !== "preparing") return;
      stopMic();
      set({ state: "transcribing", audioLevels: emptyLevels() });
      window.setTimeout(() => {
        if (get().state !== "transcribing") return;
        set({ state: "injecting" });
        window.setTimeout(() => {
          if (get().state !== "injecting") return;
          set({ state: "idle", activeId: null, activeMode: null });
        }, 200);
      }, 800);
    },
  };
});
