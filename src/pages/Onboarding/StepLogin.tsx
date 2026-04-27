import { useEffect, useMemo, useRef, useState, type FC } from "react";
import { motion } from "framer-motion";
import { useTranslation } from "react-i18next";
import { ArrowRight, Loader2, Sparkles, ServerCog } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuthStore, type LoginProvider } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";

// Step 3：调用真实 OpenLoaf 登录流程（useAuthStore.startLogin）。
// startLogin → 拉起浏览器 → 用户授权 → Rust emit success → isAuthenticated=true
// → 这里 effect 自动跳下一步。失败显示错误并允许重试。

function friendlyLoginError(
  raw: string | null,
  t: (k: string) => string,
): string {
  if (!raw) return t("onboarding:login.error_default");
  const m = raw.toLowerCase();
  if (m.includes("connection reset")) return t("onboarding:login.error_reset");
  if (m.includes("timed out") || m.includes("timeout"))
    return t("onboarding:login.error_timeout");
  if (
    m.includes("connection refused") ||
    m.includes("dns") ||
    m.includes("error sending request") ||
    m.includes("network error")
  )
    return t("onboarding:login.error_network");
  return t("onboarding:login.error_default");
}

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden>
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function WechatIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="#07C160" aria-hidden>
      <path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.104 2.358-.292a.65.65 0 0 1 .547.075l1.588.926a.282.282 0 0 0 .14.046c.133 0 .24-.107.24-.24 0-.06-.023-.11-.038-.165l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088-.135-.01-.27-.027-.407-.034zm-2.53 3.297c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
    </svg>
  );
}

type LoginMethod = {
  id: LoginProvider;
  label: string;
  sub: string;
  Icon: FC<{ className?: string }>;
};

