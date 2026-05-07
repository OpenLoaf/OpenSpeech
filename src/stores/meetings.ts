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
  type MeetingReconnectPayload,
  type MeetingSegmentPayload,
} from "@/lib/meetings";
import {
  deleteMeeting,
  insertMeetingHistory,
  listRecentMeetings,
  loadMeetingSegments,
  loadMeetingSummary,
  persistMeetingSummary,
  type MeetingHistoryRow,
  type MeetingSegmentJson,
} from "@/lib/meetings-history";
import { newId } from "@/lib/ids";
import { refineTextViaChatStream } from "@/lib/ai-refine";
import { handleAiRefineCustomFailure } from "@/lib/ai-refine-fallback";
import { getEffectiveAiMeetingSummaryPrompt } from "@/lib/defaultAiPrompts";
import { resolveLang } from "@/i18n";
import { useSettingsStore } from "@/stores/settings";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";

// "starting" 是 idle → live 的过渡态：cpal stream 拉起 + meeting_start
// (含腾讯握手) 期间停留在这里，按钮显示 loading；任意一步失败直接回 idle，
// 不让用户先看到 live 视图再被弹回来。
export type MeetingView = "idle" | "starting" | "live" | "paused" | "review";

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
  /** 后端 NetworkExit 后的重连状态——非 null 表示正在重连 / 已放弃。 */
  reconnect: {
    phase: "backoff" | "connecting" | "recovered" | "gave_up";
    attempt: number;
    maxAttempts: number;
  } | null;
  /** AI 纪要 markdown 文本；null = 还没生成 / 还没加载 */
  summary: string | null;
  /** AI 纪要状态：idle 没生成、loading 已生成只是加载中、generating 流式产生、error 失败 */
  summaryStatus: "idle" | "loading" | "generating" | "error";
  summaryError: string | null;

  start: () => Promise<void>;
  dismissError: () => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  stop: () => Promise<void>;
  cancel: () => Promise<void>;
  goToReview: () => void;
  back: () => void;
  loadRecent: () => Promise<void>;
  openMeeting: (meetingId: string) => Promise<void>;
  removeMeeting: (meetingId: string) => Promise<void>;
  /** 走 AI refine chat stream 生成纪要并落盘到 `<id>.summary.md`。 */
  generateSummary: () => Promise<void>;
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
  reconnect: null,
  summary: null,
  summaryStatus: "idle" as const,
  summaryError: null,
};

let unsubscribe: (() => void) | null = null;
let timerId: number | null = null;
/** elapsedMs 的"已累计"基线，timer 在此之上每 tick 加 (Date.now() - activeStartedAt)。 */
let elapsedBaseline = 0;
/** stop() 整段是 await stopMeeting → stopRecordingAndSave → insertMeetingHistory，
 *  第一个 await 期间 view 仍是 "live"，再点一下会并发跑两遍写库 → SQLite 抢锁
 *  → 5s busy_timeout 到期回滚 → 用户看到 "database is locked"。 */
