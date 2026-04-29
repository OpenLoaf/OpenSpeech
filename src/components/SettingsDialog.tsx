import { useEffect, useState } from "react";
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
  // 关闭时不要立刻卸载 SettingsContent，否则 dialog 还在 fade-out 期间内容就空了，
  // popup 突然失重 + portal 卸载会让主界面闪一下。等 base-ui 的 exit 动画跑完再卸载。
  const [renderContent, setRenderContent] = useState(open);
  useEffect(() => {
    if (open) setRenderContent(true);
  }, [open]);
  // 每次 open 翻 false→true 时换 key，让 SettingsContent 内部 useState(initialTab) 重新生效，
  // 避免"上次手动切到的 tab"残留；用 mount 计数代替原先把 open 拼进 key 的写法。
  const [openCount, setOpenCount] = useState(0);
  useEffect(() => {
    if (open) setOpenCount((c) => c + 1);
  }, [open]);
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onOpenChangeComplete={(o) => {
        if (!o) setRenderContent(false);
      }}
    >
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
        <div className="flex min-h-0 flex-1">
          {renderContent ? (
            <SettingsContent
              key={`${initialTab}:${openCount}`}
              initialTab={initialTab}
            />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
