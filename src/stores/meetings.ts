// 会议会话 store。
//
// 编排顺序（与 dictation 主路径完全分开）：
//   start：startAudioLevel → audio_recording_start → meeting_start
//                            ↑(cpal stream 拉起后 PCM 自动 fanout 给会议会话)
//   stop ：meeting_stop → audio_recording_stop（拿 audio_path）→ stopAudioLevel
//          → 写 history (type='meeting') + history_segments
//   pause/resume：只通知 meeting_*；cpal 继续跑（暂停时 fanout 丢帧不识别）。
//
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
import {
  deleteMeeting,
  insertMeetingHistory,
  listRecentMeetings,
  loadMeetingSegments,
  type MeetingHistoryRow,
} from "@/lib/meetings-history";
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
  /** review 模式下当前展示的 history.id（新会议=meetingId；打开旧会议=对应 history.id） */
  reviewMeetingId: string | null;
  /** IdleView 的最近会议列表（从 SQLite 拉） */
  recentMeetings: MeetingHistoryRow[];
  recentLoaded: boolean;
  error: { code: string; message: string } | null;

  start: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  goToReview: () => void;
  back: () => void;
  loadRecent: () => Promise<void>;
  openMeeting: (meetingId: string) => Promise<void>;
  removeMeeting: (meetingId: string) => Promise<void>;
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
  reviewMeetingId: null,
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

/** 选 final 段拼成主历史的 text 字段（速览用，没有 speaker 标注）。 */
function buildPlainTranscript(segments: MeetingSegment[]): string {
  return segments
    .filter((s) => s.isFinal)
    .map((s) => s.text.trim())
    .filter((s) => s.length > 0)
    .join("\n");
}

export const useMeetingsStore = create<MeetingsState>((set, get) => ({
  ...initialState,
  recentMeetings: [],
  recentLoaded: false,

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
    set({
      ...initialState,
      view: "live",
      segments: new Map(),
      error: null,
      recentMeetings: s.recentMeetings,
      recentLoaded: s.recentLoaded,
    });

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
      // Rust 端 build_provider() 的错误 message 形如
      // "meeting_provider_unsupported: <kind>" 或 "meeting_provider_not_configured: <details>"，
      // 解出已知前缀映射成可识别的 code 让 i18n + 引导按钮能挂上；其它兜底为 start_failed。
      const raw = String(e);
      let code = "start_failed";
      for (const known of ["meeting_provider_unsupported", "meeting_provider_not_configured"]) {
        if (raw.includes(known)) { code = known; break; }
      }
      set({
        view: "idle",
        meetingId: null,
        error: { code, message: raw },
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

    const meetingId = s.meetingId;
    const finalSegments = Array.from(get().segments.values())
      .filter((seg) => seg.isFinal)
      .sort((a, b) => a.sentenceId - b.sentenceId);

    // 写库（type='meeting' + history_segments）。
    // 跳过条件：没有 meetingId（不该发生） / 没拿到任何 final 片段（用户秒停或会话失败）/
    // retention='off'（与听写主历史一致：只保留内存）。
    const retention = useSettingsStore.getState().general.historyRetention;
    if (meetingId && finalSegments.length > 0 && retention !== "off") {
      try {
        await insertMeetingHistory({
          meetingId,
          text: buildPlainTranscript(finalSegments),
          durationMs: recording?.duration_ms ?? elapsedBaseline,
          audioPath: recording?.audio_path && recording.audio_path.length > 0
            ? recording.audio_path
            : null,
          providerKind: "tencent-realtime",
          segments: finalSegments.map((seg) => ({
            sentenceId: seg.sentenceId,
            speakerId: seg.speakerId,
            text: seg.text,
            startMs: seg.startMs,
            endMs: seg.endMs,
          })),
        });
        // 写库成功后顺手刷新最近列表
        try {
          const rows = await listRecentMeetings();
          set({ recentMeetings: rows, recentLoaded: true });
        } catch (e) {
          console.warn("[meetings] reload recent failed after insert:", e);
        }
      } catch (e) {
        console.warn("[meetings] insert history failed:", e);
        set({ error: { code: "history_save_failed", message: String(e) } });
      }
    }

    set({
      view: "review",
      lastRecording: recording,
      elapsedMs: elapsedBaseline,
      activeStartedAt: null,
      reviewMeetingId: meetingId,
    });
  },

  async cancel() {
    stopTimer();
    elapsedBaseline = 0;
    try { await stopMeeting(); } catch { /* noop */ }
    try { await cancelRecording(); } catch { /* noop */ }
    try { await stopAudioLevel(); } catch { /* noop */ }
    set({
      ...initialState,
      segments: new Map(),
      recentMeetings: get().recentMeetings,
      recentLoaded: get().recentLoaded,
    });
  },

  goToReview() {
    set({ view: "review" });
  },

  back() {
    elapsedBaseline = 0;
    set({
      ...initialState,
      segments: new Map(),
      recentMeetings: get().recentMeetings,
      recentLoaded: get().recentLoaded,
    });
  },

  async loadRecent() {
    try {
      const rows = await listRecentMeetings();
      set({ recentMeetings: rows, recentLoaded: true });
    } catch (e) {
      console.warn("[meetings] loadRecent failed:", e);
      set({ recentLoaded: true });
    }
  },

  async openMeeting(meetingId: string) {
    if (get().view !== "idle") return;
    try {
      const rows = await loadMeetingSegments(meetingId);
      const map = new Map<number, MeetingSegment>();
      for (const r of rows) {
        map.set(r.sentence_id, {
          sentenceId: r.sentence_id,
          speakerId: r.speaker_id,
          text: r.text,
          startMs: r.start_ms,
          endMs: r.end_ms,
          isFinal: true,
        });
      }
      const meta = get().recentMeetings.find((m) => m.id === meetingId);
      const dur = meta?.duration_ms ?? 0;
      elapsedBaseline = dur;
      set({
        view: "review",
        reviewMeetingId: meetingId,
        segments: map,
        elapsedMs: dur,
        activeStartedAt: null,
        meetingId: null,
        lastRecording: null,
        error: null,
      });
    } catch (e) {
      set({ error: { code: "history_open_failed", message: String(e) } });
    }
  },

  async removeMeeting(meetingId: string) {
    try {
      await deleteMeeting(meetingId);
      set({
        recentMeetings: get().recentMeetings.filter((m) => m.id !== meetingId),
      });
      // 如果当前正在 review 这条，回到 idle
      if (get().reviewMeetingId === meetingId) {
        get().back();
      }
    } catch (e) {
      set({ error: { code: "history_delete_failed", message: String(e) } });
    }
  },
}));

/** 拍序后的 segments 数组，view 直接消费。 */
export function selectSortedSegments(s: MeetingsState): MeetingSegment[] {
  return Array.from(s.segments.values()).sort((a, b) => a.startMs - b.startMs);
}