export function StepLogin({
  onNext,
}: {
  onNext: () => void;
}) {
  const { t } = useTranslation();
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const loginStatus = useAuthStore((s) => s.loginStatus);
  const loginError = useAuthStore((s) => s.loginError);
  const startLogin = useAuthStore((s) => s.startLogin);
  const cancelLogin = useAuthStore((s) => s.cancelLogin);

  const [pending, setPending] = useState<LoginProvider | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const methods = useMemo<LoginMethod[]>(
    () => [
      {
        id: "wechat",
        label: t("onboarding:login.method_wechat_label"),
        sub: t("onboarding:login.method_wechat_sub"),
        Icon: WechatIcon,
      },
      {
        id: "google",
        label: t("onboarding:login.method_google_label"),
        sub: t("onboarding:login.method_google_sub"),
        Icon: GoogleIcon,
      },
    ],
    [t],
  );

  // 登录成功 → 自动进入下一步。延迟 600ms 让用户看到"登录成功"状态。
  useEffect(() => {
    if (!isAuthenticated) return;
    const t = window.setTimeout(() => onNext(), 600);
    return () => window.clearTimeout(t);
  }, [isAuthenticated, onNext]);

  // 离开此步时若还在登录中，主动取消。
  // 注意：必须用 ref 镜像最新值 + 空依赖 cleanup，否则每次 loginStatus 变化时
  // React 会先跑旧 effect 的 cleanup，捕获到的还是上一帧的 "opening"，导致
  // opening → polling 过渡瞬间被自取消，永远进不到"等待授权"状态。
  const loginStatusRef = useRef(loginStatus);
  const cancelLoginRef = useRef(cancelLogin);
  useEffect(() => {
    loginStatusRef.current = loginStatus;
    cancelLoginRef.current = cancelLogin;
  }, [loginStatus, cancelLogin]);
  useEffect(() => {
    return () => {
      const s = loginStatusRef.current;
      if (s === "opening" || s === "polling") {
        void cancelLoginRef.current();
      }
    };
  }, []);

  // 错误 → 解除 pending 锁定，允许换种方式重试。
  useEffect(() => {
    if (loginStatus === "error" || loginStatus === "idle") {
      setPending(null);
    }
  }, [loginStatus]);

  const isBusy = loginStatus === "opening" || loginStatus === "polling";

  const handleLogin = (m: LoginProvider) => {
    if (isBusy || isAuthenticated) return;
    setPending(m);
    void startLogin(m);
  };

  const statusLabel = (() => {
    if (isAuthenticated) return t("onboarding:login.status_success");
    if (loginStatus === "opening") return t("onboarding:login.status_opening");
    if (loginStatus === "polling") return t("onboarding:login.status_polling");
    if (loginStatus === "error") return friendlyLoginError(loginError, t);
    return null;
  })();
  const statusTone =
    loginStatus === "error"
      ? "text-red-400"
      : isAuthenticated
        ? "text-te-accent"
        : "text-te-light-gray";

  return (
    <div className="flex h-full w-full flex-col overflow-hidden px-8 pt-40 pb-6">
      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mx-auto flex h-full w-full max-w-2xl flex-col"
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <span className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-accent">
            {t("onboarding:login.section_tag")}
          </span>
          <h2 className="font-mono text-2xl font-bold tracking-tighter text-te-fg md:text-3xl">
            {t("onboarding:login.title")}
          </h2>
          <p className="max-w-md font-sans text-xs leading-relaxed text-te-light-gray">
            {t("onboarding:login.subtitle_openloaf")}
          </p>
          <div className="inline-flex w-fit items-center gap-2 border border-te-accent/40 bg-te-accent/5 px-3 py-1.5">
            <Sparkles className="size-3.5 shrink-0 text-te-accent" />
            <span className="font-mono text-[11px] font-bold uppercase tracking-[0.15em] text-te-accent">
              {t("onboarding:login.bonus_main")}
            </span>
            <span className="font-sans text-xs text-te-light-gray">
              {t("onboarding:login.bonus_minutes_prefix")}{" "}
              <span className="font-mono text-te-fg">
                {t("onboarding:login.bonus_minutes_value")}
              </span>{" "}
              {t("onboarding:login.bonus_minutes_suffix")}
            </span>
          </div>
        </div>

        <div className="mt-8 flex flex-col gap-6">
          {methods.map((m) => {
            const loading = pending === m.id && isBusy;
            const success = pending === m.id && isAuthenticated;
            const disabled = (isBusy && !loading) || (isAuthenticated && !success);
            const Icon = m.Icon;
            return (
              <button
                key={m.id}
                type="button"
                disabled={disabled}
                onClick={() => handleLogin(m.id)}
                className={cn(
                  "group flex h-20 items-center gap-4 border px-5 transition-colors",
                  loading || success
                    ? "border-te-accent bg-te-accent/10"
                    : disabled
                      ? "cursor-not-allowed border-te-gray/40 opacity-50"
                      : "border-te-gray/60 bg-te-surface hover:border-te-accent",
                )}
              >
                <Icon className="size-7 shrink-0" />
                <div className="flex flex-1 flex-col items-start gap-1">
                  <span className="font-mono text-base font-bold tracking-tight text-te-fg">
                    {m.label}
                  </span>
                  <span className="font-mono text-[10px] uppercase tracking-widest text-te-light-gray">
                    {m.sub}
                  </span>
                </div>
                {loading ? (
                  <Loader2 className="size-5 shrink-0 animate-spin text-te-accent" />
                ) : (
                  <ArrowRight className="size-5 shrink-0 text-te-light-gray transition-transform group-hover:translate-x-1 group-hover:text-te-accent" />
                )}
              </button>
            );
          })}

          {statusLabel ? (
            <div className="flex items-center justify-center gap-2 pt-1">
              <span
                className={cn(
                  "size-1.5 shrink-0",
                  loginStatus === "error"
                    ? "bg-red-500/70"
                    : isAuthenticated
                      ? "bg-te-accent"
                      : "bg-te-accent",
                )}
              />
              <span
                className={cn(
                  "font-mono text-[11px] uppercase tracking-[0.2em]",
                  statusTone,
                )}
              >
                {statusLabel}
              </span>
              {isBusy ? (
                <button
                  type="button"
                  onClick={() => void cancelLogin()}
                  className="ml-3 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray underline-offset-4 transition-colors hover:text-te-fg hover:underline"
                >
                  {t("onboarding:login.cancel")}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>

        <div className="flex items-center justify-end">
          <button
            type="button"
            onClick={() => setAdvanced((v) => !v)}
            className="px-3 py-2 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray underline-offset-4 transition-colors hover:text-te-fg hover:underline"
          >
            {advanced
              ? t("onboarding:login.advanced_collapse")
              : t("onboarding:login.advanced_expand")}
          </button>
        </div>

        {advanced ? (
          <div className="flex flex-col gap-2 border border-te-gray/60 bg-te-surface p-3">
            <p className="font-sans text-xs leading-snug text-te-light-gray">
              {t("onboarding:login.advanced_desc")}
            </p>
            <button
              type="button"
              onClick={() => {
                useUIStore.getState().openSettings("MODEL");
                onNext();
              }}
              className="inline-flex items-center gap-2 self-start border border-te-gray px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
            >
              <ServerCog className="size-3" />{" "}
              {t("onboarding:login.advanced_cta")}
            </button>
          </div>
        ) : null}
      </motion.div>
    </div>
  );
}
