import { useEffect, useState } from "react";
import { AlertCircle, RefreshCw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

// recording gate 在 SAAS 路径下检测 navigator.onLine === false 时打开。
// 打开期间订阅 window 'online' 事件——一旦恢复网络立即自动关闭，
// 用户无需手动点 X，紧接着可以再按一次快捷键正常录音。
export function NoInternetDialog({ open, onOpenChange }: Props) {
  const [retrying, setRetrying] = useState(false);
  const [stillOffline, setStillOffline] = useState(false);

  useEffect(() => {
    if (!open) return;
    setStillOffline(false);
    const handleOnline = () => onOpenChange(false);
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [open, onOpenChange]);

  // 不打开系统设置：浏览器/WebView 沙盒内能拿到的信号只有 navigator.onLine，
  // 用户手动点「重试」时重新读一次；已恢复就关掉弹窗，仍离线就给一次反馈。
  const handleRetry = () => {
    setRetrying(true);
    setStillOffline(false);
    window.setTimeout(() => {
      if (navigator.onLine) {
        onOpenChange(false);
      } else {
        setStillOffline(true);
      }
      setRetrying(false);
    }, 350);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-md"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <AlertCircle className="size-4 shrink-0 text-te-accent" aria-hidden />
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            没有互联网连接
          </DialogTitle>
          <DialogDescription className="sr-only">
            您的计算机未连接到互联网，请检查网络后重试
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-5">
          <p className="font-sans text-sm leading-relaxed text-te-light-gray">
            您的计算机未连接到互联网。请检查网络连接后重试。
          </p>

          {stillOffline ? (
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.18em] text-te-accent">
              仍未检测到网络
            </p>
          ) : null}

          <div className="mt-5 flex justify-center">
            <button
              type="button"
              disabled={retrying}
              onClick={handleRetry}
              className={cn(
                "inline-flex items-center justify-center gap-2 border border-te-gray bg-te-surface px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors",
                retrying
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-te-accent hover:text-te-accent",
              )}
            >
              <RefreshCw
                className={cn("size-3.5", retrying && "animate-spin")}
                aria-hidden
              />
              重试
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
