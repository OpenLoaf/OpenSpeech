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
