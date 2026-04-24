import { useEffect, useState } from "react";
import { Gift, LogOut, Mail, Sparkles } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAuthStore } from "@/stores/auth";

/** 根据 membershipLevel 返回显示标签（UI 用）。 */
function membershipLabel(level: string | undefined): string {
  switch (level) {
    case "lite":
      return "LITE / 轻享";
    case "pro":
      return "PRO / 专业";
    case "premium":
      return "PREMIUM / 旗舰";
    case "free":
    default:
      return "FREE / 免费";
  }
}

/** Pro 及以上：SaaS 调用无限，不扣积分。见 docs/subscription.md。 */
function isUnlimited(level: string | undefined): boolean {
  return level === "pro" || level === "premium";
}

/** 通用：打开 OpenLoaf Web 页面（订阅 / 充值） */
async function openWebPage(path: string) {
  const url = await invoke<string>("openloaf_web_url", { path });
  await openUrl(url);
}

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-te-gray/30 py-3 last:border-b-0">
      <span className="font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
        {label}
      </span>
      <div className="min-w-0 shrink-0 text-right">{children}</div>
    </div>
  );
}

export function AccountDialog({ open, onOpenChange }: Props) {
  const { user, profile, isAuthenticated, init, loaded, logout } = useAuthStore();
  const [loggingOut, setLoggingOut] = useState(false);
  const level = profile?.membershipLevel;
  const unlimited = isUnlimited(level);
  // 文案按等级切：free/lite → "订阅 / 升级"；pro → "升级到 PREMIUM"；premium → "管理订阅"。
  const subscribeButtonLabel =
    level === "premium"
      ? "管理订阅"
      : level === "pro"
        ? "升级到 PREMIUM"
        : "订阅 / 升级套餐";

  // 首次打开面板时确保 store 已初始化（Rust 端 bootstrap 是异步的，
  // 这里再主动读一次最新状态）。
  useEffect(() => {
    if (open) {
      void init();
    }
  }, [open, init]);

  // 这里假设调用方（Layout）只在 isAuthenticated=true 时打开本对话框；
  // 万一被错误打开（比如 logout 正好在打开瞬间发生），把自己关掉即可。
  useEffect(() => {
    if (open && loaded && !isAuthenticated) {
      onOpenChange(false);
    }
  }, [open, loaded, isAuthenticated, onOpenChange]);

  const handleLogout = async () => {
    if (loggingOut) return;
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  };

  const emailDisplay = user?.email ?? user?.name ?? "—";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[70vh] w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0">
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            账户
          </DialogTitle>
          <DialogDescription className="sr-only">
            OpenSpeech 账户与订阅
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {!loaded ? (
            <div className="py-10 text-center font-mono text-xs uppercase tracking-[0.25em] text-te-light-gray">
              // 正在加载 //
            </div>
          ) : (
            <>
              {/* Identity */}
              <div className="mb-5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-px w-4 bg-te-accent" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    身份
                  </span>
                </div>
                <Row label="电子邮件">
                  <span className="inline-flex items-center gap-2 font-mono text-sm text-te-fg">
                    <Mail className="size-3.5 text-te-light-gray" />
                    {emailDisplay}
                  </span>
                </Row>
                <Row label="订阅">
                  <span className="inline-flex items-center gap-2 border border-te-accent/60 bg-te-accent/8 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-te-accent">
                    <span className="size-1.5 bg-te-accent" />
                    {membershipLabel(level)}
                  </span>
                </Row>
                {unlimited ? (
                  <Row label="SaaS 调用">
                    <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-te-accent">
                      无限 · 不扣积分
                    </span>
                  </Row>
                ) : (
                  <Row label="剩余积分">
                    <span className="font-mono text-sm tabular-nums text-te-fg">
                      {Math.round(profile?.creditsBalance ?? 0).toLocaleString(
                        "zh-CN",
                      )}
                    </span>
                  </Row>
                )}
              </div>

              {/* Subscription —— 跳浏览器到 OpenLoaf Web 完成 */}
              <div className="mb-5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-px w-4 bg-te-accent" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    订阅
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void openWebPage("/pricing")}
                  className="inline-flex w-full items-center justify-center gap-2 bg-te-accent px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
                >
                  <Sparkles className="size-4" />
                  {subscribeButtonLabel}
                </button>
                <p className="mt-2 font-sans text-xs text-te-light-gray">
                  {unlimited
                    ? "当前套餐在 OpenLoaf 站点统一管理。"
                    : "在 OpenLoaf 网站购买 Pro 或 Premium 套餐后，OpenSpeech 云端调用即变为无限。"}
                </p>
              </div>

              {/* Recharge —— 仅非 pro+ 展示 */}
              {!unlimited ? (
                <div className="mb-5">
                  <div className="mb-3 flex items-center gap-2">
                    <span className="h-px w-4 bg-te-accent" />
                    <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                      充值积分
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => void openWebPage("/recharge")}
                    className="inline-flex w-full items-center justify-center gap-2 border border-te-gray px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
                  >
                    <Gift className="size-4" />
                    充值
                  </button>
                  <p className="mt-2 font-sans text-xs text-te-light-gray">
                    1 元 = 100 积分。不订阅套餐也可直接充值。
                  </p>
                </div>
              ) : null}

              {/* Session */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-px w-4 bg-te-accent" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    会话
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="inline-flex w-full items-center justify-center gap-2 border border-te-gray px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent disabled:opacity-50"
                >
                  <LogOut className="size-4" />
                  {loggingOut ? "正在退出..." : "退出登录"}
                </button>
                <p className="mt-2 font-sans text-xs text-te-light-gray">
                  退出后将清除本地登录状态。本地录音、历史与词典将保留。
                </p>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
