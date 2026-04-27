import { useState } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
            {t("dialogs:close_to_bg.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialogs:close_to_bg.description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3 px-6 py-5 font-sans text-sm text-te-fg">
          <p>
            {t("dialogs:close_to_bg.body_1_prefix")}
            <span className="text-te-accent">
              {t("dialogs:close_to_bg.body_1_highlight")}
            </span>
            {t("dialogs:close_to_bg.body_1_suffix")}
          </p>
          <p className="text-te-light-gray">
            {t("dialogs:close_to_bg.body_2")}
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
              {t("dialogs:close_to_bg.remember")}
            </span>
          </label>
        </div>

        <div className="flex items-stretch border-t border-te-dialog-border">
          <button
            type="button"
            onClick={() => onConfirm({ remember, action: "quit" })}
            className="flex-1 border-r border-te-dialog-border px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:bg-te-surface-hover hover:text-te-fg"
          >
            {t("dialogs:close_to_bg.quit")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm({ remember, action: "hide" })}
            className="flex-1 bg-te-accent px-4 py-3 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            {t("dialogs:close_to_bg.stay")}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
