// 麦克风相关 invoke 封装。Rust 端见 src-tauri/src/audio/mod.rs。
//
// 引用计数：startAudioLevel / stopAudioLevel 必须成对调用；Rust 端用 ref_count
// 保证只要还有一处需要电平，stream 就不会真的停。切换设备时 Rust 会强制 restart
// 而不增减 ref_count。

import { invoke } from "@tauri-apps/api/core";

export interface InputDeviceInfo {
  name: string;
  isDefault: boolean;
}

export async function listInputDevices(): Promise<InputDeviceInfo[]> {
  try {
    // Rust 侧字段是 is_default（snake_case），serde 默认序列化保持原样，前端收到的是 is_default。
    const raw = (await invoke<{ name: string; is_default: boolean }[]>(
      "audio_list_input_devices",
    )) ?? [];
    return raw.map((d) => ({ name: d.name, isDefault: d.is_default }));
  } catch (e) {
    console.warn("[audio] list devices failed:", e);
    return [];
  }
}

export async function startAudioLevel(deviceName: string | null): Promise<void> {
  try {
    await invoke("audio_level_start", { deviceName });
  } catch (e) {
    console.warn("[audio] start failed:", e);
  }
}

export async function stopAudioLevel(): Promise<void> {
  try {
    await invoke("audio_level_stop");
  } catch (e) {
    console.warn("[audio] stop failed:", e);
  }
}

export interface RecordingResult {
  /** 相对 app_data_dir 的路径（如 "recordings/<id>.wav"）——直接写进 history.audio_path */
  audio_path: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  samples: number;
}

/**
 * 开始采集 PCM 到内存 buffer。调用前必须已经 `startAudioLevel`（stream 需要在跑）。
 * id 同时作为 history.id 与 WAV 文件名，由调用方从 `newId()` 生成后传入。
 */
export async function startRecordingToFile(id: string): Promise<void> {
  await invoke("audio_recording_start", { id });
}

/**
 * 停止采集并把 WAV 编码落盘；返回 RecordingResult。无激活 session 时抛错——
 * 调用方据此走"不写历史"分支。
 */
export async function stopRecordingAndSave(): Promise<RecordingResult> {
  return await invoke<RecordingResult>("audio_recording_stop");
}

/** 取消录音（丢弃 samples，不写文件）。用户 Esc / 误触走这条。 */
export async function cancelRecording(): Promise<void> {
  try {
    await invoke("audio_recording_cancel");
  } catch (e) {
    console.warn("[audio] cancel recording failed:", e);
  }
}

/**
 * 读取一条历史记录的 WAV 字节用于回放。Rust 端返回 `tauri::ipc::Response`，
 * 前端收到的是 `ArrayBuffer`，直接 new Blob 丢给 `<audio>` 即可，无需 base64。
 *
 * `audioPath` 必须形如 `"recordings/<id>.wav"`——Rust 侧会拒绝任何其他形式，
 * 避免变成任意文件读取漏洞。
 */
export async function loadRecordingBytes(audioPath: string): Promise<ArrayBuffer> {
  return await invoke<ArrayBuffer>("audio_recording_load", { audioPath });
}
