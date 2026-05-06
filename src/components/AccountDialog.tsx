import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Gift, LogOut, Mail, Sparkles, User } from "lucide-react";
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

function membershipKey(level: string | undefined): string {
  switch (level) {
    case "lite":
      return "dialogs:account.membership.lite";
    case "pro":
      return "dialogs:account.membership.pro";
    case "premium":
      return "dialogs:account.membership.premium";
    case "free":
    default:
      return "dialogs:account.membership.free";
  }
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
    <div className="flex items-start justify-between gap-4 border-b border-te-gray/30 py-3 last:border-b-0">
      <span className="shrink-0 pt-0.5 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray">
        {label}
      </span>
      <div className="min-w-0 flex-1 text-right">{children}</div>
    </div>
  );
}

export function AccountDialog({ open, onOpenChange }: Props) {
  const { t, i18n } = useTranslation();
  const { user, profile, isAuthenticated, init, loaded, logout } = useAuthStore();
  const [loggingOut, setLoggingOut] = useState(false);
  const level = profile?.membershipLevel;
  const subscribeButtonLabel =
    level === "premium"
      ? t("dialogs:account.subscribe_button.manage")
      : level === "pro"
        ? t("dialogs:account.subscribe_button.upgrade_to_premium")
        : t("dialogs:account.subscribe_button.default");

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

  const isWechat = (profile?.provider ?? "").toLowerCase() === "wechat";
  const identityLabel = isWechat
    ? t("dialogs:account.row.wechat")
    : t("dialogs:account.row.email");
  const identityValue = isWechat
    ? (profile?.name ?? user?.name ?? "—")
    : (user?.email ?? profile?.email ?? user?.name ?? "—");
  const IdentityIcon = isWechat ? User : Mail;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0">
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("dialogs:account.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialogs:account.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-5 py-5">
          {!loaded ? (
            <div className="py-10 text-center font-mono text-xs uppercase tracking-[0.25em] text-te-light-gray">
              {t("dialogs:account.loading")}
            </div>
          ) : (
            <>
              {/* Identity */}
              <div className="mb-5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-px w-4 bg-te-accent" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    {t("dialogs:account.section.identity")}
                  </span>
                </div>
                <Row label={identityLabel}>
                  <span className="inline-flex max-w-full items-start gap-2 font-mono text-sm text-te-fg">
                    <IdentityIcon className="mt-[3px] size-3.5 shrink-0 text-te-light-gray" />
                    <span className="break-all text-left">{identityValue}</span>
                  </span>
                </Row>
                <Row label={t("dialogs:account.row.subscription")}>
                  <span className="inline-flex items-center gap-2 border border-te-accent/60 bg-te-accent/8 px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.15em] text-te-accent">
                    <span className="size-1.5 bg-te-accent" />
                    {t(membershipKey(level))}
                  </span>
                </Row>
                <Row label={t("dialogs:account.row.credits_balance")}>
                  <span className="font-mono text-sm tabular-nums text-te-fg">
                    {Math.round(profile?.creditsBalance ?? 0).toLocaleString(
                      i18n.language,
                    )}
                  </span>
                </Row>
              </div>

              {/* Subscription —— 跳浏览器到 OpenLoaf Web 完成 */}
              <div className="mb-5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-px w-4 bg-te-accent" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    {t("dialogs:account.section.subscription")}
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
                  {t("dialogs:account.subscribe_hint")}
                </p>
              </div>

              {/* Recharge */}
              <div className="mb-5">
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-px w-4 bg-te-accent" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    {t("dialogs:account.section.recharge")}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => void openWebPage("/recharge")}
                  className="inline-flex w-full items-center justify-center gap-2 border border-te-gray px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
                >
                  <Gift className="size-4" />
                  {t("dialogs:account.recharge_button")}
                </button>
                <p className="mt-2 font-sans text-xs text-te-light-gray">
                  {t("dialogs:account.recharge_hint")}
                </p>
              </div>

              {/* Session */}
              <div>
                <div className="mb-3 flex items-center gap-2">
                  <span className="h-px w-4 bg-te-accent" />
                  <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
                    {t("dialogs:account.section.session")}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleLogout}
                  disabled={loggingOut}
                  className="inline-flex w-full items-center justify-center gap-2 border border-te-gray px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent disabled:opacity-50"
                >
                  <LogOut className="size-4" />
                  {loggingOut
                    ? t("dialogs:account.logout_busy")
                    : t("dialogs:account.logout_button")}
                </button>
                <p className="mt-2 font-sans text-xs text-te-light-gray">
                  {t("dialogs:account.logout_hint")}
                </p>
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
