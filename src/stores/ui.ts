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
  | "GENERAL"
  | "HOTKEYS"
  | "DICTATION"
  | "AI"
  | "ABOUT";

/** AI 提示词编辑 Dialog 的 4 种类型，对应 AI 设置页的 4 行 PromptRow。 */
export type AiPromptKind = "refine" | "translate" | "polish" | "meeting";

/** SaaS 转写中途 401 → 弹登录 → 用户登录成功后续转完展示给用户的恢复 dialog。
 *  pending：登录回来到转写返回之间；success/error：retry 完成的终态。 */
export interface AuthRecoveryDialogState {
  open: boolean;
  status: "pending" | "success" | "error";
  historyId: string | null;
  errorMessage?: string;
}

/** 统计 Dialog 打开时聚焦的指标；null 表示无侧重，默认走 duration。 */
export type StatsMetric =
  | "duration"
  | "words"
  | "wpm"
  | "saved"
  | "sessions";

export interface HotkeyConflict {
  id: string;
  error: string;
}

// boot 时多个 binding 同时注册失败会按顺序连发 register-failed 事件——这里聚合
// 一个短窗口内的 push，让 Dialog 只弹一次列出全部冲突，而不是连弹 N 次。
const HOTKEY_CONFLICT_FLUSH_MS = 200;

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
   * 反馈意见弹窗。Settings 侧边 menu / 托盘菜单 / 后续位置都通过 openFeedback 进入。
   */
  feedbackOpen: boolean;
  /**
   * 反馈关闭后要回跳的设置 tab。从设置 Dialog 进入反馈时设上，关闭反馈
   * 时自动重开设置；其它入口（托盘等）保持 null，关闭后不重开设置。
   */
  feedbackReturnToSettingsTab: SettingsTabId | null;
  /** 统计 Dialog 是否打开。 */
  statsOpen: boolean;
  /** 打开时聚焦的指标。默认 duration。 */
  statsFocusMetric: StatsMetric;
  /**
   * 启动 / 托盘 / 关于页 check 到的待安装更新。在用户点击 toast 上的"立即安装"
   * 之前，更新对象只保存在 store 里，不阻塞 boot 流程；安装由用户主动触发以
   * 避免下载途中 LoadingScreen 一直转。一次只保留一个最新发现的版本。
   */
  pendingUpdate: { version: string; update: Update } | null;
  /**
   * 当前未消费的快捷键注册冲突列表。Rust `apply_bindings` 注册失败时按 binding 维度
   * 单条 emit，前端聚合成数组让 HotkeyConflictDialog 一次列出全部。
   */
  hotkeyConflicts: HotkeyConflict[];
  /** 当前打开的 AI 提示词编辑 Dialog；null 表示未打开。
   *  打开时会被 dialog stack 自动顶到栈顶，SettingsDialog 自动隐藏。 */
  aiPromptDialog: AiPromptKind | null;
  /** SaaS 401 → 弹登录 → 登录回来后用待重转的 history id 续转写的入口。
   *  recording.ts 在 401 路径写完 history 后塞 id 进来；main.tsx 监听 auth 切换
   *  到已登录时取出来跑 history.retry。轮转完用 authRecoveryDialog 渲染结果。 */
  pendingAuthRecoveryHistoryId: string | null;
  /** 续转写过程 / 结果展示：跟 pendingAuthRecoveryHistoryId 联动；后者只是触发
   *  数据，前者承载用户能看到的整个 dialog 生命周期（pending → success/error）。 */
  authRecoveryDialog: AuthRecoveryDialogState;
  setLoginOpen: (v: boolean) => void;
  setSettingsOpen: (v: boolean) => void;
  setNoInternetOpen: (v: boolean) => void;
  setFeedbackOpen: (v: boolean) => void;
  setStatsOpen: (v: boolean) => void;
  /** 拉回主窗口 + 打开统计弹窗，可指定首屏聚焦的指标（默认 duration）。 */
  openStats: (metric?: StatsMetric) => void;
  setPendingUpdate: (v: { version: string; update: Update } | null) => void;
  /** 拉回主窗口 + 打开登录弹窗。供 recording gate / sidebar account 按钮调用。 */
  openLogin: () => void;
  /** 拉回主窗口 + 打开设置弹窗，可指定首屏 tab（如登录界面跳"自定义 STT"）。 */
  openSettings: (tab?: SettingsTabId) => void;
  /** 拉回主窗口 + 打开"无互联网连接"提示弹窗（recording gate 调用）。 */
  openNoInternet: () => void;
  /** 拉回主窗口 + 打开反馈弹窗。供托盘 / 设置左侧 menu / 其它入口调用。
   * 传 returnToSettingsTab 时自动关闭设置，反馈关闭后会回跳到该 tab。 */
  openFeedback: (opts?: { returnToSettingsTab?: SettingsTabId }) => void;
  /** 收到一条 register-failed；同 id 去重，flush 窗口内累积后由 Dialog 一次展示。 */
  pushHotkeyConflict: (c: HotkeyConflict) => void;
  /** 用户在 Binder 里改完某条 binding 时调用，乐观移除该 id 的冲突；若新 binding
   * 仍冲突，Rust 会重新 emit register-failed 把它推回来。 */
  clearHotkeyConflict: (id: string) => void;
  /** Dialog 关闭 / 跳设置后调用，清空 conflicts 让 Dialog 收起。 */
  clearHotkeyConflicts: () => void;
  /** 从 AI 设置 tab 进入提示词编辑：直接弹出 Dialog，dialog stack 自动隐藏 Settings。 */
  openAiPromptDialog: (kind: AiPromptKind) => void;
  /** 关闭提示词 Dialog；Settings 仍在栈底，会自动复现。 */
  closeAiPromptDialog: () => void;
  /** recording.ts 在 401 路径写完 history 时调一次，让 main.tsx 等登录回来用。
   *  传 null 表示清空（dialog 关闭、用户主动消费完 / 放弃恢复）。 */
  setPendingAuthRecoveryHistoryId: (id: string | null) => void;
  /** main.tsx 在 auth 翻转后内部调用——从 false → true 时切换 dialog 状态。 */
  setAuthRecoveryDialog: (next: AuthRecoveryDialogState) => void;
  /** 关闭恢复 dialog（用户复制完 / 看完结果），同时清掉 pending id 防止再次触发。 */
  closeAuthRecoveryDialog: () => void;
}

