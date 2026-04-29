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

// Rust 端 audio_level_start 现在同步等到 cpal stream 真正起来才返回（写入
// stream_info 之后才 send Ok），失败/超时（默认 1.5s 上限）会抛错。调用方据此
// 决定要不要继续走 stt_start，避免冷启动时撞 "audio stream not running"。
export async function startAudioLevel(deviceName: string | null): Promise<boolean> {
  try {
    await invoke("audio_level_start", { deviceName });
    return true;
  } catch (e) {
    console.warn("[audio] start failed:", e);
    return false;
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
  /** 相对 app_data_dir 的路径（如 "recordings/<id>.ogg"）——直接写进 history.audio_path */
  audio_path: string;
  duration_ms: number;
  sample_rate: number;
  channels: number;
  samples: number;
}

/**
 * 开始采集 PCM 到内存 buffer。调用前必须已经 `startAudioLevel`（stream 需要在跑）。
 * id 同时作为 history.id 与录音文件名，由调用方从 `newId()` 生成后传入。
 */
export async function startRecordingToFile(id: string): Promise<void> {
  await invoke("audio_recording_start", { id });
}

/**
 * 停止采集并把 OGG Vorbis 编码落盘；返回 RecordingResult。无激活 session 时抛错——
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
 * 读取一条历史记录的录音字节用于回放。Rust 端返回 `tauri::ipc::Response`，
 * 前端收到的是 `ArrayBuffer`，直接 new Blob 丢给 `<audio>` 即可，无需 base64。
 *
 * `audioPath` 必须形如 `"recordings/<id>.ogg"`（新版）或 `"recordings/<id>.wav"`
 * （迁移前老记录）——Rust 侧只接受这两种后缀，避免变成任意文件读取漏洞。
 */
export async function loadRecordingBytes(audioPath: string): Promise<ArrayBuffer> {
  return await invoke<ArrayBuffer>("audio_recording_load", { audioPath });
}

/**
 * 把一条历史录音另存为到用户选的位置。`destPath` 是绝对路径——通常来自
 * `@tauri-apps/plugin-dialog` 的 `save()`，由系统 Save 对话框得到。
 * Rust 侧只校验 src 形如 `"recordings/<id>.{ogg,wav}"`，dest 交给 OS 处理。
 */
export async function exportRecordingTo(
  audioPath: string,
  destPath: string,
): Promise<void> {
  await invoke("audio_recording_export", { audioPath, destPath });
}

/**
 * 删除一条历史录音的物理文件（不动 DB 行）。文件不存在视为成功。
 * 调用方负责自己处理 history 表里的 audio_path 字段。
 */
export async function deleteRecordingFile(audioPath: string): Promise<void> {
  await invoke("audio_recording_delete", { audioPath });
}
