import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
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
import { syncAutostart } from "@/lib/autostart";
import "./App.css";

// 禁用 WebView 的默认右键菜单（"后退 / 刷新"等），桌面应用不需要浏览器级菜单。
// 如果未来某些输入框需要原生上下文菜单（如右键粘贴），在该元素上 stopPropagation。
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 每个 WebviewWindow 独立 JS 运行时；用 label 分流主窗口 vs 悬浮条。
const WINDOW_LABEL = getCurrentWebviewWindow().label;
const IS_OVERLAY = WINDOW_LABEL === "overlay";
console.log("[boot] window label =", WINDOW_LABEL, "isOverlay =", IS_OVERLAY);

// 启动路由策略：boot 完成后读 settings.onboardingCompleted，false ⇒ 跳 /onboarding。
// 用 router.navigate 而不是 replaceState：ESM import 时 createBrowserRouter 已锁定初始 location，
// 修改 history 也不会影响 router 的 state。

// top-level IIFE：仅执行一次（StrictMode 下 useEffect 会跑两次，因此启动逻辑必须放在模块作用域）。
const bootPromise = (async () => {
  if (IS_OVERLAY) {
    // overlay 只需要监听 hotkey 事件以驱动自身 FSM；不管理 bindings / settings / auth。
    console.log("[boot overlay] attaching listeners only");
    await useRecordingStore.getState().initListeners();
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

    // 开机自启：以 settings.launchStartup 为期望值同步到 OS（macOS LaunchAgent /
    // Windows HKCU Run / Linux .desktop）。空操作的判断在 syncAutostart 内做，失败
    // 不阻断启动。dev 模式下 enable 会注册到当前 dev 二进制路径——属于已知现象，
    // 用户在 dev 环境自负盈亏。
    void syncAutostart(useSettingsStore.getState().general.launchStartup);

    // 自动更新：默认开。check() 带 5s 超时；有更新则 downloadAndInstall 触发
    // 原地替换 + relaunch，用户感知 ≈ 启动时多一段"升级中"。失败静默——不打扰
    // 启动流程。未配置 endpoints / pubkey / 网络不通都会落到 catch。
    if (useSettingsStore.getState().general.autoUpdate) {
      try {
        const upd = await Promise.race([
          checkForUpdate(),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error("updater check timeout")), 5000),
          ),
        ]);
        if (upd) {
          console.log("[boot] update available:", upd.version, "→ installing");
          // downloadAndInstall 在 macOS/Linux 会 relaunch（当前进程被替换），
          // 在 Windows 会调起 NSIS installer 并退出当前进程。这之后的代码可能
          // 永远不执行——但如果它真的返回了（某些平台快速安装），也不做任何事，
          // 让 LoadingScreen 继续到结束。
          await upd.downloadAndInstall();
        } else {
          console.log("[boot] no update available");
        }
      } catch (e) {
        console.warn("[boot] auto-update skipped:", e);
      }
    }

    await useRecordingStore.getState().initListeners();
    console.log("[boot] recording listeners attached");

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
