import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

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
}

export type LoginProvider = "google" | "wechat";
export type LoginStatus = "idle" | "opening" | "polling" | "error";

// ─── 支付 ────────────────────────────────────────────────────────
export type PlanCode = "lite" | "pro" | "premium";
export type BillingPeriod = "monthly" | "yearly";

export interface PaymentOrder {
  orderId: string;
  /** 微信支付二维码 URL（weixin:// 或可被微信扫的 http URL） */
  codeUrl: string | null;
  /** 仅 upgrade 返回：补差价金额（元） */
  upgradePayable: number | null;
}

export type OrderStatus =
  | "pending"
  | "paid"
  | "refunded"
  | "closed"
  | "failed";

export interface PaymentOrderStatus {
  orderId: string;
  status: OrderStatus | string;
  type?: "subscription" | "recharge" | "upgrade" | string;
  amount?: number;
  paidAt?: string;
}

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
  isAuthenticated: boolean;
  loaded: boolean;
  /** 登录流状态：idle 空闲 | opening 正在打开浏览器 | polling 已打开等待回调 | error */
  loginStatus: LoginStatus;
  loginError: string | null;
  /** 当前进行中的登录 state（后端用来匹配 callback） */
  currentLoginState: string | null;

  init: () => Promise<void>;
  startLogin: (provider: LoginProvider) => Promise<void>;
  cancelLogin: () => Promise<void>;
  logout: () => Promise<void>;
  /** 主动拉一次 profile（登录事件 / 恢复会话后自动触发；其他地方也可手动用） */
  fetchProfile: () => Promise<void>;

  // 支付：下单。成功返回二维码 URL，调用方负责展示 QR + 轮询状态。
  paymentSubscribe: (input: {
    planCode: PlanCode;
    period: BillingPeriod;
  }) => Promise<PaymentOrder>;
  paymentRecharge: (input: { amount: number }) => Promise<PaymentOrder>;
  paymentUpgrade: (input: { newPlanCode: PlanCode }) => Promise<PaymentOrder>;
  paymentOrderStatus: (input: {
    orderId: string;
  }) => Promise<PaymentOrderStatus>;
}

// listen 事件订阅一次（模块级），解绑函数保留以便热更新场景解绑。
// 模块加载时就 attach，确保在弹窗挂载前就能收到事件（防止 race）。
let loginEventUnlisten: UnlistenFn | null = null;
let authLostUnlisten: UnlistenFn | null = null;

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

  // Rust 端自动 refresh 失败时广播 —— 把本地会话视为过期，UI 切回未登录态。
  if (!authLostUnlisten) {
    authLostUnlisten = await listen("openspeech://openloaf-auth-lost", () => {
      useAuthStore.setState({
        user: null,
        profile: null,
        isAuthenticated: false,
      });
    });
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  profile: null,
  isAuthenticated: false,
  loaded: false,
  loginStatus: "idle",
  loginError: null,
  currentLoginState: null,

  init: async () => {
    await ensureLoginListener();
    try {
      const [user, authed] = await Promise.all([
        invoke<AuthUser | null>("openloaf_current_user"),
        invoke<boolean>("openloaf_is_authenticated"),
      ]);
      set({ user, isAuthenticated: authed, loaded: true });
      // bootstrap 自动恢复成功 → 顺便把 profile 拉一次。
      if (authed) void get().fetchProfile();
    } catch {
      set({ loaded: true });
    }
  },

  startLogin: async (provider) => {
    const { loginStatus } = get();
    if (loginStatus === "opening" || loginStatus === "polling") return;

    await ensureLoginListener();
    set({ loginStatus: "opening", loginError: null });

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
    set({ user: null, profile: null, isAuthenticated: false });
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

  paymentSubscribe: async ({ planCode, period }) =>
    invoke<PaymentOrder>("openloaf_payment_subscribe", { planCode, period }),

  paymentRecharge: async ({ amount }) =>
    invoke<PaymentOrder>("openloaf_payment_recharge", { amount }),

  paymentUpgrade: async ({ newPlanCode }) =>
    invoke<PaymentOrder>("openloaf_payment_upgrade", { newPlanCode }),

  paymentOrderStatus: async ({ orderId }) =>
    invoke<PaymentOrderStatus>("openloaf_payment_order_status", { orderId }),
}));
