import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import SettingsContent from "@/components/SettingsContent";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function SettingsDialog({ open, onOpenChange }: Props) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex h-[82vh] w-[92vw] max-w-6xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-6xl"
      >
        <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-4 py-3">
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            设置
          </DialogTitle>
          <DialogDescription className="sr-only">
            OpenSpeech 设置
          </DialogDescription>
        </DialogHeader>
        {/* 不再整体 overflow-y-auto；由 SettingsContent 内部分段滚动（左侧固定、右侧可滚） */}
        <div className="flex min-h-0 flex-1">
          <SettingsContent />
        </div>
      </DialogContent>
    </Dialog>
  );
}
