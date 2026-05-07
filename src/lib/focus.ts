import { invoke } from "@tauri-apps/api/core";
import { info as logInfo, warn as logWarn } from "@tauri-apps/plugin-log";

/** 系统级 focused UI 元素是否文本输入区域。
 *  - true：明确可编辑（macOS：role 命中 AXTextField/AXTextArea/...）
 *  - false：明确不可编辑（focus 在桌面 / Finder / 只读 web 区域 / 菜单栏）
 *  - null：拿不到结论（macOS AX 权限缺失 / Win / Linux），调用方按可注入处理 */
export async function isFocusEditable(): Promise<boolean | null> {
  const t0 = performance.now();
  try {
    const v = await invoke<boolean | null>("focus_is_editable_cmd");
    const dt = Math.round(performance.now() - t0);
    void logInfo(`[focus] isFocusEditable → ${v} (${dt}ms)`);
    return v ?? null;
  } catch (e) {
    void logWarn(`[focus] focus_is_editable_cmd failed: ${String(e)}`);
    return null;
  }
}
