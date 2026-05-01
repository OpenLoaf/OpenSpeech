import { useEffect, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import i18next from "i18next";
import { useTranslation } from "react-i18next";
import {
  BookOpen,
  Coins,
  History,
  Home,
  Infinity as InfinityIcon,
  Settings,
  Timer,
  UserCircle,
} from "lucide-react";
import type { ComponentType, SVGProps } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  info as logInfo,
  error as logError,
} from "@tauri-apps/plugin-log";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import {
  checkForUpdateForChannel,
  installUpdateWithProgress,
} from "@/lib/updaterInstall";
import { showUpdateAvailableToast } from "@/components/UpdateAvailableToast";
import { AccountDialog } from "@/components/AccountDialog";
import { SettingsDialog } from "@/components/SettingsDialog";
import { CloseToBackgroundDialog } from "@/components/CloseToBackgroundDialog";
import { LoginDialog } from "@/components/LoginDialog";
import { NoInternetDialog } from "@/components/NoInternetDialog";
import { FeedbackDialog } from "@/components/FeedbackDialog";
import { WindowControls } from "@/components/WindowControls";
import { useAuthStore } from "@/stores/auth";
import { useHistoryStore } from "@/stores/history";
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
  i18nKey: string;
  icon: ComponentType<SVGProps<SVGSVGElement>>;
};

const MAIN_NAV: NavItem[] = [
  { to: "/", i18nKey: "home", icon: Home },
  { to: "/history", i18nKey: "history", icon: History },
  { to: "/dictionary", i18nKey: "dictionary", icon: BookOpen },
];

function NavRow({ item, badge = 0 }: { item: NavItem; badge?: number }) {
  const { t } = useTranslation();
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
          <span className="flex-1">{t(`pages:layout.nav.${item.i18nKey}`)}</span>
          {badge > 0 ? (
            <span className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[#ff4d4d] px-1 font-mono text-[10px] font-bold leading-none text-white tabular-nums tracking-normal">
              {badge > 99 ? "99+" : badge}
            </span>
          ) : null}
        </>
      )}
    </NavLink>
  );
}

