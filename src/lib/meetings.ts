// 会议会话 invoke + 事件订阅封装。
//
// Rust 端见 src-tauri/src/meetings/mod.rs。
// 凭证完全复用 dictation 通道：buildProviderRef() 给的就是会议要用的 provider。
// 当前唯一支持的 provider 是腾讯实时说话人分离（16k_zh_en_speaker）；当用户
// 听写通道选 SaaS / 阿里 / 未配置 BYOK 时，meeting_start 会返回
// `meeting_provider_unsupported` / `meeting_provider_not_configured`。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

import { buildProviderRef, type ProviderRef } from "@/lib/dictation-provider-ref";

export const EVENT_READY = "meetings://ready";
export const EVENT_PARTIAL = "meetings://segment-partial";
export const EVENT_FINAL = "meetings://segment-final";
export const EVENT_ERROR = "meetings://error";
export const EVENT_END = "meetings://ended";
export const EVENT_STATUS = "meetings://status";

export type MeetingStatus = "idle" | "active" | "paused" | "stopped";

export interface MeetingReadyPayload {
  meeting_id: string;
  session_id: string | null;
  provider: string;
}

export interface MeetingSegmentPayload {
  meeting_id: string;
  sentence_id: number;
  speaker_id: number;
  text: string;
  start_ms: number;
  end_ms: number;
}

export interface MeetingErrorPayload {
  meeting_id: string;
  code: string;
  message: string;
}

export interface MeetingStatusPayload {
  meeting_id: string;
  status: MeetingStatus;
  elapsed_ms: number;
}

export interface StartMeetingArgs {
  meetingId: string;
  language: string;
  /** 不传则按当前 dictation settings 自动构造（推荐） */
  provider?: ProviderRef;
}

export async function startMeeting(args: StartMeetingArgs): Promise<void> {
  await invoke("meeting_start", {
    args: {
      meetingId: args.meetingId,
      language: args.language,
      provider: args.provider ?? buildProviderRef(),
    },
  });
}

export async function pauseMeeting(): Promise<void> {
  await invoke("meeting_pause");
}

export async function resumeMeeting(): Promise<void> {
  await invoke("meeting_resume");
}

export async function stopMeeting(): Promise<number> {
  return await invoke<number>("meeting_stop");
}

export interface MeetingEventHandlers {
  onReady?: (p: MeetingReadyPayload) => void;
  onPartial?: (p: MeetingSegmentPayload) => void;
  onFinal?: (p: MeetingSegmentPayload) => void;
  onError?: (p: MeetingErrorPayload) => void;
  onEnded?: (meetingId: string) => void;
  onStatus?: (p: MeetingStatusPayload) => void;
}

export async function subscribeMeetingEvents(
  handlers: MeetingEventHandlers,
): Promise<UnlistenFn> {
  const offs: UnlistenFn[] = [];
  if (handlers.onReady) offs.push(await listen<MeetingReadyPayload>(EVENT_READY, (e) => handlers.onReady!(e.payload)));
  if (handlers.onPartial) offs.push(await listen<MeetingSegmentPayload>(EVENT_PARTIAL, (e) => handlers.onPartial!(e.payload)));
  if (handlers.onFinal) offs.push(await listen<MeetingSegmentPayload>(EVENT_FINAL, (e) => handlers.onFinal!(e.payload)));
  if (handlers.onError) offs.push(await listen<MeetingErrorPayload>(EVENT_ERROR, (e) => handlers.onError!(e.payload)));
  if (handlers.onEnded) offs.push(await listen<string>(EVENT_END, (e) => handlers.onEnded!(e.payload)));
  if (handlers.onStatus) offs.push(await listen<MeetingStatusPayload>(EVENT_STATUS, (e) => handlers.onStatus!(e.payload)));
  return () => {
    offs.forEach((off) => off());
  };
}
