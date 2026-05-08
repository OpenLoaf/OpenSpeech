import React, { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { startUpdateScheduler } from "@/lib/updateScheduler";
import { attachConsole } from "@tauri-apps/plugin-log";
import { router } from "./router";
import { Toaster } from "@/components/ui/sonner";
import { LoadingScreen } from "@/components/LoadingScreen";
import OverlayPage from "@/pages/Overlay";
import QuickPanelPage from "@/pages/QuickPanel";
import { useAuthStore } from "@/stores/auth";
import { useDictionaryStore } from "@/stores/dictionary";
import { useHistoryStore } from "@/stores/history";
import { useHotkeysStore } from "@/stores/hotkeys";
import { useRecordingStore } from "@/stores/recording";
import { useSettingsStore } from "@/stores/settings";
import { useStatsStore } from "@/stores/stats";
import { useUIStore } from "@/stores/ui";
import { syncAutostart } from "@/lib/autostart";
import { auditBindings } from "@/lib/hotkey";
import { detectPlatform } from "@/lib/platform";
import { loadMachineInfo } from "@/lib/machineInfo";
import i18n, { resolveLang } from "@/i18n";
import "./i18n";
import {
  applyLang,
  listenLangChanged,
  pushTrayLabels,
  syncI18nFromSettings,
} from "@/lib/i18n-sync";
import "./App.css";

// 禁用 WebView 的默认右键菜单（"后退 / 刷新"等），桌面应用不需要浏览器级菜单。
// 如果未来某些输入框需要原生上下文菜单（如右键粘贴），在该元素上 stopPropagation。
window.addEventListener("contextmenu", (e) => e.preventDefault());

// 全局禁用 HTML5 原生拖拽：按住元素拖动会出 ghost 微缩图，桌面应用不需要这种浏览器
// 行为；窗口拖动走 Tauri 的 data-tauri-drag-region，跟 dragstart 不冲突。
// 未来真要做应用内 DnD（如文件投递）再在该元素 stopPropagation 或换 pointer 事件。
window.addEventListener("dragstart", (e) => e.preventDefault());

// 每个 WebviewWindow 独立 JS 运行时；用 label 分流主窗口 / 悬浮条 / quick panel。
const WINDOW_LABEL = getCurrentWebviewWindow().label;
const IS_OVERLAY = WINDOW_LABEL === "overlay";
const IS_QUICK_PANEL = WINDOW_LABEL === "quick-panel";
console.log(
  "[boot] window label =",
  WINDOW_LABEL,
  "isOverlay =",
  IS_OVERLAY,
  "isQuickPanel =",
  IS_QUICK_PANEL,
);

// overlay 窗口本体 transparent，需要让 html/body 也是透明背景；否则 wry/webkit 默认
// 白底会盖住 NSWindow 的透明属性。胶囊本体的 bg-te-bg 在 OverlayPage 内部容器上。
if (IS_OVERLAY) {
  document.documentElement.classList.add("overlay-window");
}
// quick panel 窗口本体也是 transparent + 自绘圆角面板，html/body 透明同 overlay。
if (IS_QUICK_PANEL) {
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
  if (IS_QUICK_PANEL) {
    // quick panel 与 overlay 一样是独立 JS runtime。需要：i18n 同步 + settings + history（编辑
    // 上一条要从 history.items[0] 读基线）。不挂录音 / 监听器 / hotkey listener，主窗各自负责。
    console.log("[boot quick-panel] init settings + history + i18n");
    try {
      await useSettingsStore.getState().init();
      await applyLang(
        resolveLang(useSettingsStore.getState().general.interfaceLang),
      );
      await useHistoryStore.getState().init();
    } catch (e) {
      console.warn("[boot quick-panel] init failed:", e);
    }
    void listenLangChanged();
    console.log("[boot quick-panel] ready");
    return;
  }

  if (IS_OVERLAY) {
    // overlay 是独立 JS runtime —— i18n 初始语言走 navigator.language，常常跟用户
    // 在主窗设置里选的 interfaceLang 不一致（导致悬浮窗显示英文 / 主窗显示中文）。
    // 拉一次 settings 把语言对齐主窗，但不 init 其他重的 store。
    // overlay 的状态机 / 监听器 / 波形数据流全部由 OverlayPage 自己（state.ts /
    // listeners.ts / Waveform.tsx）在 mount 时挂载——main.tsx 这里不再调用
    // useRecordingStore.initListeners()，避免重复订阅与时机错乱。
    console.log("[boot overlay] syncing i18n only");
    // overlay capabilities 历史上缺 store:default，init 会 reject——整段 await
    // 抛出会让 lang listener 永远注册不上。包一层兜底：哪怕 store 不可读，
    // 监听器照旧挂上，主窗一切语言广播就能立刻应用到悬浮条。
    try {
      await useSettingsStore.getState().init();
      // overlay 不调 syncI18nFromSettings——那条路会推托盘、广播给 overlay 自己，
      // 这里只切本窗 i18n + 订阅主窗后续的语言变更广播即可。
      await applyLang(
        resolveLang(useSettingsStore.getState().general.interfaceLang),
      );
    } catch (e) {
      console.warn("[boot overlay] settings init failed, falling back:", e);
    }
    void listenLangChanged();
    console.log("[boot overlay] ready");
    return;
  }

  console.log("[boot] starting store init...");
  try {
    // 应急清场：vite HMR / webview reload 时 Rust backend 进程往往没死，老的 cpal
    // Stream 还在跑、stt session 也可能没关——表现为 macOS 状态栏橙色录音指示灯
    // 卡住、按取消键不消失。boot 第一步先告诉 backend "把所有遗留状态归零"。
    // 没遗留时是 no-op；失败只打日志，不阻断 boot。
    await invoke("app_emergency_reset").catch((e) =>
      console.warn("[boot] app_emergency_reset failed:", e),
    );

    // settings 必须在 history 之前 ready：history.init 会读 historyRetention 决定
    // 启动期 sweep 删多少。其它 store 与之无依赖，并行即可。
    await useSettingsStore.getState().init();

    // 机器信息（hostname / deviceName / username）启动时拉一次缓存，给 buildSpeechSystemPrompt
    // 同步读用。失败 fallback 为空串，不阻断 boot。
    void loadMachineInfo();

    // 语言同步必须独立 try：之前与下面 hotkeys/history/dictionary init 共用一个
    // try-catch，sqlite 还没 ready 时 history/dictionary reload SELECT 抛错会把
    // syncI18nFromSettings 也带下水，i18n 留在 navigator.language（系统英文 ⇒
    // 用户哪怕在设置里选了简体中文，启动后界面仍是全英文）。
    try {
      await syncI18nFromSettings(useSettingsStore.getState().general.interfaceLang);
    } catch (e) {
      console.warn("[boot] syncI18nFromSettings failed:", e);
    }
    // 主窗也订阅一次：自己 emit 出去的事件本窗也会收到，applyLang 同语言会跳过，
    // 不会回环；额外的好处是任何第三方窗口（promo / future）也能联动。
    void listenLangChanged();

    await Promise.all([
      useHotkeysStore.getState().init(),
      useAuthStore.getState().init(),
      useHistoryStore.getState().init(),
      useDictionaryStore.getState().init(),
    ]);
    // stats 必须在 history 之后：首次启用时回扫现存 history.items 作为基线。
    await useStatsStore.getState().init();
    console.log("[boot] stores ready; bindings =", useHotkeysStore.getState().bindings);

    // 开机自启：以 settings.launchStartup 为期望值同步到 OS（macOS LaunchAgent /
    // Windows HKCU Run / Linux .desktop）。空操作的判断在 syncAutostart 内做，失败
    // 不阻断启动。dev 模式下 enable 会注册到当前 dev 二进制路径——属于已知现象，
    // 用户在 dev 环境自负盈亏。
    void syncAutostart(useSettingsStore.getState().general.launchStartup);

    // 自动更新：boot 期只挂 policy 监听器；首次 check 由 Home 页 mount 时
    // notifyHomeActivated() 触发，之后按 5 分钟轮询。命中新版后按 updatePolicy
    // 决定是 PROMPT 弹 toast 还是 AUTO 等空闲再静默安装。
    startUpdateScheduler();

    await useRecordingStore.getState().initListeners();
    console.log("[boot] recording listeners attached");

    // 主窗 focus 状态广播给 overlay：主窗在前台时悬浮条让位（用户既然在看主窗，
    // 底部小条就是冗余）；切走时按 overlay 自己的 baseVisible 规则恢复显示。
    // boot 期主窗已 focused，但 onFocusChanged 不派发初始值——靠两条路兜底：
    //   1. 立即 broadcast 一次（覆盖主窗→overlay 启动顺序的常态）
    //   2. await listen overlay-ready 握手，每次 overlay 重启 / HMR 重发当前
    //      focus（覆盖 overlay 慢启动场景，否则主窗的 broadcast 会被 overlay
    //      尚未注册的 listener 丢掉）
    {
      const mainWindow = getCurrentWebviewWindow();
      const broadcastFocus = async () => {
        try {
          const focused = await mainWindow.isFocused();
          await emitTo("overlay", "openspeech://main-focused", { focused });
          console.log("[boot] main-focused broadcast →", focused);
        } catch (e) {
          console.warn("[boot] broadcast main-focus failed:", e);
        }
      };
      void broadcastFocus();
      void mainWindow.onFocusChanged(({ payload: focused }) => {
        console.log("[boot] main onFocusChanged →", focused);
        void emitTo("overlay", "openspeech://main-focused", { focused }).catch(
          (e) => console.warn("[boot] emit main-focused failed:", e),
        );
      });
      await listen("openspeech://overlay-ready", () => {
        void broadcastFocus();
      });
    }

    // 悬浮条上的 action 按钮（"登录" / "网络设置"）反向通知主窗执行——
    // 这是录音 gate 失败后唯一会拉主程序的入口，需要用户主动点击。
    void listen<string>("openspeech://overlay-toast-action", (evt) => {
      const key = String(evt.payload ?? "");
      const ui = useUIStore.getState();
      if (key === "open_login") ui.openLogin();
      else if (key === "open_no_internet") ui.openNoInternet();
      else if (key === "open_settings_byo") ui.openSettings("GENERAL");
      else if (key === "switch_to_saas") {
        // BYOK 失败时用户点 toast 上"切到云端"——立即切到 SaaS 模式，再发一条
        // 提示让用户重新录一次。不自动重转保存的录音：focus 大概率已经丢了，
        // 重转结果只能进剪贴板，还要再弹一次 toast 提示粘贴，反而绕。让用户
        // 在原输入框直接按快捷键再说一遍是最直白的路径，OpenLoaf 云端走完整套即可。
        void useSettingsStore.getState().setDictationMode("saas").then(() => {
          void emitTo("overlay", "openspeech://overlay-toast", {
            kind: "info",
            title: i18n.t("overlay:toast.byok_switch_to_saas.switched_title"),
            description: i18n.t(
              "overlay:toast.byok_switch_to_saas.switched_description",
            ),
            durationMs: 4000,
          });
        });
      }
      else console.warn("[boot] unknown overlay-toast-action:", key);
    });

    // SaaS 转写撞 401 → 弹登录 → 用户登录回来后用刚才录音续转写并展示在 dialog。
    // recording.ts 在 finalize 末尾把 history id 写到 ui.pendingAuthRecoveryHistoryId；
    // 这里订阅 auth.isAuthenticated 从 false → true 时取出来跑 history.retry。
    // 用 prev 比较确保只对"刚刚登录成功"这一拍触发——bootstrap 自动恢复登录态时
    // 也会从 false → true，但那时 pendingAuthRecoveryHistoryId 还是 null（用户没
    // 录过音），无副作用。
    useAuthStore.subscribe(async (s, prev) => {
      if (prev.isAuthenticated || !s.isAuthenticated) return;
      const ui = useUIStore.getState();
      const pendingId = ui.pendingAuthRecoveryHistoryId;
      if (!pendingId) return;
      // 立刻清掉 pending id —— 后续 retry 期间用户若再次失败也别复用同一条；
      // 真实的 historyId 已经透传给 dialog state 自管。
      ui.setPendingAuthRecoveryHistoryId(null);
      // retry 并行开跑——不要等 LoginDialog 自闭再启动转写，否则用户登录回来要
      // 多等 0.8s 才看到 spinner。dialog 的 open 时机要等 LoginDialog 关闭后，
      // 不然两层 Radix overlay 同时挂 portal，AuthRecoveryDialog 会被 LoginDialog
      // 盖住 0.8s。LOGIN_DIALOG_AUTO_CLOSE_MS = 800（LoginDialog.tsx）。
      const retryPromise = useHistoryStore.getState().retry(pendingId);
      // 把 retry 的 reject 先 swallow 一道避免成为 unhandled rejection——下面的
      // try/await 仍会拿到错误（同一个 promise 可被多处 await，第二次 await 不会
      // 重新抛 unhandled）。
      retryPromise.catch(() => {});
      await new Promise((r) => window.setTimeout(r, 850));
      useUIStore.getState().setAuthRecoveryDialog({
        open: true,
        status: "pending",
        historyId: pendingId,
      });
      try {
        await retryPromise;
        useUIStore.getState().setAuthRecoveryDialog({
          open: true,
          status: "success",
          historyId: pendingId,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e ?? "");
        console.warn("[boot] auth recovery retry failed:", e);
        useUIStore.getState().setAuthRecoveryDialog({
          open: true,
          status: "error",
          historyId: pendingId,
          errorMessage: msg,
        });
      }
    });

    // Rust apply_bindings 注册失败按 binding 维度逐条 emit；ui store 内部聚合
    // 短窗口内的 push，最终由 HotkeyConflictDialog 一次列出全部冲突。
    void listen<{ id: string; error: string }>(
      "openspeech://hotkey/register-failed",
      (evt) => {
        console.warn("[boot] hotkey register-failed:", evt.payload);
        useUIStore.getState().pushHotkeyConflict({
          id: String(evt.payload?.id ?? ""),
          error: String(evt.payload?.error ?? ""),
        });
      },
    );

    await useRecordingStore.getState().syncBindings(
      useHotkeysStore.getState().bindings,
    );
    console.log("[boot] initial syncBindings done");

    // 启动自检：v2 → v3 migrate 后存量 binding 可能命中新规则（单 Option / 单 Fn /
    // fn-combo / 子集冲突等）。命中即推到 ui store，HotkeyConflictDialog 自动弹
    // 让用户立即重录；用户改完后 setBinding 会清掉对应条目。
    const violations = auditBindings(
      useHotkeysStore.getState().bindings,
      detectPlatform(),
      useHotkeysStore.getState().allowSpecialKeys,
    );
    if (violations.length > 0) {
      console.warn("[boot] binding audit violations:", violations);
      const ui = useUIStore.getState();
      for (const v of violations) ui.pushHotkeyConflict(v);
    }

    useHotkeysStore.subscribe((s, prev) => {
      if (s.bindings !== prev.bindings) {
        console.log("[boot] bindings changed → re-sync to Rust", s.bindings);
        void useRecordingStore.getState().syncBindings(s.bindings);
        // show_main_window 的 accelerator 显示在托盘菜单里，binding 变了要重建。
        void pushTrayLabels();
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
  const [booted, setBooted] = useState(IS_OVERLAY || IS_QUICK_PANEL);

  useEffect(() => {
    if (IS_OVERLAY || IS_QUICK_PANEL) return;
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
    if (!booted || IS_OVERLAY || IS_QUICK_PANEL) return;
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
    if (!booted || IS_OVERLAY || IS_QUICK_PANEL) return;
    void invoke("hotkey_init_listener").catch((e) =>
      console.warn("[boot] hotkey_init_listener failed:", e),
    );
  }, [booted]);

  if (IS_OVERLAY) return <OverlayPage />;
  if (IS_QUICK_PANEL) {
    return (
      <>
        <QuickPanelPage />
        <Toaster />
      </>
    );
  }

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
