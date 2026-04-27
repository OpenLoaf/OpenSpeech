import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import type { Update } from "@tauri-apps/plugin-updater";

// 仅主窗口持有有意义的 UI dialog 状态；overlay 也会跑到这里（recording.ts 在
// 主窗 / overlay 共享代码），但 overlay 没有渲染 LoginDialog / SettingsDialog，
// 写到 overlay 的 store 里没有副作用。openLogin / openSettings 内部 invoke
// show_main_window_cmd 仅在主窗口执行——overlay 没有这个 capability，调了也是 no-op。
const IS_MAIN_WINDOW = getCurrentWebviewWindow().label === "main";

export type SettingsTabId =
  | "ACCOUNT"
  | "GENERAL"
  | "MODEL"
  | "PERSONALIZATION"
  | "ABOUT";

interface UIStore {
  loginOpen: boolean;
  settingsOpen: boolean;
  /** SettingsDialog 打开时希望落到哪个 tab（默认 GENERAL）。 */
  settingsInitialTab: SettingsTabId;
  /**
   * "无互联网连接" 提示弹窗。recording gate 在 SAAS 路径下检测
   * `navigator.onLine === false` 时打开；用户点「重试」时重新读取
   * navigator.onLine，恢复就关弹窗，仍离线就提示一次。
   */
  noInternetOpen: boolean;
  /**
   * 启动 / 托盘 / 关于页 check 到的待安装更新。在用户点击 toast 上的"立即安装"
   * 之前，更新对象只保存在 store 里，不阻塞 boot 流程；安装由用户主动触发以
   * 避免下载途中 LoadingScreen 一直转。一次只保留一个最新发现的版本。
   */
  pendingUpdate: { version: string; update: Update } | null;
  setLoginOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setNoInternetOpen: (v: boolean) => void;
  setPendingUpdate: (v: { version: string; update: Update } | null) => void;
  /** 拉回主窗口 + 打开登录弹窗。供 recording gate / sidebar account 按钮调用。 */
  openLogin: () => void;
  /** 拉回主窗口 + 打开设置弹窗，可指定首屏 tab（如登录界面跳"自定义 STT"）。 */
  openSettings: (tab?: SettingsTabId) => void;
  /** 拉回主窗口 + 打开"无互联网连接"提示弹窗（recording gate 调用）。 */
  openNoInternet: () => void;
}

const ensureMainWindowVisible = () => {
  if (!IS_MAIN_WINDOW) return;
  invoke("show_main_window_cmd").catch((e) => {
    console.warn("[ui] show_main_window_cmd failed:", e);
  });
};

export const useUIStore = create<UIStore>((set) => ({
  loginOpen: false,
  settingsOpen: false,
  settingsInitialTab: "GENERAL",
  noInternetOpen: false,
  pendingUpdate: null,

  setLoginOpen: (v) => set({ loginOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setNoInternetOpen: (v) => set({ noInternetOpen: v }),
  setPendingUpdate: (v) => set({ pendingUpdate: v }),

  openLogin: () => {
    ensureMainWindowVisible();
    set({ loginOpen: true });
  },

  openSettings: (tab = "GENERAL") => {
    ensureMainWindowVisible();
    set({ settingsOpen: true, settingsInitialTab: tab });
  },

  openNoInternet: () => {
    ensureMainWindowVisible();
    set({ noInternetOpen: true });
  },
}));
