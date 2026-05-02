// AI 文本改写：前端按 settings.aiRefine.mode 选 saas / custom。
// 详见 docs/ai-refine.md。

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AiRefineMode = "saas" | "custom";

export interface RefineChatInput {
  mode: AiRefineMode;
  systemPrompt: string;
  userText: string;
  hotwords?: string[];
  historyEntries?: string[];
  requestTime?: string;
  customBaseUrl?: string;
  customModel?: string;
  customKeyringId?: string;
  taskId?: string;
}

export interface RefineChatResult {
  refinedText: string;
  taskId: string | null;
}

interface DeltaPayload {
  taskId: string | null;
  chunk: string;
}

interface DonePayload {
  taskId: string | null;
  refinedText: string;
}

interface ErrorPayload {
  taskId: string | null;
  code: string;
  message: string;
}

const EVENT_DELTA = "openspeech://ai-refine:delta";
const EVENT_DONE = "openspeech://ai-refine:done";
const EVENT_ERROR = "openspeech://ai-refine:error";

export async function refineTextViaChatStream(
  input: RefineChatInput,
  onDelta: (chunk: string) => void,
): Promise<RefineChatResult> {
  const taskId = input.taskId ?? null;
  const matchTask = (incoming: string | null) =>
    taskId === null || incoming === null || incoming === taskId;

  const unsubs: UnlistenFn[] = [];
  try {
    unsubs.push(
      await listen<DeltaPayload>(EVENT_DELTA, (evt) => {
        if (!matchTask(evt.payload.taskId)) return;
        const chunk = String(evt.payload.chunk ?? "");
        if (chunk) onDelta(chunk);
      }),
    );
    return await invoke<RefineChatResult>("refine_text_via_chat_stream", {
      input,
    });
  } finally {
    unsubs.forEach((u) => {
      try {
        u();
      } catch {}
    });
  }
}

export async function listenAiRefineDone(
  cb: (payload: DonePayload) => void,
): Promise<UnlistenFn> {
  return await listen<DonePayload>(EVENT_DONE, (evt) => cb(evt.payload));
}

export async function listenAiRefineError(
  cb: (payload: ErrorPayload) => void,
): Promise<UnlistenFn> {
  return await listen<ErrorPayload>(EVENT_ERROR, (evt) => cb(evt.payload));
}