let stopInFlight = false;

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
      onReconnecting: (p: MeetingReconnectPayload) => {
        set((s) => {
          if (p.meeting_id !== s.meetingId) return {};
          // recovered 短暂保留作为 UI 提示，500ms 后由组件清除即可；这里直接置 null。
          if (p.phase === "recovered") return { reconnect: null };
          return {
            reconnect: {
              phase: p.phase,
              attempt: p.attempt,
              maxAttempts: p.max_attempts,
            },
          };
        });
      },
    });
    unsubscribe = off;
    return off;
  },

  async start() {
    const s = get();
    if (s.view !== "idle") return;

    // 前置 gate：SaaS 通道未登录直接弹登录框，不发 invoke。靠后端报错再正则识别
    // 字符串本来就是反模式——登录态前端已知，应当在源头拦住。BYOK custom 路径
    // 自带凭证，跳过此 gate；token 过期但 isAuthenticated=true 的兜底由后端
    // handle_session_expired 走 auth-lost 事件触发全局拦截器。
    // 不往 store 写 error：未登录由全局 LoginDialog 接管；同时再弹 MeetingErrorDialog
    // 会叠两层 modal overlay，背景的 sidebar 登录 / 设置按钮全部被点击拦截。
    const dictationMode = useSettingsStore.getState().dictation.mode;
    if (dictationMode === "saas" && !useAuthStore.getState().isAuthenticated) {
      useUIStore.getState().openLogin();
      return;
    }

    set({
      ...initialState,
      view: "starting",
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
    let micStarted = false;
    let recordingStarted = false;

    try {
      const ok = await startAudioLevel(inputDevice);
      if (!ok) throw new Error("microphone unavailable");
      micStarted = true;
      await startRecordingToFile(meetingId);
      recordingStarted = true;
      await startMeeting({ meetingId, language });
    } catch (e: unknown) {
      // 回滚：只清掉已经成功拉起的步骤，避免对未启动的资源调 stop。
      if (recordingStarted) {
        try { await cancelRecording(); } catch { /* noop */ }
      }
      if (micStarted) {
        try { await stopAudioLevel(); } catch { /* noop */ }
      }
      // Rust 端把 vendor 错误 format 成 `<code>: <message>` 透出（含
      // meeting_provider_unsupported / engine_not_authorized / unauthenticated_byok
      // / insufficient_funds / idle_timeout / tencent_<n> 等），按这个前缀提
      // code 让 i18n 命中。原生 Error("microphone unavailable") 之类被 JS 包成
      // "Error: ..."，首字符大写不会匹配 [a-z_]，所以不会误识别。
      const raw = String(e);
      const match = raw.match(/^([a-z_][a-z0-9_]*):\s/);
      const code = match?.[1] ?? "start_failed";
      set({
        view: "idle",
        meetingId: null,
        error: { code, message: raw },
      });
      return;
    }

    const now = Date.now();
    elapsedBaseline = 0;
    set({ view: "live", meetingId, activeStartedAt: now, elapsedMs: 0 });
    startTimer(
      (partial) => set(partial),
      () => get().activeStartedAt,
    );
  },

  dismissError() {
    set({ error: null });
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
    if (stopInFlight) return;
    stopInFlight = true;
    try {
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
        reconnect: null,
      });
    } finally {
      stopInFlight = false;
    }
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
      const meta = get().recentMeetings.find((m) => m.id === meetingId);
      const map = new Map<number, MeetingSegment>();
      // 老数据 / 写入失败的 transcript_path 可能为空——空 map 也允许进 review，
      // 至少能让用户看到元数据 + 删除入口，不至于卡在 idle 看不到。
      if (meta?.transcript_path) {
        const rows = await loadMeetingSegments(meta.transcript_path);
        for (const r of rows) {
          map.set(r.sentenceId, { ...r, isFinal: true });
        }
      }
      // summary：有 path 就先把磁盘文本拉出来；没有就 null，UI 显示"生成纪要"按钮。
      let summary: string | null = null;
      let summaryStatus: "idle" | "loading" = "idle";
      if (meta?.summary_path) {
        summaryStatus = "loading";
        try {
          const md = await loadMeetingSummary(meta.summary_path);
          summary = md.length > 0 ? md : null;
        } catch (e) {
          console.warn("[meetings] load summary failed:", e);
        }
        summaryStatus = "idle";
      }
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
        summary,
        summaryStatus,
        summaryError: null,
      });
    } catch (e) {
      set({ error: { code: "history_open_failed", message: String(e) } });
    }
  },

  async generateSummary() {
    const s = get();
    const meetingId = s.reviewMeetingId;
    if (!meetingId || s.summaryStatus === "generating") return;

    // 把 store 里的 segments 渲染成 buildMeetingMarkdown 用的 plain markdown，
    // 给 LLM 做 user message body——跟导出时同款，少一种格式分支。
    const segmentsArr: MeetingSegmentJson[] = Array.from(s.segments.values())
      .filter((seg) => seg.isFinal)
      .sort((a, b) => a.startMs - b.startMs)
      .map((seg) => ({
        sentenceId: seg.sentenceId,
        speakerId: seg.speakerId,
        text: seg.text,
        startMs: seg.startMs,
        endMs: seg.endMs,
      }));
    if (segmentsArr.length === 0) {
      set({ summaryError: "empty_transcript", summaryStatus: "error" });
      return;
    }

    const aiSettings = useSettingsStore.getState().aiRefine;
    const lang = resolveLang(useSettingsStore.getState().general.interfaceLang);
    const systemPrompt = getEffectiveAiMeetingSummaryPrompt(
      aiSettings.customMeetingSummaryPrompt,
      lang,
    );

    let activeProvider:
      | { id: string; name: string; baseUrl: string; model: string }
      | null = null;
    if (aiSettings.mode === "custom") {
      activeProvider =
        aiSettings.customProviders.find(
          (p) => p.id === aiSettings.activeCustomProviderId,
        ) ?? null;
      if (!activeProvider) {
        set({ summaryError: "no_active_custom_provider", summaryStatus: "error" });
        return;
      }
    }

    // userText：speaker 标签按当前界面语言走（与 buildMeetingMarkdown 一致）。
    const speakerLabelTpl =
      lang === "zh-CN" ? "用户 {{letter}}" : lang === "zh-TW" ? "用戶 {{letter}}" : "Speaker {{letter}}";
    const speakerPending =
      lang === "zh-CN" ? "用户 …" : lang === "zh-TW" ? "用戶 …" : "Speaker …";
    const fmt = (ms: number) => {
      const total = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const sec = total % 60;
      return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
    };
    const lines: string[] = [];
    for (const seg of segmentsArr) {
      const name =
        seg.speakerId < 0
          ? speakerPending
          : speakerLabelTpl.replace("{{letter}}", String.fromCharCode(65 + (seg.speakerId % 26)));
      lines.push(`**${name}**  ·  ${fmt(seg.startMs)}`, "", seg.text.trim(), "");
    }
    const userText = lines.join("\n");

    set({ summary: "", summaryStatus: "generating", summaryError: null });
    try {
      const result = await refineTextViaChatStream(
        {
          mode: aiSettings.mode,
          systemPrompt,
          userText,
          customBaseUrl: activeProvider?.baseUrl,
          customModel: activeProvider?.model,
          customKeyringId: activeProvider ? `ai_provider_${activeProvider.id}` : undefined,
          taskId: `meeting_summary_${meetingId}`,
        },
        (chunk) => {
          set((cur) => ({ summary: (cur.summary ?? "") + chunk }));
        },
      );
      const finalText = result.refinedText.trim();
      set({ summary: finalText, summaryStatus: "idle" });
      try {
        const summaryPath = await persistMeetingSummary(meetingId, finalText);
        set((cur) => ({
          recentMeetings: cur.recentMeetings.map((m) =>
            m.id === meetingId ? { ...m, summary_path: summaryPath } : m,
          ),
        }));
      } catch (e) {
        console.warn("[meetings] persist summary failed:", e);
      }
    } catch (e) {
      console.warn("[meetings] summary generation failed:", e);
      const raw = e instanceof Error ? e.message : String(e);
      await handleAiRefineCustomFailure(e);
      set({ summaryStatus: "error", summaryError: raw });
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

// segments 派生数组的"排序"动作不能放在 zustand selector 里——
// selector 每次返回新数组会触发 React 19 的 "getSnapshot should be cached" 死循环。
// 组件应订阅 `s.segments` Map 引用，再 useMemo 派生（见 pages/Meetings/index.tsx）。
