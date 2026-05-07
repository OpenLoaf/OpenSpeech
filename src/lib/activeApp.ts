import { invoke } from "@tauri-apps/api/core";

export interface ActiveWindowInfo {
  /** 前台应用名（如 "Chrome" / "WeChat"）。 */
  name: string;
  /** 窗口标题（如 "main.rs — vscode"）；空串合法（部分 app/平台无 title）。 */
  title: string;
}

/** 拉取系统前台窗口的应用名 + 标题。任何失败返回 null。 */
export async function getActiveWindowInfo(): Promise<ActiveWindowInfo | null> {
  try {
    const v = await invoke<ActiveWindowInfo | null>("get_active_window_info_cmd");
    if (v == null) return null;
    const name = (v.name ?? "").trim();
    if (name.length === 0) return null;
    return { name, title: (v.title ?? "").trim() };
  } catch (e) {
    console.warn("[activeApp] get_active_window_info_cmd failed:", e);
    return null;
  }
}
