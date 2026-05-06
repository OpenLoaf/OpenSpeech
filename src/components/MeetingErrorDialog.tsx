import { useTranslation } from "react-i18next";
import { AlertTriangle, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ReportErrorButton } from "@/components/ReportErrorButton";
import { useUIStore } from "@/stores/ui";

const ERROR_CODES_OPEN_SETTINGS: ReadonlySet<string> = new Set([
  "meeting_provider_unsupported",
  "meeting_provider_not_configured",
  "unauthenticated_byok",
]);

// 腾讯账号没开通"实时说话人分离"是控制台层面的事情，不在 OpenSpeech 设置里
// 解决——单独引导跳腾讯云 ASR 资源包页，用户在那里能立即看到"实时说话人分离"
// SKU 是否已购买/未开通，并直接走购买/领取免费包流程。
const ERROR_CODES_OPEN_TENCENT_CONSOLE: ReadonlySet<string> = new Set([
  "engine_not_authorized",
]);
const TENCENT_ASR_CONSOLE_URL = "https://console.cloud.tencent.com/asr/resourcebundle";

export interface MeetingError {
  code: string;
  message: string;
}

type Props = {
  error: MeetingError | null;
  onClose: () => void;
};

export function MeetingErrorDialog({ error, onClose }: Props) {
  const { t } = useTranslation();
  const openSettings = useUIStore((s) => s.openSettings);
  const open = !!error;

  const title = error
    ? t(`errors:meetings.${error.code}`, { defaultValue: error.message || error.code })
    : "";
  const hint = error
    ? t(`errors:meetings.${error.code}_hint`, { defaultValue: "" })
    : "";
  const showOpenSettings = !!error && ERROR_CODES_OPEN_SETTINGS.has(error.code);
  const showOpenTencentConsole =
    !!error && ERROR_CODES_OPEN_TENCENT_CONSOLE.has(error.code);

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent
        showCloseButton
        className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-md"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <AlertTriangle className="size-4 shrink-0 text-[#ff4d4d]" aria-hidden />
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {hint || error?.message || ""}
          </DialogDescription>
        </DialogHeader>

        <div className="px-5 py-5">
          {/* hint 命中就只显示译文；没有翻译时（多见于 start_failed 兜底）才把 raw
              message 当 fallback 给用户看一眼，避免无信息空白。 */}
          <p className="font-sans text-sm leading-relaxed text-te-light-gray">
            {hint || error?.message || ""}
          </p>

          {showOpenTencentConsole ? (
            <button
              type="button"
              onClick={() => {
                void openUrl(TENCENT_ASR_CONSOLE_URL);
                onClose();
              }}
              className="mt-3 flex w-full items-center gap-2 border border-te-gray/40 bg-te-surface px-3 py-2 text-left font-mono text-[11px] text-te-accent transition hover:border-te-accent hover:bg-te-surface-hover"
              title={t("errors:meetings.open_tencent_console", { defaultValue: "Open" })}
            >
              <ExternalLink className="size-3 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate underline-offset-2 group-hover:underline">
                {TENCENT_ASR_CONSOLE_URL}
              </span>
            </button>
          ) : null}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {error ? (
              <ReportErrorButton
                scope="meetings"
                code={error.code}
                message={error.message}
              />
            ) : null}
            <div className="ml-auto flex flex-wrap justify-end gap-2">
            {showOpenSettings ? (
              <button
                type="button"
                onClick={() => {
                  openSettings("DICTATION");
                  onClose();
                }}
                className="inline-flex items-center justify-center border border-te-accent bg-te-accent px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition hover:brightness-110"
              >
                {t("errors:meetings.go_to_settings", { defaultValue: "Open settings" })}
              </button>
            ) : null}
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center justify-center border border-te-gray bg-te-surface px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition hover:border-te-accent hover:text-te-accent"
            >
              {t("common:actions.close", { defaultValue: "Close" })}
            </button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
