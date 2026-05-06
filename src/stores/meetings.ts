// 会议会话 store。
//
// 编排顺序（与 dictation 主路径完全分开）：
//   start：startAudioLevel → audio_recording_start → meeting_start
//                            ↑(cpal stream 拉起后 PCM 自动 fanout 给会议会话)
//   stop ：meeting_stop → audio_recording_stop（拿 audio_path）→ stopAudioLevel
//   pause/resume：只通知 meeting_*；cpal 继续跑（暂停时 fanout 丢帧不识别）。
//
// 会议必须用支持 speaker_diarization 的 vendor。前端不做 vendor 判断——
// 凭证由 dictation settings 透传，Rust 端 dispatch 不通过会返错码：
//   meeting_provider_unsupported / meeting_provider_not_configured

import { create } from "zustand";

import {
  cancelRecording,
  startAudioLevel,
  startRecordingToFile,
  stopAudioLevel,
  stopRecordingAndSave,
  type RecordingResult,
} from "@/lib/audio";
import {
  pauseMeeting,
  resumeMeeting,
  startMeeting,
  stopMeeting,
  subscribeMeetingEvents,
  type MeetingErrorPayload,
  type MeetingSegmentPayload,
} from "@/lib/meetings";
import { newId } from "@/lib/ids";
import { useSettingsStore } from "@/stores/settings";

export type MeetingView = "idle" | "live" | "paused" | "review";

export interface MeetingSegment {
  /** sentence_id 作为本地 key（partial→final 同一 sid 会覆盖） */
  sentenceId: number;
  /** -1 = 待识别（speaker 聚类未稳定） */
  speakerId: number;
  text: string;
  startMs: number;
  endMs: number;
  isFinal: boolean;
}

interface MeetingsState {
  view: MeetingView;
  meetingId: string | null;
  /** 累计运行毫秒（pause 不增长） */
  elapsedMs: number;
  /** 真正活动期间的本地起点；pause 时清零，resume 时重置 */
  activeStartedAt: number | null;
  segments: Map<number, MeetingSegment>;
  /** 最近一次 stop 后填充：用于 review 视图渲染录音文件 */
  lastRecording: RecordingResult | null;
  error: { code: string; message: string } | null;

  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  goToReview: () => void;
  back: () => void;
  /** 在 App 启动时调一次：订阅 6 个事件，写入 store。 */
  initSubscriptions: () => Promise<() => void>;
}

const initialState = {
  view: "idle" as MeetingView,
  meetingId: null,
  elapsedMs: 0,
  activeStartedAt: null,
  segments: new Map<number, MeetingSegment>(),
  lastRecording: null,
  error: null,
};

let unsubscribe: (() => void) | null = null;
let timerId: number | null = null;
/** elapsedMs 的"已累计"基线，timer 在此之上每 tick 加 (Date.now() - activeStartedAt)。 */
let elapsedBaseline = 0;

function startTimer(set: (partial: Partial<MeetingsState>) => void, getStartedAt: () => number | null) {
  if (timerId !== null) return;
  timerId = window.setInterval(() => {
    const startedAt = getStartedAt();
    if (startedAt == null) return;
    set({ elapsedMs: elapsedBaseline + (Date.now() - startedAt) });
  }, 250);
}

function stopTimer() {
  if (timerId !== null) {
    window.clearInterval(timerId);
    timerId = null;
  }
}

