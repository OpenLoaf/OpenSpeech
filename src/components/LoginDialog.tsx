import { useEffect, useState, type ReactElement } from "react";
import { ChevronDown, Loader2, RotateCcw, ServerCog } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAuthStore, type LoginProvider } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/** Google / 微信 SVG —— 独立组件，避免每个按钮内联一大块 path。 */
function GoogleMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        fill="#FFC107"
        d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"
      />
      <path
        fill="#FF3D00"
        d="M6.306 14.691l6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.611 20.083H42V20H24v8h11.303c-.792 2.237-2.231 4.166-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"
      />
    </svg>
  );
}

function WechatMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} aria-hidden>
      <path
        fill="#09B83E"
        d="M18.5 6C10.492 6 4 11.83 4 19.02c0 3.973 2.02 7.53 5.192 9.94L7.5 34l5.68-3.184c1.662.462 3.447.71 5.32.71.276 0 .55-.005.822-.016-.227-.828-.35-1.69-.35-2.576 0-5.87 5.604-10.627 12.52-10.627.325 0 .646.011.965.032C30.39 11.336 24.964 6 18.5 6zm-4.75 5.25c.966 0 1.75.784 1.75 1.75s-.784 1.75-1.75 1.75-1.75-.784-1.75-1.75.784-1.75 1.75-1.75zm9.5 0c.966 0 1.75.784 1.75 1.75s-.784 1.75-1.75 1.75-1.75-.784-1.75-1.75.784-1.75 1.75-1.75z"
      />
      <path
        fill="#09B83E"
        d="M44 28.87c0-5.89-5.82-10.664-13-10.664S18 22.98 18 28.87c0 5.887 5.82 10.662 13 10.662 1.54 0 3.02-.22 4.402-.623L40 41.066l-1.316-3.924C41.848 35.193 44 32.24 44 28.87zm-17.25-1.62a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3zm8.5 0a1.5 1.5 0 1 1 0-3 1.5 1.5 0 0 1 0 3z"
      />
    </svg>
  );
}

const PROVIDERS: Array<{
  id: LoginProvider;
  label: string;
  Icon: (p: { className?: string }) => ReactElement;
}> = [
  { id: "google", label: "使用 Google 登录", Icon: GoogleMark },
  { id: "wechat", label: "使用微信登录", Icon: WechatMark },
];

/** 把后端 / 网络层的 raw 错误清洗成短中文提示，友好且不吓人。
 *  原始消息仍然在"详情"折叠区里展示，方便排查时取证。 */
function friendlyLoginError(raw: string | null): string {
  if (!raw) return "登录失败，请重试";
  const m = raw.toLowerCase();
  if (m.includes("connection reset")) return "登录服务器连接被重置，请稍后重试";
  if (m.includes("timed out") || m.includes("timeout")) return "登录超时，请重试";
  if (
    m.includes("connection refused") ||
    m.includes("dns") ||
    m.includes("error sending request") ||
    m.includes("network error")
  )
    return "无法连接登录服务器，请检查网络后重试";
  if (m.includes("not authenticated")) return "未登录";
  return "登录失败，请重试";
}

