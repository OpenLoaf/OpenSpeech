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
  /** 目标键盘注入的前台应用名（"微信"/"iTerm2"/...）。Rust 侧会过滤 OpenSpeech 自身和空名。 */
  targetApp?: string;
  /** 用户在词典页"常见领域"勾选的领域显示名（按当前界面语言）。最多 3 个。 */
  domains?: string[];
  customBaseUrl?: string;
  customModel?: string;
  customKeyringId?: string;
  taskId?: string;
}

export interface RefineChatResult {
  refinedText: string;
  taskId: string | null;
  /** Rust 侧实际发送的请求快照（URL / model / body 的 pretty JSON）；调试用，正式版可丢弃。 */
  requestEnvelope?: string | null;
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

// auth 错误判定收敛到 Rust 侧返回的稳定串：preflight / 401 retry 失败时
// transcribe / stt 用 `unauthorized` / `not authenticated`，ai_refine SaaS 路径
// 用 `saas_unauthorized:` 前缀，meetings 用 `not_authenticated`。custom 模式 401
// 是用户自己的 provider key，不会带这些前缀，由 handleAiRefineCustomFailure 处理。
const ERR_PREFIX_SAAS_AUTH = "saas_unauthorized";

export function isSaasAuthError(raw: string): boolean {
  return (
    raw === "unauthorized" ||
    raw === "not authenticated" ||
    raw === "not_authenticated" ||
    raw.startsWith(`${ERR_PREFIX_SAAS_AUTH}:`) ||
    raw.startsWith(`${ERR_PREFIX_SAAS_AUTH} `) ||
    raw.startsWith("unauthorized:") ||
    raw.startsWith("not authenticated:") ||
    raw.startsWith("not_authenticated:")
  );
}

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
