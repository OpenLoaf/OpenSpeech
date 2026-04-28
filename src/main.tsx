import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { checkForUpdateForChannel } from "@/lib/updaterInstall";
import {
  attachConsole,
  info as logInfo,
  warn as logWarn,
} from "@tauri-apps/plugin-log";
import { router } from "./router";
import { Toaster } from "@/components/ui/sonner";
import { LoadingScreen } from "@/components/LoadingScreen";
import OverlayPage from "@/pages/Overlay";
import { useAuthStore } from "@/stores/auth";
import { useDictionaryStore } from "@/stores/dictionary";
import { useHistoryStore } from "@/stores/history";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useRecordingStore } from "@/stores/recording";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import { syncAutostart } from "@/lib/autostart";
import "./i18n";
import { syncI18nFromSettings } from "@/lib/i18n-sync";
import "./App.css";

// 禁用 WebView 的默认右键菜单（"后退 / 刷新"等），桌面应用不需要浏览器级菜单。
// 如果未来某些输入框需要原生上下文菜单（如右键粘贴），在该元素上 stopPropagation。
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 每个 WebviewWindow 独立 JS 运行时；用 label 分流主窗口 vs 悬浮条。
const WINDOW_LABEL = getCurrentWebviewWindow().label;
const IS_OVERLAY = WINDOW_LABEL === "overlay";
console.log("[boot] window label =", WINDOW_LABEL, "isOverlay =", IS_OVERLAY);

// overlay 窗口本体 transparent，需要让 html/body 也是透明背景；否则 wry/webkit 默认
// 白底会盖住 NSWindow 的透明属性。胶囊本体的 bg-te-bg 在 OverlayPage 内部容器上。
if (IS_OVERLAY) {
  document.documentElement.classList.add("overlay-window");
}

// 把 Rust 端 `log::info!/warn!/error!/debug!` 转发到 webview devtools console。
// Rust 那侧已开启 Webview target；这里再 attach 一次让前端进程接收 + 渲染。
// fire-and-forget，失败只是没日志，不影响业务。
attachConsole().catch((e) => {
  console.warn("[boot] attachConsole failed:", e);
});

// 启动路由策略：boot 完成后读 settings.onboardingCompleted，false ⇒ 跳 /onboarding。
// 用 router.navigate 而不是 replaceState：ESM import 时 createBrowserRouter 已锁定初始 location，
// 修改 history 也不会影响 router 的 state。