const ensureMainWindowVisible = () => {
  if (!IS_MAIN_WINDOW) return;
  invoke("show_main_window_cmd").catch((e) => {
    console.warn("[ui] show_main_window_cmd failed:", e);
  });
};

let hotkeyConflictFlushTimer: number | null = null;

export const useUIStore = create<UIStore>((set, get) => ({
  loginOpen: false,
  settingsOpen: false,
  settingsInitialTab: "GENERAL",
  noInternetOpen: false,
  feedbackOpen: false,
  feedbackReturnToSettingsTab: null,
  statsOpen: false,
  statsFocusMetric: "duration",
  pendingUpdate: null,
  hotkeyConflicts: [],
  aiPromptDialog: null,
  pendingAuthRecoveryHistoryId: null,
  authRecoveryDialog: {
    open: false,
    status: "pending",
    historyId: null,
  },

  setLoginOpen: (v) => set({ loginOpen: v }),
  setSettingsOpen: (v) => set({ settingsOpen: v }),
  setNoInternetOpen: (v) => set({ noInternetOpen: v }),
  setFeedbackOpen: (v) =>
    set((s) => {
      if (v) return { feedbackOpen: true };
      const ret = s.feedbackReturnToSettingsTab;
      if (ret) {
        return {
          feedbackOpen: false,
          feedbackReturnToSettingsTab: null,
          settingsOpen: true,
          settingsInitialTab: ret,
        };
      }
      return { feedbackOpen: false };
    }),
  setStatsOpen: (v) => set({ statsOpen: v }),
  openStats: (metric) => {
    if (get().statsOpen) return;
    ensureMainWindowVisible();
    set({ statsOpen: true, statsFocusMetric: metric ?? "duration" });
  },
  setPendingUpdate: (v) => set({ pendingUpdate: v }),

  // open* 幂等：若 dialog 已 open，直接返回，不再 ensureMainWindowVisible。
  // 背景：未登录用户按住 PTT 时，"按下任意修饰键扰动"会让 modifier-only 状态机
  // cycle 一次 release/press（pressed 集合精确匹配语义），每个 press 都重跑
  // recording gate → openLogin。如果不幂等，每次 cycle 都会 invoke
  // show_main_window_cmd → set_focus，把已经在前台但未聚焦的主窗反复抢焦点
  // （Windows 上表现为任务栏闪烁 + 主窗抢前台）。Dialog 一旦打开，重复弹没有
  // 任何收益，且抢前台等于打断用户。
  openLogin: () => {
    if (get().loginOpen) return;
    ensureMainWindowVisible();
    set({ loginOpen: true });
  },

  openSettings: (tab = "GENERAL") => {
    if (get().settingsOpen) return;
    ensureMainWindowVisible();
    set({ settingsOpen: true, settingsInitialTab: tab });
  },

  openNoInternet: () => {
    if (get().noInternetOpen) return;
    ensureMainWindowVisible();
    set({ noInternetOpen: true });
  },

  openFeedback: (opts) => {
    if (get().feedbackOpen) return;
    ensureMainWindowVisible();
    if (opts?.returnToSettingsTab) {
      set({
        settingsOpen: false,
        feedbackOpen: true,
        feedbackReturnToSettingsTab: opts.returnToSettingsTab,
      });
    } else {
      set({ feedbackOpen: true, feedbackReturnToSettingsTab: null });
    }
  },

  pushHotkeyConflict: (c) => {
    set((s) => {
      const dedup = s.hotkeyConflicts.filter((x) => x.id !== c.id);
      return { hotkeyConflicts: [...dedup, c] };
    });
    if (hotkeyConflictFlushTimer != null) return;
    hotkeyConflictFlushTimer = window.setTimeout(() => {
      hotkeyConflictFlushTimer = null;
      ensureMainWindowVisible();
    }, HOTKEY_CONFLICT_FLUSH_MS);
  },

  clearHotkeyConflict: (id) => {
    set((s) => ({
      hotkeyConflicts: s.hotkeyConflicts.filter((c) => c.id !== id),
    }));
  },

  clearHotkeyConflicts: () => {
    if (hotkeyConflictFlushTimer != null) {
      window.clearTimeout(hotkeyConflictFlushTimer);
      hotkeyConflictFlushTimer = null;
    }
    set({ hotkeyConflicts: [] });
  },

  openAiPromptDialog: (kind) => {
    // 同时把 settingsInitialTab 钉到 "AI"：prompt dialog 关闭后 SettingsDialog
    // 复现时会以这个 tab 重新挂载 SettingsContent，保证用户回到刚才那个面板。
    set({ aiPromptDialog: kind, settingsInitialTab: "AI" });
  },

  closeAiPromptDialog: () => {
    set({ aiPromptDialog: null });
  },

  setPendingAuthRecoveryHistoryId: (id) => set({ pendingAuthRecoveryHistoryId: id }),

  setAuthRecoveryDialog: (next) => set({ authRecoveryDialog: next }),

  closeAuthRecoveryDialog: () =>
    set({
      pendingAuthRecoveryHistoryId: null,
      authRecoveryDialog: { open: false, status: "pending", historyId: null },
    }),
}));
