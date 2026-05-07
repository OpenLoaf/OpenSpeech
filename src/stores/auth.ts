import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useUIStore } from "@/stores/ui";

// 与 Rust 端 PublicUser 对齐（camelCase）。
export interface AuthUser {
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  isAdmin: boolean | null;
}

export type MembershipLevel = "free" | "lite" | "pro" | "premium" | "infinity";

// Rust 端 UserProfile 的镜像。
export interface UserProfile {
  id: string;
  membershipLevel: MembershipLevel | string;
  creditsBalance: number;
  avatarUrl: string | null;
  name: string | null;
  email: string | null;
  provider: string;
}

export type LoginProvider = "google" | "wechat";
export type LoginStatus = "idle" | "opening" | "polling" | "error";

// Rust 端 LoginEvent payload（tag="status", rename_all="lowercase"）
type LoginEventPayload =
  | { status: "success"; state: string; user: AuthUser }
  | { status: "error"; state: string; message: string };

interface StartLoginResult {
  loginUrl: string;
  state: string;
}

interface AuthState {
  user: AuthUser | null;
  /** 含会员等级 / 积分的扩展 profile，登录后异步拉回。 */
  profile: UserProfile | null;
  /**
   * 实时 ASR 单价（积分/分钟）。登录后由 fetchRealtimeAsrPricing 拉一次。
   * Sidebar 用它把 creditsBalance 折算成"剩余可用分钟"。
   * 拉失败 / 未登录 → null，UI 回落到展示原始积分。
   *
   * ⚠️ 当前从 V3 capabilities 的 realtimeAsrLlm 取，假设与 V4 OL-TL-RT-002
   * 实际跑的通道单价一致。V4 通道改了计费规则就要换数据源——见
   * src-tauri/src/openloaf/mod.rs 中 openloaf_fetch_realtime_asr_pricing 的注释。
   */
  realtimeAsrCreditsPerMinute: number | null;
  isAuthenticated: boolean;
  loaded: boolean;
  /** 登录流状态：idle 空闲 | opening 正在打开浏览器 | polling 已打开等待回调 | error */
  loginStatus: LoginStatus;
  loginError: string | null;
  /** 当前进行中的登录 state（后端用来匹配 callback） */
  currentLoginState: string | null;
  /** 上次发起登录用的 provider，error 状态下重试按钮用它。 */
  lastProvider: LoginProvider | null;

  init: () => Promise<void>;
  startLogin: (provider: LoginProvider) => Promise<void>;
  /** 沿用 lastProvider 再发起一次登录；没有 lastProvider 时静默 no-op。 */
  retryLogin: () => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
  /** 主动拉一次 profile（登录事件 / 恢复会话后自动触发；其他地方也可手动用） */
  fetchProfile: () => Promise<void>;
  /** 拉一次实时 ASR 单价（积分/分钟），通常与 fetchProfile 同时触发 */
  fetchRealtimeAsrPricing: () => Promise<void>;
}

// listen 事件订阅一次（模块级），解绑函数保留以便热更新场景解绑。
// 模块加载时就 attach，确保在弹窗挂载前就能收到事件（防止 race）。
let loginEventUnlisten: UnlistenFn | null = null;
let authLostUnlisten: UnlistenFn | null = null;
let restoredUnlisten: UnlistenFn | null = null;