export const useMeetingsStore = create<MeetingsState>((set, get) => ({
  ...initialState,

  async initSubscriptions() {
    if (unsubscribe) return unsubscribe;
    const off = await subscribeMeetingEvents({
      onPartial: (p: MeetingSegmentPayload) => {
        set((s) => {
          if (p.meeting_id !== s.meetingId) return {};
          const next = new Map(s.segments);
          next.set(p.sentence_id, {
            sentenceId: p.sentence_id,
            speakerId: p.speaker_id,
            text: p.text,
            startMs: p.start_ms,
            endMs: p.end_ms,
            isFinal: false,
          });
          return { segments: next };
        });
      },
      onFinal: (p: MeetingSegmentPayload) => {
        set((s) => {
          if (p.meeting_id !== s.meetingId) return {};
          const next = new Map(s.segments);
          next.set(p.sentence_id, {
            sentenceId: p.sentence_id,
            speakerId: p.speaker_id,
            text: p.text,
            startMs: p.start_ms,
            endMs: p.end_ms,
            isFinal: true,
          });
          return { segments: next };
        });
      },
      onError: (p: MeetingErrorPayload) => {
        set({ error: { code: p.code, message: p.message } });
      },
      onEnded: () => {
        // worker 自然结束（EndOfStream / NetworkExit）；store.stop() 已或将处理 cleanup
      },
    });
    unsubscribe = off;
    return off;
  },

  async start() {
    const s = get();
    if (s.view !== "idle") return;
    set({ ...initialState, view: "live", segments: new Map(), error: null });

    const settings = useSettingsStore.getState();
    const inputDevice = settings.general.inputDevice && settings.general.inputDevice.length > 0
      ? settings.general.inputDevice
      : null;
    // 腾讯说话人分离 engine 仅 16k_zh_en_speaker，把任何 zh 变体 / follow_interface 都归到 "zh"，
    // 把 ja/ko 等不支持的语种降级到 "zh"（开发期 Rust 端会再次拒绝并报错）。
    const dictationLang = settings.dictation.lang;
    const language = dictationLang === "en" ? "en" : "zh";

    const meetingId = newId();

    try {
      const ok = await startAudioLevel(inputDevice);
      if (!ok) throw new Error("microphone unavailable");
      await startRecordingToFile(meetingId);
      await startMeeting({ meetingId, language });
    } catch (e: unknown) {
      // 回滚：任何一步失败都清场
      try { await cancelRecording(); } catch { /* noop */ }
      try { await stopAudioLevel(); } catch { /* noop */ }
      set({
        view: "idle",
        meetingId: null,
        error: { code: "start_failed", message: String(e) },
      });
      return;
    }

    const now = Date.now();
    elapsedBaseline = 0;
    set({ meetingId, activeStartedAt: now, elapsedMs: 0 });
    startTimer(
      (partial) => set(partial),
      () => get().activeStartedAt,
    );
  },

  async pause() {
    if (get().view !== "live") return;
    try {
      await pauseMeeting();
      const startedAt = get().activeStartedAt;
      if (startedAt) elapsedBaseline += Date.now() - startedAt;
      stopTimer();
      set({ view: "paused", activeStartedAt: null, elapsedMs: elapsedBaseline });
    } catch (e) {
      set({ error: { code: "pause_failed", message: String(e) } });
    }
  },

  async resume() {
    if (get().view !== "paused") return;
    try {
      await resumeMeeting();
      set({ view: "live", activeStartedAt: Date.now() });
      startTimer(
        (partial) => set(partial),
        () => get().activeStartedAt,
      );
    } catch (e) {
      set({ error: { code: "resume_failed", message: String(e) } });
    }
  },

  async stop() {
    const s = get();
    if (s.view !== "live" && s.view !== "paused") return;
    const startedAt = s.activeStartedAt;
    if (startedAt) elapsedBaseline += Date.now() - startedAt;
    stopTimer();
    try { await stopMeeting(); } catch (e) { console.warn("[meetings] stop:", e); }
    let recording: RecordingResult | null = null;
    try { recording = await stopRecordingAndSave(); } catch (e) { console.warn("[meetings] save recording:", e); }
    try { await stopAudioLevel(); } catch { /* noop */ }
    set({
      view: "review",
      lastRecording: recording,
      elapsedMs: elapsedBaseline,
      activeStartedAt: null,
    });
  },

  async cancel() {
    stopTimer();
    elapsedBaseline = 0;
    try { await stopMeeting(); } catch { /* noop */ }
    try { await cancelRecording(); } catch { /* noop */ }
    try { await stopAudioLevel(); } catch { /* noop */ }
    set({ ...initialState, segments: new Map() });
  },

  goToReview() {
    set({ view: "review" });
  },

  back() {
    elapsedBaseline = 0;
    set({ ...initialState, segments: new Map() });
  },
}));

/** 拍序后的 segments 数组，view 直接消费。 */
export function selectSortedSegments(s: MeetingsState): MeetingSegment[] {
  return Array.from(s.segments.values()).sort((a, b) => a.startMs - b.startMs);
}
