import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import { toast } from "sonner";
import { MessageSquare, Send, ChevronDown } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useAuthStore } from "@/stores/auth";
import { detectPlatform } from "@/lib/platform";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

type FeedbackType = "bug" | "feature" | "ui" | "performance" | "chat" | "other";

const TYPE_ORDER: FeedbackType[] = [
  "bug",
  "feature",
  "ui",
  "performance",
  "chat",
  "other",
];

const MIN_CONTENT_LEN = 5;

export function FeedbackDialog({ open, onOpenChange }: Props) {
  const { t } = useTranslation("feedback");
  const user = useAuthStore((s) => s.user);
  const profile = useAuthStore((s) => s.profile);

  const [type, setType] = useState<FeedbackType>("bug");
  const [content, setContent] = useState("");
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // 每次开弹窗都重置；登录用户默认填账户邮箱，方便不用手敲。
  useEffect(() => {
    if (!open) return;
    setType("bug");
    setContent("");
    setEmail(user?.email ?? profile?.email ?? "");
    setSubmitting(false);
  }, [open, user?.email, profile?.email]);

  const typeOptions = useMemo(
    () =>
      TYPE_ORDER.map((id) => ({
        id,
        label: t(`type.${id}`),
      })),
    [t],
  );

  const handleSubmit = async () => {
    if (submitting) return;
    const trimmed = content.trim();
    if (trimmed.length === 0) {
      toast.error(t("validation.content_required"));
      return;
    }
    if (trimmed.length < MIN_CONTENT_LEN) {
      toast.error(t("validation.content_too_short"));
      return;
    }
    const trimmedEmail = email.trim();
    if (trimmedEmail.length > 0 && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmedEmail)) {
      toast.error(t("validation.email_invalid"));
      return;
    }

    setSubmitting(true);
    try {
      const appVersion = await getVersion().catch(() => "");
      await invoke("openloaf_submit_feedback", {
        payload: {
          type,
          content: trimmed,
          email: trimmedEmail || null,
          context: {
            platform: detectPlatform(),
            appVersion,
            userAgent:
              typeof navigator !== "undefined" ? navigator.userAgent : "",
          },
        },
      });
      toast.success(t("toast.success"));
      onOpenChange(false);
    } catch (e) {
      const code = String(e ?? "");
      if (code === "FEEDBACK_AUTH_LOST") {
        toast.error(t("toast.auth_lost"));
      } else if (code === "FEEDBACK_NETWORK") {
        toast.error(t("toast.network"));
      } else if (code === "FEEDBACK_TIMEOUT") {
        toast.error(t("toast.timeout"));
      } else {
        toast.error(t("toast.generic", { message: code }));
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex w-[92vw] max-w-lg flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-lg"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <MessageSquare className="size-4 shrink-0 text-te-accent" aria-hidden />
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("dialog_title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("dialog_description")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 px-5 py-5">
          <p className="font-sans text-xs leading-relaxed text-te-light-gray">
            {t("dialog_description")}
          </p>

          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("type_label")}
            </label>
            <div className="relative inline-flex w-full items-center border border-te-gray/40 bg-te-surface transition-colors focus-within:border-te-accent hover:border-te-gray">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as FeedbackType)}
                disabled={submitting}
                className="w-full cursor-pointer appearance-none bg-transparent py-2 pr-8 pl-3 font-mono text-sm text-te-fg focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
              >
                {typeOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
              <ChevronDown className="pointer-events-none absolute right-2 size-3.5 text-te-light-gray" />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("content_label")}
            </label>
            <textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              disabled={submitting}
              placeholder={t("content_placeholder")}
              rows={6}
              className="w-full resize-none border border-te-gray/40 bg-te-surface px-3 py-2 font-sans text-sm text-te-fg placeholder:text-te-light-gray/60 transition-colors focus:border-te-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
          </div>

          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("email_label")}
            </label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={submitting}
              placeholder={t("email_placeholder")}
              className="w-full border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-sm text-te-fg placeholder:text-te-light-gray/60 transition-colors focus:border-te-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
            />
            <p className="mt-1 font-sans text-[11px] text-te-light-gray/80">
              {t("email_hint")}
            </p>
          </div>

          <div className="flex flex-row-reverse items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => void handleSubmit()}
              disabled={submitting}
              className={cn(
                "inline-flex items-center gap-2 border border-te-accent bg-te-accent px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors",
                submitting
                  ? "cursor-not-allowed opacity-60"
                  : "hover:bg-te-accent/90",
              )}
            >
              <Send className={cn("size-3.5", submitting && "animate-pulse")} aria-hidden />
              {submitting ? t("submit_loading") : t("submit")}
            </button>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
              className="inline-flex items-center gap-2 border border-te-gray bg-te-surface px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-te-gray hover:text-te-fg disabled:cursor-not-allowed disabled:opacity-60"
            >
              {t("cancel")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
