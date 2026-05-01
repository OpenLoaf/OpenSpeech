import i18next from "i18next";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

type ShowOptions = {
  version: string;
  onInstall: () => void;
  onSkip?: () => void;
  duration?: number;
};

// sonner 默认把 action / cancel 与标题挤在同一行，标题被压窄、版本号又走描述区，
// 长按钮文案下整体会折成多行（"Update available" 拆两行、版本号也拆）。
// 这里走 toast.custom 自己排版：标题+版本号上面一行，按钮独占下面一行。
export function showUpdateAvailableToast({
  version,
  onInstall,
  onSkip,
  duration,
}: ShowOptions): string | number {
  const title = i18next.t("pages:layout.tray.update_found_title");
  const installLabel = i18next.t("settings:about.install_now");
  const skipLabel = i18next.t("settings:about.skip_version");

  return toast.custom(
    (id) => (
      <div className="flex w-[340px] flex-col gap-3 border border-te-gray bg-te-bg p-4 font-mono text-xs text-te-fg shadow-2xl">
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-bold uppercase tracking-[0.15em] text-te-fg">
            {title}
          </span>
          <span className="text-te-light-gray">{version}</span>
        </div>
        <div className="flex items-stretch justify-end gap-2">
          {onSkip ? (
            <button
              type="button"
              onClick={() => {
                toast.dismiss(id);
                onSkip();
              }}
              className={cn(
                "border border-te-gray px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-te-light-gray transition-colors",
                "hover:bg-te-surface-hover hover:text-te-fg",
              )}
            >
              {skipLabel}
            </button>
          ) : null}
          <button
            type="button"
            onClick={() => {
              toast.dismiss(id);
              onInstall();
            }}
            className={cn(
              "border border-te-accent bg-te-accent px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.15em] text-te-accent-fg transition-colors",
              "hover:bg-te-accent/90",
            )}
          >
            {installLabel}
          </button>
        </div>
      </div>
    ),
    {
      duration: duration ?? Infinity,
      unstyled: true,
    },
  );
}
