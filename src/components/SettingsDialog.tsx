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

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 打开时希望直接定位到的 tab（默认 GENERAL）。每次 open 翻 false→true 时生效。 */
  initialTab?: SettingsTabId;
};

export function SettingsDialog({ open, onOpenChange, initialTab = "GENERAL" }: Props) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
