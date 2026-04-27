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
        className="flex h-[82vh] w-[92vw] max-w-6xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 duration-200 data-open:zoom-in-90 data-open:slide-in-from-bottom-2 data-closed:zoom-out-90 data-closed:slide-out-to-bottom-2 sm:max-w-6xl"
      >
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-4 py-3">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("page.dialog_title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("page.dialog_sr")}
          </DialogDescription>
        </DialogHeader>
        {/* 不再整体 overflow-y-auto；由 SettingsContent 内部分段滚动（左侧固定、右侧可滚） */}
        {/* key 绑 open + initialTab：每次 open 切到 true（尤其换 tab 再开）会重建子树，
            让 SettingsContent 的内部 useState(initialTab) 重新生效，避免"上次手动切到的 tab"残留。 */}
        <div className="flex min-h-0 flex-1">
          {open ? (
            <SettingsContent
              key={`${initialTab}:${open}`}
              initialTab={initialTab}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
