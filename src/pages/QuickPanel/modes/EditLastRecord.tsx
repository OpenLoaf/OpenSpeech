import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { useHistoryStore, type HistoryItem } from "@/stores/history";
import { cn } from "@/lib/utils";

const TYPE_FILTER: HistoryItem["type"][] = ["dictation", "translate", "ask"];

function pickLatest(items: HistoryItem[]): HistoryItem | null {
  for (const it of items) {
    if (TYPE_FILTER.includes(it.type) && it.status === "success") return it;
  }
  return null;
}

function baselineText(item: HistoryItem | null): string {
  if (!item) return "";
  return item.text_edited ?? item.refined_text ?? item.text ?? "";
}

export default function EditLastRecordView() {
  const { t } = useTranslation("quickPanel");
  const items = useHistoryStore((s) => s.items);
  const reload = useHistoryStore((s) => s.reload);
  const updateText = useHistoryStore((s) => s.updateText);

  const target = useMemo(() => pickLatest(items), [items]);
  const [draft, setDraft] = useState<string>(() => baselineText(target));
  const [saving, setSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 每次 mount（窗口被重新拉起）都从 SQLite 拉一次最新——主窗里录音后 history.add
  // 在主窗 store 里，quick panel 是独立 runtime，必须 reload 才能看到。
  useEffect(() => {
    void reload().catch((e) =>
      console.warn("[quick-panel] history reload failed:", e),
    );
  }, [reload]);

  // 命中新 target / 文本基线变化时同步到草稿。用户已有未保存编辑时不覆盖——以
  // sessionRef 锁住"用户已经动过 textarea"的状态。
  const dirtyRef = useRef(false);
  useEffect(() => {
    if (!dirtyRef.current) {
      setDraft(baselineText(target));
    }
  }, [target]);

  // mount + target 就绪后聚焦 textarea 并选中全文，方便直接覆盖输入。
  useEffect(() => {
    if (!target) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, [target?.id]);

  const baseline = baselineText(target);
  const trimmed = draft.trim();
  const canSave = !!target && !saving && trimmed.length > 0 && draft !== baseline;

  const onSave = async () => {
    if (!target || saving) return;
    if (draft === baseline) {
      void invoke("quick_panel_hide");
      return;
    }
    setSaving(true);
    try {
      await updateText(target.id, draft);
      try {
        await writeClipboard(draft);
      } catch (e) {
        console.warn("[quick-panel] clipboard write failed:", e);
      }
      toast.success(t("toast.saved_title"), {
        description: t("toast.saved_description"),
        duration: 2400,
      });
      // hide 在 toast 之后 invoke，避免 toast 被窗口关闭瞬间 unmount——sonner 是
      // 全局 portal，主进程不存在所以 toast 跟着 quick panel 一起死。这里靠主窗口
      // 的 Toaster 不通用：quick panel 自己的 toast 仅在面板可见时见到。
      void invoke("quick_panel_hide");
    } catch (e) {
      console.warn("[quick-panel] save failed:", e);
      toast.error(t("toast.save_failed_title"), {
        description: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setSaving(false);
    }
  };

  // Cmd/Ctrl+Enter 保存
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && canSave) {
      e.preventDefault();
      void onSave();
    }
  };

  return (
    <div className="flex flex-1 flex-col">
      {/* header — 整条作为窗口拖动区域；title / time 是 plain text，不拦截 mousedown */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 cursor-grab items-center justify-between border-b border-te-dialog-border px-4 py-3 active:cursor-grabbing"
      >
        <div
          data-tauri-drag-region
          className="font-mono text-[11px] uppercase tracking-[0.18em] text-te-light-gray"
        >
          {t("edit_last_record.title")}
        </div>
        {target && (
          <div
            data-tauri-drag-region
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-te-light-gray"
          >
            {new Date(target.created_at).toLocaleTimeString()}
          </div>
        )}
      </div>

      {/* body */}
      <div className="flex flex-1 flex-col overflow-hidden px-4 py-3">
        {!target ? (
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] tracking-wide text-te-light-gray">
            {t("edit_last_record.empty")}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(e) => {
              dirtyRef.current = true;
              setDraft(e.target.value);
            }}
            onKeyDown={onKeyDown}
            spellCheck={false}
            className={cn(
              "flex-1 resize-none rounded-md border border-te-gray bg-te-bg p-3 text-[13px] leading-relaxed",
              "outline-none focus:border-te-accent focus:ring-2 focus:ring-te-accent/20",
              "font-sans text-te-fg placeholder:text-te-light-gray",
            )}
          />
        )}
      </div>

      {/* footer — 提示文字所在区域也作为拖动区，按钮自然拦截事件不拖动 */}
      <div
        data-tauri-drag-region
        className="flex shrink-0 items-center justify-between gap-3 border-t border-te-dialog-border px-4 py-3"
      >
        <div
          data-tauri-drag-region
          className="font-mono text-[10px] uppercase tracking-[0.14em] text-te-light-gray"
        >
          {t("edit_last_record.hint")}
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void invoke("quick_panel_hide")}
            className={cn(
              "rounded-md border border-te-gray bg-te-bg px-3 py-1.5",
              "font-mono text-[11px] uppercase tracking-[0.12em] text-te-fg",
              "hover:bg-te-surface-hover",
            )}
          >
            {t("edit_last_record.cancel")}
          </button>
          <button
            type="button"
            onClick={() => void onSave()}
            disabled={!canSave}
            className={cn(
              "rounded-md border border-te-accent bg-te-accent px-3 py-1.5",
              "font-mono text-[11px] uppercase tracking-[0.12em] text-te-accent-fg",
              "hover:opacity-90 disabled:opacity-50",
            )}
          >
            {saving ? t("edit_last_record.saving") : t("edit_last_record.save")}
          </button>
        </div>
      </div>
    </div>
  );
}
