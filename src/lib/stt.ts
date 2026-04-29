// OpenLoaf SaaS realtime ASR 前端 invoke 封装。Rust 端见 src-tauri/src/stt/mod.rs。
//
// 调用时机（与 recording store 的状态机对齐）：
// - preparing → recording：在 `startRecordingToFile` 之后调 `startSttSession`，
//   建立 WebSocket；之后 cpal 回调会自动把 PCM16 喂给 Rust 侧的 worker。
// - 正常释放（>= 300ms）：调 `finalizeSttSession` 等 Final 返回文字。
// - Esc / < 300ms 误触 / 错误：调 `cancelSttSession` 丢弃会话。
//
// 事件监听（在 recording store 的 initListeners 里已接入）：
//   "openspeech://asr-partial"  payload: string  — 实时 partial text
//   "openspeech://asr-final"    payload: string  — 最终文字（也作为 finalize 的返回值）
//   "openspeech://asr-error"    payload: { code, message }
//   "openspeech://asr-closed"   payload: { reason, totalCredits }
//   "openspeech://asr-credits"  payload: number — 余额变化

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

// V4 OL-TL-RT-002 的 vadMode 透传：
//   "auto"   → ServerVad（服务端按停顿切句，多段 Final）
//   "manual" → None（整段一句话，松手才出 Final）
export type SttMode = "auto" | "manual";

export async function startSttSession(
  options: { lang?: string; mode?: SttMode } = {},
): Promise<void> {
  await invoke("stt_start", { lang: options.lang, mode: options.mode });
}

export async function finalizeSttSession(): Promise<string> {
  return await invoke<string>("stt_finalize");
}

export async function cancelSttSession(): Promise<void> {
  try {
    await invoke("stt_cancel");
  } catch (e) {
    console.warn("[stt] cancel failed:", e);
  }
}

// 文件转写：把已落盘的录音（history.audio_path，新版 .ogg / 兼容老 .wav）通过
// V4 工具接口重新转成文字。Rust 端按 duration_ms 自动分流：
//   ≤ 5 分钟 → OL-TL-003 asrShort（base64 同步，按后缀传 audio/ogg 或 audio/wav）
//   > 5 分钟 → 暂不支持（OL-TL-004 需要公网 URL，本地录音没法直传）
export interface TranscribeFileResult {
  text: string;
  variant: "asrShort" | "asrLong";
  creditsConsumed: number;
}

export async function transcribeRecordingFile(args: {
  audioPath: string;
  durationMs: number;
  lang?: string;
}): Promise<TranscribeFileResult> {
  return await invoke<TranscribeFileResult>("transcribe_recording_file", {
    audioPath: args.audioPath,
    durationMs: args.durationMs,
    lang: args.lang,
  });
}

// 长音频公网 URL 转写。本地录音重试不会走这里——保留给后续"上传后转写"等场景。
export async function transcribeLongAudioUrl(args: {
  url: string;
  lang?: string;
}): Promise<TranscribeFileResult> {
  return await invoke<TranscribeFileResult>("transcribe_long_audio_url", {
    url: args.url,
    lang: args.lang,
  });
}

// OL-TL-005 / speechRefine：把 ASR transcript 整理成书面化文本（去口头禅、消重、
// 自我修正识别、按顺序列表化）。**同语言不翻译**。失败 / 短文本 / 超时由 SDK 回退
// 为输入原文，UI 拿到的 refinedText 永远可用。
//
// 热词缓存（v0.3.6+）：调用方可同时传 hotwords + hotwordsCacheId——后端优先用
// cacheId 命中 Redis；服务端 410 HOTWORDS_CACHE_MISS 时自动降级回明文 hotwords
// 重发并刷新缓存，所以前端拿到的 hotwordsCacheId 永远是"当前可用的"。
export interface RefineSpeechTextResult {
  refinedText: string;
  creditsConsumed: number;
  durationMs: number;
  warning: string | null;
  hotwordsCacheId: string | null;
}

export async function refineSpeechText(args: {
  text: string;
  hotwords?: string;
  hotwordsCacheId?: string;
}): Promise<RefineSpeechTextResult> {
  return await invoke<RefineSpeechTextResult>("refine_speech_text", {
    text: args.text,
    hotwords: args.hotwords,
    hotwordsCacheId: args.hotwordsCacheId,
  });
}

/**
 * 流式版 OL-TL-005：每个 Delta 通过 onDelta 回调即时推上来，命令 await 完成时
 * 拿到的 result 就是整段 refinedText + 元数据（与非流式一致）。
 *
 * 调用方负责：(1) 用 onDelta 把字逐个注入到光标 / UI；(2) 命令成功后把
 * result.refinedText 整段写回剪贴板，覆盖 deltas 期间最后一段写下的剪贴板。
 *
 * 失败时（auth、网络、stream Error 帧）抛错；调用方退化为非流式或仅展示原文。
 */
export async function refineSpeechTextStream(
  args: {
    text: string;
    hotwords?: string;
    hotwordsCacheId?: string;
  },
  onDelta: (chunk: string) => void,
): Promise<RefineSpeechTextResult> {
  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<string>("openspeech://refine-delta", (evt) => {
      const chunk = String(evt.payload ?? "");
      if (chunk) onDelta(chunk);
    });
    return await invoke<RefineSpeechTextResult>("refine_speech_text_stream", {
      text: args.text,
      hotwords: args.hotwords,
      hotwordsCacheId: args.hotwordsCacheId,
    });
  } finally {
    if (unlisten) unlisten();
  }
}
