import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { diffChars, type Change } from "diff";
import { Pencil, X } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHistoryStore, type HistoryItem } from "@/stores/history";

const TEXTAREA_CLS =
  "min-h-[180px] w-full resize-y border border-te-gray/40 bg-te-bg px-3 py-2 font-sans text-sm leading-relaxed text-te-fg outline-none transition-colors focus:border-te-accent";

// 字符级 diff 渲染：删 = 红色删除线，增 = 绿色背景；保留段正常颜色。
// 中英混合下字符级最稳——中文每字一 token、英文每字符一 token，颗粒精细。
function renderInlineDiff(original: string, edited: string): ReactNode {
  const changes: Change[] = diffChars(original, edited);
  return changes.map((part, i) => {
    if (part.added) {
      return (
        <span
          key={i}
          className="bg-te-accent/25 text-te-fg underline decoration-te-accent/60 decoration-1 underline-offset-2"
        >
          {part.value}
        </span>
      );
    }
    if (part.removed) {
      return (
        <span
          key={i}
          className="bg-[#ff4d4d]/20 text-[#ff4d4d] line-through decoration-[#ff4d4d]/70"
        >
          {part.value}
        </span>
      );
    }
    return (
      <span key={i} className="text-te-light-gray">
        {part.value}
      </span>
    );
  });
}

// dirty 时切换到 inline diff（标签 = "修改对比"），否则显示原文（标签 = "原始内容"）。
// 不另开第三栏，节省 Dialog 高度。
function ComparePanel({ baseline, draft }: { baseline: string; draft: string }) {
  const { t } = useTranslation();
  const dirty = draft !== baseline;
  const diffNodes = useMemo(
    () => (dirty ? renderInlineDiff(baseline, draft) : null),
    [dirty, baseline, draft],
  );
  const label = dirty
    ? t("pages:history.edit.diff_label")
    : t("pages:history.edit.original_label");
  const isEmpty = !dirty && baseline.length === 0;

  return (
    <div>
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`font-mono text-[10px] uppercase tracking-widest ${
            dirty ? "text-te-accent" : "text-te-light-gray/70"
          }`}
        >
          {label}
        </span>
      </div>
      <div className="max-h-[180px] overflow-y-auto border border-te-gray/30 bg-te-surface px-3 py-2 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap">
        {isEmpty ? (
          <span className="font-mono text-xs text-te-light-gray/50">
            {t("pages:history.detail.empty_text")}
          </span>
        ) : dirty ? (
          diffNodes
        ) : (
          <span className="text-te-light-gray">{baseline}</span>
        )}
      </div>
    </div>
  );
}

export function HistoryEditDialog({
  open,
  onOpenChange,
  item,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  item: HistoryItem;
}) {
  const { t } = useTranslation();
  const updateText = useHistoryStore((s) => s.updateText);
  // 基线：用户在详情里看到的"AI 给的最终版"——优先 refined_text，没有 refine 时就是原始 ASR
  const baseline = (item.refined_text ?? item.text ?? "").trim();
  const initial = item.text_edited ?? baseline;
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);

  // 每次打开重置为最新值，避免上次缓存覆盖（同一条记录多次编辑）
  useEffect(() => {
    if (open) {
      setDraft(item.text_edited ?? baseline);
    }
  }, [open, item.id, item.text_edited, baseline]);

  const dirty = draft !== (item.text_edited ?? baseline);

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateText(item.id, draft);
      toast.success(t("pages:history.edit.toast.save_success"));
      onOpenChange(false);
    } catch (e) {
      console.error("[history-edit] save failed:", e);
      toast.error(t("pages:history.edit.toast.save_failed"));
    } finally {
      setSaving(false);
    }
  };

  const handleRevert = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await updateText(item.id, null);
      toast.success(t("pages:history.edit.toast.revert_success"));
      onOpenChange(false);
    } catch (e) {
      console.error("[history-edit] revert failed:", e);
      toast.error(t("pages:history.edit.toast.save_failed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="!gap-0 rounded-none border border-te-gray bg-te-bg p-0 sm:max-w-2xl"
        showCloseButton={false}
      >
        <DialogHeader className="flex flex-row items-center gap-3 border-b border-te-gray/40 bg-te-surface-hover px-4 py-3">
          <Pencil className="size-4 text-te-accent" strokeWidth={2} />
          <DialogTitle className="flex-1 font-mono text-sm font-bold tracking-tighter text-te-fg uppercase">
            {t("pages:history.edit.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("pages:history.edit.description")}
          </DialogDescription>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex size-7 items-center justify-center border border-transparent text-te-light-gray transition-colors hover:border-te-gray/60 hover:text-te-accent"
            aria-label={t("actions.close")}
          >
            <X className="size-4" />
          </button>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-4 py-4">
          <ComparePanel baseline={baseline} draft={draft} />

          <div>
            <div className="mb-1.5 flex items-center gap-2">
              <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent">
                {t("pages:history.edit.edited_label")}
              </span>
              <span className="font-mono text-[10px] tracking-widest text-te-light-gray/50">
                {t("pages:history.edit.hint")}
              </span>
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className={TEXTAREA_CLS}
              placeholder={t("pages:history.edit.placeholder")}
              autoFocus
              spellCheck={false}
            />
          </div>
        </div>

        <DialogFooter className="m-0 flex flex-row flex-wrap items-center gap-2 rounded-none border-t border-te-gray/40 bg-te-surface-hover px-4 py-3">
          {item.text_edited !== null && item.text_edited !== undefined && (
            <button
              type="button"
              onClick={() => void handleRevert()}
              disabled={saving}
              className="border border-te-gray/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-te-light-gray transition-colors hover:border-te-fg hover:text-te-fg disabled:cursor-not-allowed disabled:opacity-40"
              title={t("pages:history.edit.revert_tooltip")}
            >
              {t("pages:history.edit.revert")}
            </button>
          )}
          <div className="ml-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={saving}
              className="border border-te-gray/60 px-3 py-1.5 font-mono text-xs uppercase tracking-wider text-te-fg transition-colors hover:border-te-accent hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("actions.cancel")}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving || !dirty}
              className="border border-te-accent/60 bg-te-accent/10 px-4 py-1.5 font-mono text-xs uppercase tracking-wider text-te-accent transition-colors hover:bg-te-accent/20 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-te-accent/10"
            >
              {t("pages:history.edit.save")}
            </button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
