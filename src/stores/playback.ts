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
  /** 当前已加载的 history.id；null 表示无加载（可能播放中或暂停中） */
  playingId: string | null;
  /** audio 是否处于播放态（暂停时为 false，但 playingId 仍保留） */
  isPlaying: boolean;
  /** audio 元素的总时长（秒），未加载或未知时为 0 */
  duration: number;
  /** audio 当前播放位置（秒） */
  currentTime: number;
  /** 切换播放：同行播放→暂停、同行暂停→恢复、异行→加载并播放 */
  toggle: (id: string, audioPath: string) => Promise<void>;
  /** 拖动进度条/点击轨道用——直接 seek 到指定秒数 */
  seek: (timeSec: number) => void;
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
      audio.addEventListener("loadedmetadata", () => {
        set({ duration: Number.isFinite(audio!.duration) ? audio!.duration : 0 });
      });
      audio.addEventListener("durationchange", () => {
        set({ duration: Number.isFinite(audio!.duration) ? audio!.duration : 0 });
      });
      audio.addEventListener("timeupdate", () => {
        set({ currentTime: audio!.currentTime });
      });
      audio.addEventListener("play", () => set({ isPlaying: true }));
      audio.addEventListener("pause", () => set({ isPlaying: false }));
      audio.addEventListener("ended", () => {
        // 自然结束：保留 playingId 让 UI 仍指向这条记录，但回到 0 + 暂停态。
        if (audio) audio.currentTime = 0;
        set({ isPlaying: false, currentTime: 0 });
      });
      audio.addEventListener("error", () => {
        revokeUrl();
        set({ playingId: null, isPlaying: false, duration: 0, currentTime: 0 });
      });
    }
    return audio;
  };

  return {
    playingId: null,
    isPlaying: false,
    duration: 0,
    currentTime: 0,

    toggle: async (id, audioPath) => {
      const current = get().playingId;
      const el = audio;

      // 同一行：在播 → 暂停，在暂停 → 恢复（保留 src 与 currentTime，方便拖动续播）
      if (current === id && el) {
        if (!el.paused) {
          el.pause();
        } else {
          try {
            await el.play();
          } catch (e) {
            console.error("[playback] resume failed:", e);
          }
        }
        return;
      }

      // 切到别的行：停掉旧的，加载新的
      if (el) el.pause();
      revokeUrl();
      set({ duration: 0, currentTime: 0, isPlaying: false });

      try {
        const buf = await loadRecordingBytes(audioPath);
        const mime = audioPath.toLowerCase().endsWith(".ogg")
          ? "audio/ogg"
          : "audio/wav";
        const blob = new Blob([buf], { type: mime });
        currentUrl = URL.createObjectURL(blob);
        const next = ensureAudio();
        next.src = currentUrl;
        set({ playingId: id });
        await next.play();
      } catch (e) {
        console.error("[playback] failed to play recording:", e);
        revokeUrl();
        set({ playingId: null, isPlaying: false, duration: 0, currentTime: 0 });
      }
    },

    seek: (timeSec) => {
      if (!audio) return;
      const dur = get().duration;
      const clamped = Math.max(0, dur > 0 ? Math.min(timeSec, dur) : timeSec);
      audio.currentTime = clamped;
      set({ currentTime: clamped });
    },

    stop: () => {
      if (audio) audio.pause();
      revokeUrl();
      set({
        playingId: null,
        isPlaying: false,
        duration: 0,
        currentTime: 0,
      });
    },
  };
});
