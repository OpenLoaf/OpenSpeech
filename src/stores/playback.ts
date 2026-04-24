// 历史记录回放的单例状态：同一时刻最多只有一条录音在播。
//
// 为什么用 Zustand 而不是 ref：列表里每一行都要显示"自己是不是正在播"，
// 用 store 订阅一次就能让所有 <PlayButton /> 自动同步；切到别的行时，前一行
// 会自动 re-render 成 Play 图标。
//
// HTMLAudioElement / Blob URL 是 React 之外的副作用资源，放在 module scope，
// 在 set 之外手动维护——避免把不可序列化的对象塞进 store state 里。

import { create } from "zustand";
import { loadRecordingBytes } from "@/lib/audio";

interface PlaybackStore {
  /** 当前正在播放的 history.id；null 表示无播放 */
  playingId: string | null;
  /** 切换播放：点同一行 = 暂停；点别的行 = 切到该行 */
  toggle: (id: string, audioPath: string) => Promise<void>;
  /** 强制停止（页面卸载 / 条目被删时调用） */
  stop: () => void;
}

let audio: HTMLAudioElement | null = null;
let currentUrl: string | null = null;

function revokeUrl() {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
    currentUrl = null;
  }
}

export const usePlaybackStore = create<PlaybackStore>((set, get) => {
  const ensureAudio = (): HTMLAudioElement => {
    if (!audio) {
      audio = new Audio();
      audio.addEventListener("ended", () => {
        revokeUrl();
        set({ playingId: null });
      });
      audio.addEventListener("error", () => {
        revokeUrl();
        set({ playingId: null });
      });
    }
    return audio;
  };

  return {
    playingId: null,

    toggle: async (id, audioPath) => {
      const current = get().playingId;
      // 同一行再次点击 = 暂停并复位
      if (current === id && audio && !audio.paused) {
        audio.pause();
        revokeUrl();
        set({ playingId: null });
        return;
      }
      // 切到别的行：停掉旧的再加载新的
      if (audio) audio.pause();
      revokeUrl();

      try {
        const buf = await loadRecordingBytes(audioPath);
        const blob = new Blob([buf], { type: "audio/wav" });
        currentUrl = URL.createObjectURL(blob);
        const el = ensureAudio();
        el.src = currentUrl;
        set({ playingId: id });
        await el.play();
      } catch (e) {
        console.error("[playback] failed to play recording:", e);
        revokeUrl();
        set({ playingId: null });
      }
    },

    stop: () => {
      if (audio) audio.pause();
      revokeUrl();
      set({ playingId: null });
    },
  };
});
