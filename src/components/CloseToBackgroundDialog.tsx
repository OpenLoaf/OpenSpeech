import { useState } from "react";
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
  onConfirm: (opts: { remember: boolean; action: "hide" | "quit" }) => void;
};

export function CloseToBackgroundDialog({ open, onOpenChange, onConfirm }: Props) {
  const [remember, setRemember] = useState<boolean>(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setRemember(false);
        onOpenChange(next);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-md"
      >
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-6 py-4">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            关闭到后台
          </DialogTitle>
          <DialogDescription className="sr-only">
            OpenSpeech 即将关闭主窗口，应用将继续在后台运行
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6 py-5 font-sans text-sm text-te-fg">
          <p>
            OpenSpeech 将继续在 <span className="text-te-accent">后台</span> 运行，全局快捷键仍然可用。
          </p>
          <p className="text-te-light-gray">
            可通过系统托盘图标重新打开主窗口，或选择"退出"完全结束进程。
          </p>

          <label className="mt-4 flex cursor-pointer items-center gap-3 pt-2 select-none">
            <span
              className={cn(
                "relative flex size-4 items-center justify-center border transition-colors",
                remember
                  ? "border-te-accent bg-te-accent"
                  : "border-te-gray/60 bg-te-surface",
              )}
            >
              {remember ? (
                <span className="size-1.5 bg-te-accent-fg" aria-hidden />
              ) : null}
            </span>
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
              className="sr-only"
            />
            <span className="font-mono text-xs uppercase tracking-[0.15em] text-te-light-gray">
              不再提醒
            </span>
          </label>
        </div>

        <div className="flex items-stretch border-t border-te-dialog-border">
          <button
            type="button"
            onClick={() => onConfirm({ remember, action: "quit" })}
            className="flex-1 border-r border-te-dialog-border px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:bg-te-surface-hover hover:text-te-fg"
          >
            退出 OpenSpeech
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ remember, action: "hide" })}
            className="flex-1 bg-te-accent px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            继续在后台运行
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