// top-level IIFE：仅执行一次（StrictMode 下 useEffect 会跑两次，因此启动逻辑必须放在模块作用域）。
const bootPromise = (async () => {
  if (IS_OVERLAY) {
    // overlay 是独立 JS runtime —— i18n 初始语言走 navigator.language，常常跟用户
    // 在主窗设置里选的 interfaceLang 不一致（导致悬浮窗显示英文 / 主窗显示中文）。
    // 拉一次 settings 把语言对齐主窗，但不 init 其他重的 store。
    // overlay 的状态机 / 监听器 / 波形数据流全部由 OverlayPage 自己（state.ts /
    // listeners.ts / Waveform.tsx）在 mount 时挂载——main.tsx 这里不再调用
    // useRecordingStore.initListeners()，避免重复订阅与时机错乱。
    console.log("[boot overlay] syncing i18n only");
    await useSettingsStore.getState().init();
    void syncI18nFromSettings(
      useSettingsStore.getState().general.interfaceLang,
    );
    console.log("[boot overlay] ready");
    return;
  }

  console.log("[boot] starting store init...");
  try {
    await Promise.all([
      useHotkeysStore.getState().init(),
      useSettingsStore.getState().init(),
      useAuthStore.getState().init(),
      useHistoryStore.getState().init(),
      useDictionaryStore.getState().init(),
    ]);
    console.log("[boot] stores ready; bindings =", useHotkeysStore.getState().bindings);

    // 用户偏好语言一旦从 settings 读出来就同步给 i18n + 托盘菜单；之后 settings store
    // 写 interfaceLang 时也要走同一条函数（见 settings.ts 的 setGeneral）。
    void syncI18nFromSettings(useSettingsStore.getState().general.interfaceLang);

    // 开机自启：以 settings.launchStartup 为期望值同步到 OS（macOS LaunchAgent /
    // Windows HKCU Run / Linux .desktop）。空操作的判断在 syncAutostart 内做，失败
    // 不阻断启动。dev 模式下 enable 会注册到当前 dev 二进制路径——属于已知现象，
    // 用户在 dev 环境自负盈亏。
    void syncAutostart(useSettingsStore.getState().general.launchStartup);

    // 自动更新：默认开。check() 异步触发，**不 await downloadAndInstall**——
    // 历史 bug：之前在这里 await，下载几十 MB 期间 boot 主流程被卡住，
    // LoadingScreen 永远不消失，用户表现就是"启动卡死"。改成只发现新版后写入
    // useUIStore.pendingUpdate，由 Layout 弹 toast 让用户主动点"立即安装"再
    // 走下载。整段不 await，boot 立刻继续走 listeners 注册等步骤。
    // 走 plugin-log 而不是 console.log——生产包打不开 devtools，必须把 updater
    // 的诊断信号写进 LogDir 文件（~/Library/Logs/com.openspeech.app/OpenSpeech.log）。
    if (useSettingsStore.getState().general.autoUpdate) {
      void (async () => {
        void logInfo("[updater] boot check start, autoUpdate=on");
        try {
          // 30s 而非 5s——走代理 / 跨境 CDN 时 GitHub releases 一次 TLS 握手 +
          // /latest/download/ 重定向常见 6~12s。5s 几乎必超时。
          const upd = await Promise.race([
            checkForUpdateForChannel(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error("updater check timeout")), 30_000),
            ),
          ]);
          if (upd) {
            void logInfo(
              `[updater] update available: ${upd.version}, prompting user (no auto-install)`,
            );
            useUIStore.getState().setPendingUpdate({ version: upd.version, update: upd });
          } else {
            void logInfo("[updater] no update available");
          }
        } catch (e) {
          void logWarn(`[updater] boot check skipped: ${String((e as Error)?.message ?? e)}`);
        }
      })();
    } else {
      void logInfo("[updater] boot check skipped: autoUpdate=off");
    }

    await useRecordingStore.getState().initListeners();
    console.log("[boot] recording listeners attached");

    // 悬浮条上的 action 按钮（"登录" / "网络设置"）反向通知主窗执行——
    // 这是录音 gate 失败后唯一会拉主程序的入口，需要用户主动点击。
    void listen<string>("openspeech://overlay-toast-action", (evt) => {
      const key = String(evt.payload ?? "");
      const ui = useUIStore.getState();
      if (key === "open_login") ui.openLogin();
      else if (key === "open_no_internet") ui.openNoInternet();
      else if (key === "open_settings_byo") ui.openSettings("GENERAL");
      else console.warn("[boot] unknown overlay-toast-action:", key);
    });

    await useRecordingStore.getState().syncBindings(
      useHotkeysStore.getState().bindings,
    );
    console.log("[boot] initial syncBindings done");

    useHotkeysStore.subscribe((s, prev) => {
      if (s.bindings !== prev.bindings) {
        console.log("[boot] bindings changed → re-sync to Rust", s.bindings);
        void useRecordingStore.getState().syncBindings(s.bindings);
      }
    });
    console.log("[boot] all systems go");
  } catch (e) {
    console.error("[boot] FATAL:", e);
  }
})();

// Loading 屏幕最短展示时间，保证入场动画能跑完一个完整呼吸。
const MIN_SPLASH_MS = 1200;

function Root() {
  const [booted, setBooted] = useState(IS_OVERLAY);

  useEffect(() => {
    if (IS_OVERLAY) return;
    let cancelled = false;
    const minDelay = new Promise<void>((r) => setTimeout(r, MIN_SPLASH_MS));
    Promise.all([bootPromise, minDelay]).then(() => {
      if (!cancelled) setBooted(true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // boot 完读 settings：未完成引导 ⇒ 跳 /onboarding；已完成则什么都不做（Layout/Home 正常加载）
  useEffect(() => {
    if (!booted || IS_OVERLAY) return;
    const completed = useSettingsStore.getState().general.onboardingCompleted;
    if (completed) return;
    if (router.state.location.pathname !== "/onboarding") {
      void router.navigate("/onboarding", { replace: true });
    }
  }, [booted]);

  // 主窗口完全可见 + LoadingScreen 退场后启动 rdev::listen 全局键盘订阅。
  // 不在 Rust setup 阶段启动是因为 macOS 首次访问全局键盘流会触发系统
  // 「Keystroke Receiving」授权弹框，setup 阶段立即弹会被随后 show 的主窗口
  // 遮挡。等 booted=true 后 invoke 启动——此时主窗口已 visible 并 focused，
  // 弹框正常叠在主窗口之上。
  // 幂等：Rust 端 LISTEN_STARTED AtomicBool 保证多次调用只启一次（StrictMode dev
  // 下会跑两次也无影响）。失败仅打印日志，不阻塞 UI。
  useEffect(() => {
    if (!booted || IS_OVERLAY) return;
    void invoke("hotkey_init_listener").catch((e) =>
      console.warn("[boot] hotkey_init_listener failed:", e),
    );
  }, [booted]);

  if (IS_OVERLAY) return <OverlayPage />;

  if (!booted) return <LoadingScreen />;

  return (
    <>
      <RouterProvider router={router} />
      <Toaster />
    </>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