export function LoginDialog({ open, onOpenChange }: Props) {
  const {
    loginStatus,
    loginError,
    lastProvider,
    isAuthenticated,
    startLogin,
    retryLogin,
    cancelLogin,
  } = useAuthStore();

  const isBusy = loginStatus === "opening" || loginStatus === "polling";
  const isError = loginStatus === "error";
  const [showDetails, setShowDetails] = useState(false);

  // 关闭弹窗时收起详情，避免下次打开还是展开状态。
  useEffect(() => {
    if (!open) setShowDetails(false);
  }, [open]);

  // 打开时重置错误；关闭时取消进行中的登录。
  useEffect(() => {
    if (!open && isBusy) {
      void cancelLogin();
    }
  }, [open, isBusy, cancelLogin]);

  // 登录成功后自动关闭（isAuthenticated 翻成 true 由 success 事件驱动）。
  useEffect(() => {
    if (open && isAuthenticated) {
      const t = window.setTimeout(() => onOpenChange(false), 800);
      return () => window.clearTimeout(t);
    }
  }, [open, isAuthenticated, onOpenChange]);

  const subtitle = (() => {
    if (isAuthenticated) return "登录成功";
    if (loginStatus === "opening") return "正在打开浏览器...";
    if (loginStatus === "polling") return "等待在浏览器完成授权";
    if (isError) return friendlyLoginError(loginError);
    return "选择登录方式继续";
  })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0">
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            登录 OpenLoaf
          </DialogTitle>
          <DialogDescription className="sr-only">
            选择一种登录方式以继续
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-5">
          {/* Provider buttons */}
          <div className="flex flex-col gap-2">
            {PROVIDERS.map(({ id, label, Icon }) => (
              <button
                key={id}
                type="button"
                disabled={isBusy || isAuthenticated}
                onClick={() => void startLogin(id)}
                className={cn(
                  "inline-flex w-full items-center justify-center gap-3 border border-te-gray bg-te-surface px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors",
                  !isBusy && !isAuthenticated
                    ? "hover:border-te-accent hover:text-te-accent"
                    : "cursor-not-allowed opacity-50",
                )}
              >
                <Icon className="size-5" />
                {label}
              </button>
            ))}
          </div>

          {/* BYO STT 入口：不想登录 OpenLoaf 的用户可以直接跳到设置 → 大模型 tab
              填写自己的 STT REST 端点。"或" 分隔线把 SaaS / BYO 两条路径视觉拉平。 */}
          <div className="flex items-center gap-2">
            <span className="h-px flex-1 bg-te-gray/40" />
            <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray">
              或
            </span>
            <span className="h-px flex-1 bg-te-gray/40" />
          </div>
          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              disabled={isBusy || isAuthenticated}
              onClick={() => {
                onOpenChange(false);
                useUIStore.getState().openSettings("MODEL");
              }}
              className={cn(
                "inline-flex w-full items-center justify-center gap-3 border border-te-gray/60 px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors",
                !isBusy && !isAuthenticated
                  ? "hover:border-te-accent hover:text-te-accent"
                  : "cursor-not-allowed opacity-50",
              )}
            >
              <ServerCog className="size-4" />
              使用自己的 STT 端点
            </button>
            {!isBusy ? (
              <p className="font-sans text-xs leading-relaxed text-te-light-gray">
                不想登录 OpenLoaf？填写你自己的 STT REST 端点，音频从本机直发，不经云端。
              </p>
            ) : null}
          </div>

          {/* 状态/说明区：空闲时展示说明文字；登录中/出错/成功时替换为状态行。
              整组（黄点 + 文字 + spinner）作为一个 inline 单元水平居中，
              方块和 loader 直接贴在文字左右两侧。
              错误状态下文案改用 `friendlyLoginError` 清洗后的中文短句，
              raw 信息收进下面的"详情"折叠区，避免大段英文 stack 吓到用户。 */}
          {isBusy || isError || isAuthenticated ? (
            <div className="flex items-center justify-center gap-2 pt-1">
              <span
                className={cn(
                  "size-1.5 shrink-0",
                  isError
                    ? "bg-red-500/70"
                    : isAuthenticated
                      ? "bg-green-500/80"
                      : "bg-te-accent",
                )}
              />
              <span
                className={cn(
                  "font-mono text-[11px] uppercase tracking-[0.2em]",
                  isError ? "text-red-500/90" : "text-te-light-gray",
                )}
              >
                {subtitle}
              </span>
              {isBusy ? (
                <Loader2 className="size-3.5 shrink-0 animate-spin text-te-light-gray" />
              ) : null}
            </div>
          ) : null}

          {/* 错误恢复区：突出"重试"按钮（沿用上次 provider）+ 关闭 + 折叠详情。
              没有 lastProvider（理论上 error 状态下一定有，只是兜底）时不渲染重试。 */}
          {isError ? (
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-center gap-2">
                {lastProvider ? (
                  <button
                    type="button"
                    onClick={() => void retryLogin()}
                    className="inline-flex items-center gap-2 border border-te-accent bg-te-accent/10 px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-te-accent transition-colors hover:bg-te-accent hover:text-te-bg"
                  >
                    <RotateCcw className="size-3.5" />
                    重试
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => onOpenChange(false)}
                  className="inline-flex items-center gap-2 border border-te-gray px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-fg hover:text-te-fg"
                >
                  关闭
                </button>
              </div>
              {loginError ? (
                <div className="flex flex-col items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setShowDetails((v) => !v)}
                    className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray transition-colors hover:text-te-fg"
                  >
                    <ChevronDown
                      className={cn(
                        "size-3 transition-transform",
                        showDetails ? "rotate-180" : "rotate-0",
                      )}
                    />
                    {showDetails ? "收起详情" : "查看详情"}
                  </button>
                  {showDetails ? (
                    <pre className="max-h-32 w-full overflow-auto whitespace-pre-wrap break-all border border-te-gray/40 bg-te-surface/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-te-light-gray">
                      {loginError}
                    </pre>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}

          {isBusy ? (
            <button
              type="button"
              onClick={() => void cancelLogin()}
              className="self-center font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:text-te-fg"
            >
              取消登录
            </button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
