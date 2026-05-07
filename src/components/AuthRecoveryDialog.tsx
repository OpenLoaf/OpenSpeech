import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCheck, Copy, Loader2, AlertTriangle } from "lucide-react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useHistoryStore } from "@/stores/history";
import { useUIStore } from "@/stores/ui";
import { cn } from "@/lib/utils";

// 录音结束后云端转写撞 401 → 弹登录 → 用户登录回来后用刚才录音续转的结果展示。
// 内容直接读 ui.authRecoveryDialog.historyId 对应的 history item，等 main.tsx 完成
// retry 后 status 切到 success；失败时 main.tsx 把 error message 也写回 dialog state。
export function AuthRecoveryDialog() {
  const { t } = useTranslation();
  const dialog = useUIStore((s) => s.authRecoveryDialog);
  const closeDialog = useUIStore((s) => s.closeAuthRecoveryDialog);
  const items = useHistoryStore((s) => s.items);
  const [copied, setCopied] = useState(false);

  const item = useMemo(
    () =>
      dialog.historyId
        ? items.find((it) => it.id === dialog.historyId) ?? null
        : null,
    [dialog.historyId, items],
  );

  // 优先 refined（如果 refine 跑通了），否则原始 text。两者都空时（状态异常）兜底成
  // 占位文案——dialog 永远要给用户一个可点的"关闭"出口，不能空白。
  const displayText = useMemo(() => {
    if (!item) return "";
    return (item.refined_text ?? item.text ?? "").trim();
  }, [item]);

  // dialog 关闭后下一次 open 时复位 copied 高亮，避免上一次的 ✓ 残留。
  useEffect(() => {
    if (!dialog.open) setCopied(false);
  }, [dialog.open]);

  const onCopy = async () => {
    if (!displayText) return;
    try {
      await writeClipboard(displayText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch (e) {
      console.warn("[auth-recovery] copy failed:", e);
    }
  };

  return (
    <Dialog
      open={dialog.open}
      onOpenChange={(o) => {
        if (!o) closeDialog();
      }}
    >
      <DialogContent
        showCloseButton
        className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-lg"
      >
        <DialogHeader className="flex flex-row items-start gap-2 border-b border-te-dialog-border bg-te-surface-hover py-4 pr-12 pl-5">
          {dialog.status === "pending" ? (
            <Loader2
              className="mt-0.5 size-4 shrink-0 animate-spin text-te-accent"
              aria-hidden
            />
          ) : dialog.status === "error" ? (
            <AlertTriangle
              className="mt-0.5 size-4 shrink-0 text-[#ff4d4d]"
              aria-hidden
            />
          ) : (
            <CheckCheck
              className="mt-0.5 size-4 shrink-0 text-te-accent"
              aria-hidden
            />
          )}
          <DialogTitle className="min-w-0 flex-1 font-mono text-base font-bold tracking-tighter text-te-fg">
            {t(`dialogs:auth_recovery.title_${dialog.status}`)}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(`dialogs:auth_recovery.description_${dialog.status}`)}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 px-5 py-5">
          <p className="font-sans text-sm leading-relaxed text-te-light-gray">
            {t(`dialogs:auth_recovery.description_${dialog.status}`)}
          </p>

          {dialog.status === "success" && (
            <div className="flex max-h-72 flex-col gap-2 overflow-hidden">
              <div
                className={cn(
                  "max-h-72 overflow-auto whitespace-pre-wrap break-words border border-te-gray/40 bg-te-surface px-3 py-2 font-sans text-sm leading-relaxed text-te-fg",
                )}
              >
                {displayText ||
                  t("dialogs:auth_recovery.empty_transcript")}
              </div>
            </div>
          )}

          {dialog.status === "error" && dialog.errorMessage && (
            <div className="border border-[#ff4d4d]/40 bg-[#ff4d4d]/5 px-3 py-2 font-mono text-xs leading-relaxed break-words text-[#ff4d4d]">
              {dialog.errorMessage}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2">
            {dialog.status === "success" && (
              <button
                type="button"
                onClick={() => void onCopy()}
                disabled={!displayText}
                className={cn(
                  "inline-flex items-center justify-center gap-2 border px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] transition",
                  copied
                    ? "border-te-accent bg-te-accent text-te-accent-fg"
                    : "border-te-accent text-te-accent hover:bg-te-accent hover:text-te-accent-fg",
                  !displayText && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-te-accent",
                )}
              >
                {copied ? (
                  <CheckCheck className="size-3.5" aria-hidden />
                ) : (
                  <Copy className="size-3.5" aria-hidden />
                )}
                {copied
                  ? t("dialogs:auth_recovery.copied")
                  : t("dialogs:auth_recovery.copy")}
              </button>
            )}
            <button
              type="button"
              onClick={closeDialog}
              disabled={dialog.status === "pending"}
              className={cn(
                "inline-flex items-center justify-center border border-te-gray bg-te-surface px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition hover:border-te-accent hover:text-te-accent",
                dialog.status === "pending" && "cursor-not-allowed opacity-40 hover:border-te-gray hover:text-te-fg",
              )}
            >
              {t(
                dialog.status === "pending"
                  ? "dialogs:auth_recovery.close_disabled"
                  : "dialogs:auth_recovery.close",
              )}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
