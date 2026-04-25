import {
  enable as enableAutostart,
  disable as disableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";

// 把 settings.launchStartup 期望状态对齐到操作系统：
//   macOS  → ~/Library/LaunchAgents/<bundleId>.plist（LaunchAgent，插件默认模式）
//   Windows → HKCU\...\Run 注册表项
//   Linux  → ~/.config/autostart/<id>.desktop
// 仅在期望与实际不一致时才写，避免每次启动都触碰系统注册项。
// 失败只记日志：开机自启不是关键路径，不能阻断启动 / 设置切换。
export async function syncAutostart(desired: boolean): Promise<void> {
  try {
    const actual = await isAutostartEnabled();
    if (actual === desired) return;
    if (desired) await enableAutostart();
    else await disableAutostart();
    console.log("[autostart] synced →", desired);
  } catch (e) {
    console.warn("[autostart] sync failed:", e);
  }
}
