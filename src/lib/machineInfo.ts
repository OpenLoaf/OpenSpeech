// 启动时一次性 invoke get_platform_info 拿到 hostname / deviceName / username，缓存供
// buildSpeechSystemPrompt 同步读取。这些字段几乎不变，没必要每次录音都 invoke 往返。
//
// 失败兜底：cache 留默认空串，所有字段降级为不输出（buildSpeechSystemPrompt 会过滤空值）。

import { invoke } from "@tauri-apps/api/core";

export interface MachineInfo {
  /** Rust std::env::consts::OS：macos / windows / linux */
  os: string;
  /** Rust std::env::consts::ARCH：aarch64 / x86_64 等 */
  arch: string;
  /** OS hostname，如 "Zhaos-MacBook-Pro.local" */
  hostname: string;
  /** 友好设备名，如 "Zhao 的 MacBook Pro"；macOS / Windows 通常 ≠ hostname */
  deviceName: string;
  /** 当前 OS 用户名 */
  username: string;
}

const EMPTY: MachineInfo = {
  os: "",
  arch: "",
  hostname: "",
  deviceName: "",
  username: "",
};

let cached: MachineInfo = EMPTY;

interface RawPlatformInfo {
  os?: string;
  arch?: string;
  family?: string;
  hostname?: string;
  deviceName?: string;
  username?: string;
}

export async function loadMachineInfo(): Promise<void> {
  try {
    const raw = await invoke<RawPlatformInfo>("get_platform_info");
    cached = {
      os: raw.os ?? "",
      arch: raw.arch ?? "",
      hostname: raw.hostname ?? "",
      deviceName: raw.deviceName ?? "",
      username: raw.username ?? "",
    };
  } catch (e) {
    console.warn("[machineInfo] load failed:", e);
    cached = EMPTY;
  }
}

export function getMachineInfoCached(): MachineInfo {
  return cached;
}
