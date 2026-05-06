import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SettingsContent from "@/components/SettingsContent";
import type { SettingsTabId } from "@/stores/ui";
import {
  useSettingsStore,
  hasUnverifiedActiveDictation,
  hasUnverifiedActiveAiRefine,
} from "@/stores/settings";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时希望直接定位到的 tab（默认 GENERAL）。每次 open 翻 false→true 时生效。 */
  initialTab?: SettingsTabId;
};

type PendingRollback = {
  dictation: boolean;
  ai: boolean;
};

/// 计算关闭时哪些通道处于"custom 但 active 未验证"——也就是需要拦下来询问用户的状态。
function snapshotPending(): PendingRollback {
  const state = useSettingsStore.getState();
  return {
    dictation: hasUnverifiedActiveDictation(state.dictation),
    ai: hasUnverifiedActiveAiRefine(state.aiRefine),
  };
}

export function SettingsDialog({ open, onOpenChange, initialTab = "GENERAL" }: Props) {
  const { t } = useTranslation("settings");
  const [pending, setPending] = useState<PendingRollback | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      const snap = snapshotPending();
      if (snap.dictation || snap.ai) {
        // 拦下关闭：把疑点摆到一个独立 Dialog 里给用户做选择，先不传播 false 给上层。
        setPending(snap);
        return;
      }
    }
    onOpenChange(next);
  };

  const cancelClose = () => {
    setPending(null);
  };

  const proceedClose = async () => {
    const state = useSettingsStore.getState();
    if (pending?.dictation) await state.setDictationMode("saas");
    if (pending?.ai) await state.setAiRefineMode("saas");
    setPending(null);
    onOpenChange(false);
  };

  const whichLabel = (() => {
    if (!pending) return "";
    if (pending.dictation && pending.ai)
      return t("provider_rollback.both");
    if (pending.dictation) return t("provider_rollback.dictation");
    return t("provider_rollback.ai");
  })();

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          className="flex h-[82vh] w-[92vw] max-w-6xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-6xl"
        >
          <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-4 py-3">
            <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
              {t("page.dialog_title")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("page.dialog_sr")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex min-h-0 flex-1">
            {open ? <SettingsContent initialTab={initialTab} /> : null}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={pending != null} onOpenChange={(o) => { if (!o) cancelClose(); }}>
        <DialogContent
          showCloseButton={false}
          className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-md"
        >
          <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
            <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
              {t("provider_rollback.confirm_title")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("provider_rollback.confirm_title")}
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-5 font-sans text-sm text-te-light-gray">
            {t("provider_rollback.confirm_description", { which: whichLabel })}
          </div>
          <div className="flex justify-end gap-2 border-t border-te-dialog-border bg-te-surface-hover px-4 py-3">
            <button
              type="button"
              onClick={cancelClose}
              className="border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
            >
              {t("provider_rollback.confirm_back_to_test")}
            </button>
            <button
              type="button"
              onClick={() => void proceedClose()}
              className="border border-amber-500/60 bg-amber-500/10 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-amber-200 transition-colors hover:bg-amber-500/20"
            >
              {t("provider_rollback.confirm_proceed")}
            </button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
