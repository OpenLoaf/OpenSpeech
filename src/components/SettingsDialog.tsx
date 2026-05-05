import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import i18n from "@/i18n";
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

/// 关闭设置时的回退策略：用户切到了 custom 但没把 provider 测通过 → 直接把 mode
/// 写回 saas，并 toast 告诉用户为什么。这条路径保证关闭后下次调用一定能跑：要么
/// custom 确实测通了，要么自动回到云端。
async function rollbackUnverifiedToSaas() {
  const state = useSettingsStore.getState();
  let rolledBack: ("dictation" | "ai")[] = [];

  if (hasUnverifiedActiveDictation(state.dictation)) {
    await state.setDictationMode("saas");
    rolledBack.push("dictation");
  }
  if (hasUnverifiedActiveAiRefine(state.aiRefine)) {
    await state.setAiRefineMode("saas");
    rolledBack.push("ai");
  }

  if (rolledBack.length > 0) {
    const which =
      rolledBack.length === 2
        ? i18n.t("settings:provider_rollback.both")
        : rolledBack[0] === "dictation"
          ? i18n.t("settings:provider_rollback.dictation")
          : i18n.t("settings:provider_rollback.ai");
    toast.warning(i18n.t("settings:provider_rollback.title"), {
      description: i18n.t("settings:provider_rollback.description", { which }),
    });
  }
}

export function SettingsDialog({ open, onOpenChange, initialTab = "GENERAL" }: Props) {
  const { t } = useTranslation("settings");
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      // fire-and-forget：toast 用 i18n 当场拿，不阻塞 dialog 关闭。
      void rollbackUnverifiedToSaas();
    }
    onOpenChange(next);
  };
  return (
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
  );
}