async function ensureLoginListener() {
  if (!loginEventUnlisten) {
    loginEventUnlisten = await listen<LoginEventPayload>(
      "openspeech://openloaf-login",
      (event) => {
        const payload = event.payload;
        const s = useAuthStore.getState();
        // 只响应当前这次登录的回调。如果 state 不匹配（比如用户连点两次），忽略旧的。
        if (s.currentLoginState !== payload.state) return;

        if (payload.status === "success") {
          useAuthStore.setState({
            user: payload.user,
            isAuthenticated: true,
            loginStatus: "idle",
            loginError: null,
            currentLoginState: null,
          });
          // 登录成功后立即把 profile 拉回（会员等级 / 积分等）。
          void useAuthStore.getState().fetchProfile();
          void useAuthStore.getState().fetchRealtimeAsrPricing();
        } else {
          useAuthStore.setState({
            loginStatus: "error",
            loginError: payload.message,
            currentLoginState: null,
          });
        }
      },
    );
  }

  // Rust 端自动 refresh 失败时广播 —— 任何 SaaS 直连链路（ai_refine / stt /
  // transcribe / feedback）走 `handle_session_expired` 都会发这条事件，前端在此
  // 一处统一切未登录态 + 弹登录框。openLogin 幂等且非主窗 no-op，重复事件 / 多
  // 窗口广播都安全；用户主动 logout 不发此事件，所以登出不会反弹登录框。
  if (!authLostUnlisten) {
    authLostUnlisten = await listen("openspeech://openloaf-auth-lost", () => {
      useAuthStore.setState({
        user: null,
        profile: null,
        isAuthenticated: false,
      });
      useUIStore.getState().openLogin();
    });
  }

  // 启动 bootstrap 用 keychain 里的 refresh_token 恢复成功后广播。
  // 前端 init() 调 openloaf_is_authenticated 的时候 bootstrap 的 refresh
  // 网络往返还没完，此事件就是用来"补一拍"的。
  if (!restoredUnlisten) {
    restoredUnlisten = await listen<AuthUser>(
      "openspeech://openloaf-restored",
      (event) => {
        useAuthStore.setState({
          user: event.payload,
          isAuthenticated: true,
          loaded: true,
        });
        void useAuthStore.getState().fetchProfile();
        void useAuthStore.getState().fetchRealtimeAsrPricing();
      },
    );
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  realtimeAsrCreditsPerMinute: null,
  isAuthenticated: false,
  loaded: false,
  loginStatus: "idle",
  loginError: null,
  currentLoginState: null,
  lastProvider: null,

  init: async () => {
    await ensureLoginListener();
    try {
      const [user, authed] = await Promise.all([
        invoke<AuthUser | null>("openloaf_current_user"),
        invoke<boolean>("openloaf_is_authenticated"),
      ]);
      set({ user, isAuthenticated: authed, loaded: true });
      // bootstrap 自动恢复成功 → 顺便把 profile + 单价拉一次。
      if (authed) {
        void get().fetchProfile();
        void get().fetchRealtimeAsrPricing();
      }
    } catch {
      set({ loaded: true });
    }

    // 网络从断到通时主动尝试恢复登录态：startup bootstrap 失败 / 之前掉过线
    // 都靠这条路径"自愈"，不用等用户重启 app 或按快捷键。
    // 已登录时 try_recover 直接返回 true 不动网络，所以无害。
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        void invoke("openloaf_try_recover").catch(() => {});
      });
    }
  },

  startLogin: async (provider) => {
    const { loginStatus } = get();
    if (loginStatus === "opening" || loginStatus === "polling") return;

    await ensureLoginListener();
    set({ loginStatus: "opening", loginError: null, lastProvider: provider });

    let result: StartLoginResult;
    try {
      result = await invoke<StartLoginResult>("openloaf_start_login", {
        provider,
      });
    } catch (e) {
      set({
        loginStatus: "error",
        loginError: typeof e === "string" ? e : String(e),
      });
      return;
    }

    set({ currentLoginState: result.state });

    try {
      await openUrl(result.loginUrl);
    } catch (e) {
      // 打开浏览器失败 → 清理 pending 并回退 idle
      await invoke("openloaf_cancel_login", {
        loginState: result.state,
      }).catch(() => {});
      set({
        loginStatus: "error",
        loginError: typeof e === "string" ? e : String(e),
        currentLoginState: null,
      });
      return;
    }

    set({ loginStatus: "polling" });
    // 后续由 listen() 里的 success/error 回调驱动状态；
    // 这里不做轮询 —— Rust 端直接 emit 结果事件，效率比轮询高。
  },

  retryLogin: async () => {
    const { lastProvider } = get();
    if (!lastProvider) return;
    await get().startLogin(lastProvider);
  },

  cancelLogin: async () => {
    const { currentLoginState } = get();
    if (currentLoginState) {
      await invoke("openloaf_cancel_login", {
        loginState: currentLoginState,
      }).catch(() => {});
    }
    set({
      loginStatus: "idle",
      loginError: null,
      currentLoginState: null,
    });
  },

  logout: async () => {
    await invoke("openloaf_logout");
    set({
      user: null,
      profile: null,
      realtimeAsrCreditsPerMinute: null,
      isAuthenticated: false,
    });
  },

  fetchProfile: async () => {
    if (!get().isAuthenticated) return;
    try {
      const profile = await invoke<UserProfile>("openloaf_fetch_profile");
      set({ profile });
    } catch {
      // 静默失败：profile 拉不到不影响登录态本身，UI 用 fallback。
    }
  },

  fetchRealtimeAsrPricing: async () => {
    if (!get().isAuthenticated) return;
    try {
      const cpm = await invoke<number>("openloaf_fetch_realtime_asr_pricing");
      // 防御：服务端返回 0 / 负数会让分钟数除爆 → 当成"未知"丢弃。
      const safe = cpm > 0 ? cpm : null;
      console.info(
        "[auth] realtime ASR pricing (V3 realtimeAsrLlm proxy):",
        cpm,
        "credits/min →",
        safe ?? "ignored",
      );
      set({ realtimeAsrCreditsPerMinute: safe });
    } catch (e) {
      // 静默失败：拉不到 sidebar 退化到展示原始积分。
      console.warn("[auth] fetchRealtimeAsrPricing failed:", e);
    }
  },
}));
