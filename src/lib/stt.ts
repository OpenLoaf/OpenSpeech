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

// 文件转写：把已落盘的 WAV（history.audio_path / "recordings/<id>.wav"）通过
// V4 工具接口重新转成文字。Rust 端按 duration_ms 自动分流：
//   ≤ 5 分钟 → OL-TL-003 asrShort（base64 同步）
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
