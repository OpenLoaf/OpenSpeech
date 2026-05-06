import { invoke } from "@tauri-apps/api/core";

/** 拉取系统前台应用名（如 "Chrome"）。任何失败返回 null；调用方按 null 直接落 history.target_app。 */
export async function getActiveAppName(): Promise<string | null> {
  try {
    const v = await invoke<string | null>("get_active_app_name_cmd");
    if (v == null) return null;
    const trimmed = v.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch (e) {
    console.warn("[activeApp] get_active_app_name_cmd failed:", e);
    return null;
  }
}
