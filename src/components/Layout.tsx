import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { BookOpen, History, Home, Settings, UserCircle } from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { check as checkForUpdate } from "@tauri-apps/plugin-updater";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { AccountDialog } from "@/components/AccountDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CloseToBackgroundDialog } from "@/components/CloseToBackgroundDialog";
import { LoginDialog } from "@/components/LoginDialog";
import { NoInternetDialog } from "@/components/NoInternetDialog";
import { useAuthStore } from "@/stores/auth";
import { useSettingsStore } from "@/stores/settings";
import { useUIStore } from "@/stores/ui";
import {
  checkAccessibility,
  checkInputMonitoring,
  checkMicrophone,
  type PermissionStatus,
} from "@/lib/permissions";
import { detectPlatform } from "@/lib/platform";

type NavItem = {
  to: string;
  label: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const MAIN_NAV: NavItem[] = [
  { to: "/", label: "首页", icon: Home },
  { to: "/history", label: "历史记录", icon: History },
  { to: "/dictionary", label: "词典", icon: BookOpen },
];

function NavRow({ item }: { item: NavItem }) {
  const Icon = item.icon;
  return (
    <NavLink
      to={item.to}
      end={item.to === "/"}
      className={({ isActive }) =>
        cn(
          "group relative flex items-center gap-3 py-3 pr-4 pl-5 font-mono text-xs uppercase tracking-[0.2em] transition-colors",
          isActive
            ? "bg-te-surface-hover text-te-accent"
            : "text-te-light-gray hover:text-te-fg",
        )
      }
    >
      {({ isActive }) => (
        <>
          <span
            className={cn(
              "absolute top-0 left-0 h-full w-[2px] transition-colors",
              isActive ? "bg-te-accent" : "bg-transparent",
            )}
          />
          <Icon className="size-4 shrink-0" />
          <span>{item.label}</span>
        </>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const [accountOpen, setAccountOpen] = useState<boolean>(false);
  const [closePromptOpen, setClosePromptOpen] = useState<boolean>(false);
  const navigate = useNavigate();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);
  // SettingsDialog / LoginDialog 的 open 状态搬到 ui store，让 recording.ts gate /
  // LoginDialog 的"使用自己的 STT 端点"按钮也能直接调用，无需 prop drilling 或 emit。
  const loginOpen = useUIStore((s) => s.loginOpen);
  const setLoginOpen = useUIStore((s) => s.setLoginOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const settingsInitialTab = useUIStore((s) => s.settingsInitialTab);
  const noInternetOpen = useUIStore((s) => s.noInternetOpen);
  const setNoInternetOpen = useUIStore((s) => s.setNoInternetOpen);
  const openLogin = useUIStore((s) => s.openLogin);
  const openSettings = useUIStore((s) => s.openSettings);

  // 用户名 fallback 链：name → email 前缀 → "账户"。邮箱截 @ 前，避免侧栏被挤爆。
  const displayName = (() => {
    if (!isAuthenticated) return "登录";
    const name = user?.name?.trim();
    if (name) return name;
    const email = user?.email ?? profile?.email ?? "";
    const atIdx = email.indexOf("@");
    if (atIdx > 0) return email.slice(0, atIdx);
    return email || "账户";
  })();

  const avatarUrl = user?.avatarUrl ?? profile?.avatarUrl ?? null;

  // 顶部徽章：未登录恒为 FREE；登录后按 membershipLevel 切。
  const membershipLabel = ((): string => {
    if (!isAuthenticated) return "FREE";
    switch (profile?.membershipLevel) {
      case "lite":
        return "LITE";
      case "pro":
        return "PRO";
      case "premium":
        return "PREMIUM";
      case "infinity":
        return "INFINITY";
      case "free":
      default:
        return "FREE";
    }
  })();

  useEffect(() => {
    // Rust 端统一拦截主窗口关闭（Cmd+Q 经 App Menu / 红叉 / Alt+F4）后 emit 此事件，
    // 前端只负责 UI 决策：读偏好 → 直接执行 / 弹对话框。
    // cancelled flag 是为了处理 React StrictMode：await listen 返回前组件可能已被
    // 卸载重挂，若不判断会注册两个 listener，导致 emit 触发两次。
    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const unsub = await listen("openspeech://close-requested", async () => {
        // 每次读最新设置（不订阅，不把关闭路径锁到 mount 时的快照）
        const behavior = useSettingsStore.getState().general.closeBehavior;

        if (behavior === "HIDE") {
          await invoke("hide_to_tray");
          return;
        }

        if (behavior === "QUIT") {
          await invoke("exit_app");
          return;
        }

        setClosePromptOpen(true);
      });

      if (cancelled) {
        unsub();
      } else {
        unlisten = unsub;
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // 托盘右键菜单事件（Rust 侧 src-tauri/src/lib.rs 的 build_tray_menu）。
  // 约定：Rust 点完菜单后若涉及主窗口交互，已先调 show_main_window；
  // 这里只做前端 UI 决策（Dialog / 路由 / toast）。
  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    const addSub = async <P,>(
      event: string,
      cb: (payload: P) => void | Promise<void>,
    ) => {
      const unsub = await listen<P>(event, async ({ payload }) => {
        try {
          await cb(payload);
        } catch (e) {
          console.error(`[tray] ${event} handler failed:`, e);
        }
      });
      if (cancelled) unsub();
      else unsubs.push(unsub);
    };

    (async () => {
      await addSub<unknown>("openspeech://tray-open-home", () => {
        navigate("/");
      });
      await addSub<unknown>("openspeech://tray-open-settings", () => {
        openSettings();
      });
      await addSub<unknown>("openspeech://tray-open-dictionary", () => {
        navigate("/dictionary");
      });
      await addSub<string | null>(
        "openspeech://tray-select-mic",
        async (device) => {
          // payload: Some(name) ⇒ 指定设备；None ⇒ Auto-detect（回落到空串约定）。
          await useSettingsStore
            .getState()
            .setGeneral("inputDevice", device ?? "");
          await invoke("tray_refresh");
        },
      );
      await addSub<unknown>("openspeech://tray-check-update", async () => {
        try {
          const upd = await checkForUpdate();
          if (upd) {
            toast.message("发现新版本", { description: upd.version });
          } else {
            toast("当前已是最新版本");
          }
        } catch (e) {
          // updater endpoints 未配置 / 网络失败都会走这里；给用户一个 toast 即可。
          toast.error("检查更新失败", {
            description: String((e as Error)?.message ?? e),
          });
        }
      });
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [navigate, openSettings]);

  // 设置页等处改 inputDevice 后通知 Rust 重建托盘菜单，让"选择麦克风"的 ✓
  // 跟随最新选择。空依赖 + subscribe 自带首次调用豁免（prev === next）。
  useEffect(() => {
    let prev = useSettingsStore.getState().general.inputDevice;
    const unsub = useSettingsStore.subscribe((s) => {
      if (s.general.inputDevice !== prev) {
        prev = s.general.inputDevice;
        void invoke("tray_refresh");
      }
    });
    return unsub;
  }, []);

  // 运行时撤权检测（macOS / 已完成 onboarding）：用户在系统设置撤销了某项授权
  // 后，已运行的进程内部 AVCaptureDevice / AXIsProcessTrusted / IOHIDCheckAccess
  // 都仍读到旧值（per-process 缓存），所以无法实时感知。但 macOS 撤权后会自动
  // 触发整个 App 重启——重启后 onboarding 已完成，前端不再走 StepPermissions。
  // 这里在主窗口每次回到前台时静默 check 一次，发现"曾经 granted 的项现在不是
  // granted"就 toast 提示用户去重新授权（参考 AltTab 的运行时轮询范式）。
  // 不主动 reset/重启，因为 macOS 限制下唯一干净路径是用户去系统设置勾选 + 再
  // 重启 App。提示完后用户自己决定。
  useEffect(() => {
    if (detectPlatform() !== "macos") return;
    if (!useSettingsStore.getState().general.onboardingCompleted) return;

    let cancelled = false;
    const lastSeenGranted: Record<string, boolean> = {
      microphone: true,
      accessibility: true,
      "input-monitoring": true,
    };

    const checkAll = async () => {
      try {
        const [m, a, i]: PermissionStatus[] = await Promise.all([
          checkMicrophone(),
          checkAccessibility(),
          checkInputMonitoring(),
        ]);
        if (cancelled) return;
        // 仅当此前观察到 granted、现在不是 granted 时才 toast——避免首次启动
        // 还没授权时也跳出来提示。
        const transitions: Array<[string, PermissionStatus, string]> = [
          ["microphone", m, "麦克风"],
          ["accessibility", a, "辅助功能"],
          ["input-monitoring", i, "输入监控"],
        ];
        for (const [kind, status, label] of transitions) {
          const wasGranted = lastSeenGranted[kind];
          const nowGranted = status === "granted";
          if (wasGranted && !nowGranted) {
            toast.error(`${label}权限已撤销`, {
              description: "请在系统设置重新授权后重启 OpenSpeech。",
              duration: 8000,
            });
          }
          lastSeenGranted[kind] = nowGranted;
        }
      } catch (e) {
        console.warn("[layout] runtime permission check failed:", e);
      }
    };

    // 挂载时跑一次（建立 baseline），然后窗口 focus 回到前台时再检测。
    void checkAll();
    const onFocus = () => void checkAll();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  const handleCloseConfirm = async ({
    remember,
    action,
  }: {
    remember: boolean;
    action: "hide" | "quit";
  }) => {
    setClosePromptOpen(false);

    // 勾选"不再提醒"时同步写入 settings.closeBehavior：
    //   action="hide" + remember → HIDE（等同于打开"关闭时最小化到托盘"开关）
    //   action="quit" + remember → QUIT（关闭即退出，设置页面开关显示为 off，再开一次可回到 HIDE）
    if (remember) {
      await useSettingsStore
        .getState()
        .setGeneral("closeBehavior", action === "hide" ? "HIDE" : "QUIT");
    }

    if (action === "hide") {
      await invoke("hide_to_tray");
    } else {
      await invoke("exit_app");
    }
  };

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-te-bg text-te-fg">
      <aside className="flex h-screen w-60 shrink-0 flex-col overflow-hidden border-r border-te-gray bg-te-surface">
        {/* 预留顶部 drag 区给 macOS 红绿灯（Overlay 模式会浮在此区左上角） */}
        <div data-tauri-drag-region className="h-8 shrink-0" />

        {/* Logo slot */}
        <div className="flex items-center justify-between gap-2 border-b border-te-gray px-5 py-5">
          <div className="flex items-center gap-2">
            <img
              src="/logo-black.png"
              alt=""
              aria-hidden
              className="size-5 shrink-0 select-none"
              draggable={false}
            />
            <span className="font-mono text-sm font-bold tracking-[0.2em]">
              <span className="text-te-fg">OPEN</span>
              <span className="text-te-accent">SPEECH</span>
            </span>
          </div>
          <span
            className={cn(
              "border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.15em]",
              isAuthenticated && profile?.membershipLevel && profile.membershipLevel !== "free"
                ? "border-te-accent/60 text-te-accent"
                : "border-te-gray/60 text-te-light-gray",
            )}
          >
            {membershipLabel}
          </span>
        </div>

        {/* Main nav */}
        <nav className="flex flex-1 flex-col gap-px overflow-y-auto py-4">
          {MAIN_NAV.map((item) => (
            <NavRow key={item.to} item={item} />
          ))}
        </nav>

        {/* Credits rail：账号积分仪表，仅登录 + profile 拉回后渲染。
            放在 nav 与底部按钮之间，避免把账户按钮撑成双行破坏对称。
            Pro 及以上套餐 SaaS 调用无限（见 docs/subscription.md），积分数不再是瓶颈，
            这里换成 UNLIMITED 标记，避免误导用户"积分会减少"。 */}
        {isAuthenticated && profile ? (
          <div className="flex items-baseline justify-between gap-2 border-t border-te-gray px-5 py-3">
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
              Credits
            </span>
            {profile.membershipLevel === "pro" ||
            profile.membershipLevel === "premium" ? (
              <span className="font-mono text-xs font-bold uppercase tracking-[0.25em] text-te-accent">
                UNLIMITED
              </span>
            ) : (
              <span className="font-mono text-base font-bold tracking-tighter text-te-fg tabular-nums">
                {Math.round(profile.creditsBalance).toLocaleString("zh-CN")}
              </span>
            )}
          </div>
        ) : null}

        {/* Bottom actions: 账户 / 设置 */}
        <div className="flex items-center justify-around border-t border-te-gray px-2 py-2">
          <button
            type="button"
            onClick={() => {
              // 未登录：直接打开登录弹窗；已登录：打开账户弹窗。
              if (isAuthenticated) setAccountOpen(true);
              else openLogin();
            }}
            className="flex min-w-0 items-center gap-2 px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
          >
            {/* 头像占位：avatar URL 有则显示；缺图/未登录 fallback 到 UserCircle。 */}
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt=""
                referrerPolicy="no-referrer"
                className="size-4 shrink-0 rounded-full object-cover ring-1 ring-te-gray/60"
              />
            ) : (
              <UserCircle className="size-4 shrink-0" />
            )}
            <span className="truncate normal-case tracking-normal">
              {displayName}
            </span>
          </button>
          <button
            type="button"
            onClick={() => openSettings()}
            className="flex items-center gap-2 px-3 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
          >
            <Settings className="size-4" />
            <span>设置</span>
          </button>
        </div>
      </aside>

      <main className="flex h-screen flex-1 flex-col overflow-hidden bg-te-bg">
        {/* 顶部不再预留 32px drag 条——内容从 y=0 开始；拖窗从左侧 sidebar 顶部 drag 区进行 */}
        {/* Outlet 容器不接管滚动，由每个 page 自行声明 h-full overflow-y-auto（或 overflow-hidden，如 Home） */}
        <div className="min-h-0 flex-1 overflow-hidden">
          <Outlet />
        </div>
      </main>

      {/* Dialogs */}
      <AccountDialog open={accountOpen} onOpenChange={setAccountOpen} />
      <LoginDialog open={loginOpen} onOpenChange={setLoginOpen} />
      <SettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialTab={settingsInitialTab}
      />
      <CloseToBackgroundDialog
        open={closePromptOpen}
        onOpenChange={setClosePromptOpen}
        onConfirm={handleCloseConfirm}
      />
      <NoInternetDialog open={noInternetOpen} onOpenChange={setNoInternetOpen} />
    </div>
  );
}
