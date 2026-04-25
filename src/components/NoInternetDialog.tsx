import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
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
  const [opening, setOpening] = useState(false);

  useEffect(() => {
    if (!open) return;
    const handleOnline = () => onOpenChange(false);
    window.addEventListener("online", handleOnline);
    return () => window.removeEventListener("online", handleOnline);
  }, [open, onOpenChange]);

  const handleOpenSettings = async () => {
    setOpening(true);
    try {
      await invoke("open_network_settings");
    } catch (e) {
      console.warn("[net] open_network_settings failed:", e);
    } finally {
      // 留给系统稍许时间响应，再放开按钮
      window.setTimeout(() => setOpening(false), 500);
    }
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
            您的计算机未连接到互联网，请在系统设置中检查网络连接
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-5">
          <p className="font-sans text-sm leading-relaxed text-te-light-gray">
            您的计算机未连接到互联网。请在系统设置中检查连接。
          </p>

          <div className="mt-5 flex justify-center">
            <button
              type="button"
              disabled={opening}
              onClick={handleOpenSettings}
              className={cn(
                "inline-flex items-center justify-center border border-te-gray bg-te-surface px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors",
                opening
                  ? "cursor-not-allowed opacity-50"
                  : "hover:border-te-accent hover:text-te-accent",
              )}
            >
              打开系统设置
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
