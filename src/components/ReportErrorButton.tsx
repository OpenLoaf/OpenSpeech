import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Send } from "lucide-react";

import { cn } from "@/lib/utils";
import { reportError, type ReportErrorInput } from "@/lib/reportError";

type Status = "idle" | "sending" | "sent";

type Props = ReportErrorInput & {
  className?: string;
  disabled?: boolean;
};

export function ReportErrorButton({
  scope,
  code,
  message,
  extra,
  className,
  disabled,
}: Props) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<Status>("idle");

  const handleClick = async () => {
    if (status !== "idle" || disabled) return;
    setStatus("sending");
    try {
      await reportError({ scope, code, message, extra });
      setStatus("sent");
      toast.success(t("errors:report.toast_success"));
    } catch (e) {
      const errCode = String(e ?? "");
      if (errCode === "FEEDBACK_AUTH_LOST") {
        toast.error(t("errors:report.toast_auth_lost"));
      } else if (errCode === "FEEDBACK_NETWORK") {
        toast.error(t("errors:report.toast_network"));
      } else if (errCode === "FEEDBACK_TIMEOUT") {
        toast.error(t("errors:report.toast_timeout"));
      } else {
        toast.error(t("errors:report.toast_failed", { message: errCode }));
      }
      setStatus("idle");
    }
  };

  const label =
    status === "sending"
      ? t("errors:report.sending")
      : status === "sent"
        ? t("errors:report.sent")
        : t("errors:report.action");

  const Icon = status === "sent" ? Check : Send;

  return (
    <button
      type="button"
      onClick={() => void handleClick()}
      disabled={disabled || status !== "idle"}
      className={cn(
        "inline-flex items-center justify-center gap-2 border px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] transition-colors",
        status === "sent"
          ? "cursor-default border-te-accent bg-te-surface text-te-accent"
          : "border-te-gray bg-te-surface text-te-fg hover:border-te-accent hover:text-te-accent",
        (disabled || status === "sending") && "cursor-not-allowed opacity-60",
        className,
      )}
    >
      <Icon
        className={cn("size-3.5", status === "sending" && "animate-pulse")}
        strokeWidth={status === "sent" ? 3 : 2}
        aria-hidden
      />
      {label}
    </button>
  );
}