export default function Layout() {
  const { t } = useTranslation();
  const [accountOpen, setAccountOpen] = useState<boolean>(false);
  const [closePromptOpen, setClosePromptOpen] = useState<boolean>(false);
  const navigate = useNavigate();
  // macOS 红绿灯垂直中心约在 y=14，logo slot 需顶部留空避免被覆盖。
  const isMacPlatform = detectPlatform() === "macos";
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);
  const realtimeAsrCreditsPerMinute = useAuthStore(
    (s) => s.realtimeAsrCreditsPerMinute,
  );
  // SettingsDialog / LoginDialog 的 open 状态搬到 ui store，让 recording.ts gate /
  // LoginDialog 的"使用自己的 STT 端点"按钮也能直接调用，无需 prop drilling 或 emit。
  const loginOpen = useUIStore((s) => s.loginOpen);
  const setLoginOpen = useUIStore((s) => s.setLoginOpen);
  const settingsOpen = useUIStore((s) => s.settingsOpen);
  const setSettingsOpen = useUIStore((s) => s.setSettingsOpen);
  const settingsInitialTab = useUIStore((s) => s.settingsInitialTab);
  const noInternetOpen = useUIStore((s) => s.noInternetOpen);
  const setNoInternetOpen = useUIStore((s) => s.setNoInternetOpen);
  const feedbackOpen = useUIStore((s) => s.feedbackOpen);
  const setFeedbackOpen = useUIStore((s) => s.setFeedbackOpen);
  const openFeedback = useUIStore((s) => s.openFeedback);
  const openLogin = useUIStore((s) => s.openLogin);
  const openSettings = useUIStore((s) => s.openSettings);
  const pendingUpdate = useUIStore((s) => s.pendingUpdate);
  const setPendingUpdate = useUIStore((s) => s.setPendingUpdate);

  // 从最新一条往前数连续 failed 的条数：最新条不是 failed 即为 0，气泡隐藏。
  const historyFailedHeadCount = useHistoryStore((s) => {
    let n = 0;
    for (const it of s.items) {
      if (it.status === "failed") n += 1;
      else break;
    }
    return n;
  });

  // 启动时 main.tsx 后台 check 出新版本，会把 update 对象写到 ui store。这里
  // 监听 store 弹一个常驻 toast，让用户在自己方便的时机点"立即安装"再下载——
  // 而不是 boot 期间偷偷下载阻塞 LoadingScreen。
  useEffect(() => {
    if (!pendingUpdate) return;
    const upd = pendingUpdate.update;
    const version = pendingUpdate.version;
    showUpdateAvailableToast({
      version,
      onInstall: () => {
        void (async () => {
          try {
            await installUpdateWithProgress(upd, "boot-prompt");
          } catch {
            // helper 已 toast + log，这里只负责把 pendingUpdate 清掉
          } finally {
            setPendingUpdate(null);
          }
        })();
      },
      // 写入 skippedUpdateVersion 后下次启动 check 命中同一版本静默；
      // 用户仍可通过托盘 / 关于页"检查更新"重新触发提示并安装。
      onSkip: () => {
        void (async () => {
          try {
            await useSettingsStore
              .getState()
              .setGeneral("skippedUpdateVersion", version);
            void logInfo(
              `[updater] user skipped version ${version}; will not prompt again on boot`,
            );
          } finally {
            setPendingUpdate(null);
          }
        })();
      },
    });
  }, [pendingUpdate, setPendingUpdate]);

  // 用户名 fallback 链：name → email 前缀 → "账户"。邮箱截 @ 前，避免侧栏被挤爆。
  const displayName = (() => {
    if (!isAuthenticated) return t("pages:layout.login");
    const name = user?.name?.trim();
    if (name) return name;
    const email = user?.email ?? profile?.email ?? "";
    const atIdx = email.indexOf("@");
    if (atIdx > 0) return email.slice(0, atIdx);
    return email || t("pages:layout.account_fallback");
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
    // Rust 端统一拦截主窗口关闭后 emit 事件，前端只负责 UI 决策：
    //   close-requested: 红叉 / Cmd+W → 读 closeBehavior 偏好（HIDE/QUIT/PROMPT）
    //   quit-requested:  Cmd+Q → 用户明确退出，沿用 close 行为以保持与历史版本一致
    // cancelled flag 是为了处理 React StrictMode：await listen 返回前组件可能已被
    // 卸载重挂，若不判断会注册两个 listener，导致 emit 触发两次。
    let unlistenClose: (() => void) | undefined;
    let unlistenQuit: (() => void) | undefined;
    let cancelled = false;

    const handleCloseRequest = async () => {
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
    };

    (async () => {
      const [unsubClose, unsubQuit] = await Promise.all([
        listen("openspeech://close-requested", handleCloseRequest),
        listen("openspeech://quit-requested", handleCloseRequest),
      ]);

      if (cancelled) {
        unsubClose();
        unsubQuit();
      } else {
        unlistenClose = unsubClose;
        unlistenQuit = unsubQuit;
      }
    })();

    return () => {
      cancelled = true;
      unlistenClose?.();
      unlistenQuit?.();
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
      await addSub<unknown>("openspeech://tray-open-feedback", () => {
        openFeedback();
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
        void logInfo("[updater] tray check start");
        try {
          const upd = await checkForUpdateForChannel();
          if (upd) {
            void logInfo(`[updater] tray check found: ${upd.version}`);
            showUpdateAvailableToast({
              version: upd.version,
              duration: 30_000,
              onInstall: () => {
                void installUpdateWithProgress(upd, "tray").catch(() => {
                  // helper 已处理错误 toast / log
                });
              },
            });
          } else {
            void logInfo("[updater] tray check: no update");
            toast(i18next.t("pages:layout.tray.update_none"));
          }
        } catch (e) {
          void logError(
            `[updater] tray check failed: ${String((e as Error)?.message ?? e)}`,
          );
          toast.error(i18next.t("pages:layout.tray.update_check_failed"), {
            description: String((e as Error)?.message ?? e),
          });
        }
      });
    })();

    return () => {
      cancelled = true;
      unsubs.forEach((u) => u());
    };
  }, [navigate, openSettings, openFeedback]);

  // 全局快捷键：Cmd+, (macOS) / Ctrl+, (Windows/Linux) 打开设置。
  // 设置已打开时跳过，避免覆盖当前 tab；HotkeyField 录制冲突也由此规避。
  useEffect(() => {
    const isMac = detectPlatform() === "macos";
    const onKeyDown = (e: KeyboardEvent) => {
      const modOk = isMac
        ? e.metaKey && !e.ctrlKey && !e.altKey
        : e.ctrlKey && !e.metaKey && !e.altKey;
      if (!modOk || e.shiftKey) return;
      if (e.code !== "Comma" && e.key !== ",") return;
      if (useUIStore.getState().settingsOpen) return;
      e.preventDefault();
      openSettings();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [openSettings]);

  // Ctrl+W 强制最小化到托盘：忽略 closeBehavior 偏好，直接 hide。
  // macOS Cmd+W 仍由 Window 菜单走 close-requested → 按设置走 HIDE/QUIT/PROMPT。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.code !== "KeyW" && e.key !== "w" && e.key !== "W") return;
      e.preventDefault();
      void invoke("hide_to_tray");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
  // 这里在主窗口每次回到前台时静默 check 一次，发现任一项不是 granted 就把
  // onboardingCompleted 重置为 false 并直接跳回 /onboarding（Step 1），让用户
  // 在原有的权限页里完成重新授权 + 重启流程，避免 toast 漂浮但实际无路径自救。
  useEffect(() => {
    if (detectPlatform() !== "macos") return;
    if (!useSettingsStore.getState().general.onboardingCompleted) return;

    let cancelled = false;
    let redirected = false;

    const checkAll = async () => {
      if (redirected) return;
      try {
        const [m, a, i]: PermissionStatus[] = await Promise.all([
          checkMicrophone(),
          checkAccessibility(),
          checkInputMonitoring(),
        ]);
        if (cancelled || redirected) return;
        const anyMissing =
          m !== "granted" || a !== "granted" || i !== "granted";
        if (anyMissing) {
          redirected = true;
          await useSettingsStore
            .getState()
            .setGeneral("onboardingCompleted", false);
          if (cancelled) return;
          navigate("/onboarding", { replace: true });
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
  }, [navigate]);

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
        {/* Logo slot — 顶部 drag 区，整个 logo 行可拖窗 */}
        <div
          data-tauri-drag-region
          className={cn(
            "flex items-center justify-between gap-2 border-b border-te-gray px-5",
            isMacPlatform ? "pt-10 pb-5" : "py-5",
          )}
        >
          <div className="flex items-center gap-2">
            <img
              src="/logo-write.png"
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
            <NavRow
              key={item.to}
              item={item}
              badge={item.to === "/history" ? historyFailedHeadCount : 0}
            />
          ))}
        </nav>

        {/* Time-left rail：把"剩余积分"折算成"剩余可用分钟"。
            放在 nav 与底部按钮之间，避免把账户按钮撑成双行破坏对称。
            Pro / Premium / Infinity 套餐 SaaS 调用不扣费（见 docs/subscription.md），
            直接展示 ∞ UNLIMITED，避免误导用户"分钟会扣完"。

            ⚠️ 折算依赖 V3 capabilities 的 realtimeAsrLlm.creditsPerMinute，假设
            其与 V4 OL-TL-RT-002（src-tauri/src/stt/mod.rs 实际跑的通道）同价。
            **V4 通道改了计费规则（换模型/换通道/改单价/改成按字符或分档）必须立刻
            把 fetchRealtimeAsrPricing 的数据源换掉**，否则这里的分钟数会与真实
            扣费偏离。 */}
        {isAuthenticated && profile
          ? (() => {
              const isUnlimited =
                profile.membershipLevel === "pro" ||
                profile.membershipLevel === "premium" ||
                profile.membershipLevel === "infinity";
              const hasPricing =
                !!realtimeAsrCreditsPerMinute &&
                realtimeAsrCreditsPerMinute > 0;
              // 拉到单价才显示"剩余分钟"；否则整行回退到旧的"积分"展示
              // （label / 图标 / 数字 全部回到 Credits 视觉），避免误导用户。
              const showAsTime = isUnlimited || hasPricing;
              return (
                <div className="flex items-baseline justify-between gap-2 border-t border-te-gray px-5 py-3">
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    {showAsTime
                      ? t("pages:layout.time_left")
                      : t("pages:layout.credits")}
                  </span>
                  {isUnlimited ? (
                    <span className="flex items-center gap-1 font-mono text-[10px] font-bold uppercase tracking-[0.25em] text-te-accent">
                      <InfinityIcon
                        className="size-2.5 shrink-0"
                        strokeWidth={2.5}
                      />
                      {t("pages:layout.time_unlimited")}
                    </span>
                  ) : hasPricing ? (
                    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[10px] font-bold uppercase text-te-fg tabular-nums">
                      <Timer
                        className="size-2.5 shrink-0 text-te-accent"
                        strokeWidth={2}
                      />
                      {t("pages:layout.time_minutes", {
                        minutes: Math.max(
                          0,
                          Math.floor(
                            profile.creditsBalance /
                              (realtimeAsrCreditsPerMinute as number),
                          ),
                        ).toLocaleString("en-US"),
                      })}
                    </span>
                  ) : (
                    // 单价还没拉回 / 拉失败 → 整行退回旧版 Credits 视觉。
                    <span className="flex shrink-0 items-center gap-1 whitespace-nowrap font-mono text-[10px] font-bold tracking-tighter text-te-fg tabular-nums">
                      <Coins
                        className="size-2.5 shrink-0 text-te-accent"
                        strokeWidth={2}
                      />
                      {Math.round(profile.creditsBalance).toLocaleString(
                        "en-US",
                      )}
                    </span>
                  )}
                </div>
              );
            })()
          : null}

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
            <span>{t("pages:layout.settings")}</span>
          </button>
        </div>
      </aside>

      <main className="flex h-screen flex-1 flex-col overflow-hidden bg-te-bg">
        <div
          data-tauri-drag-region
          className="flex h-8 shrink-0 items-center justify-end"
        >
          <WindowControls />
        </div>
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
      <FeedbackDialog open={feedbackOpen} onOpenChange={setFeedbackOpen} />
    </div>
  );
}
