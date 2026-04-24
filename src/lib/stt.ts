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

export async function startSttSession(lang?: string): Promise<void> {
  await invoke("stt_start", { lang });
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
