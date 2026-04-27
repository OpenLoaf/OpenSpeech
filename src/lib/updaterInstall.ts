import i18next from "i18next";
import { toast } from "sonner";
import { invoke } from "@tauri-apps/api/core";
import {
  info as logInfo,
  error as logError,
} from "@tauri-apps/plugin-log";
import { Update } from "@tauri-apps/plugin-updater";

// Rust 自定义 command `check_for_update` 返回 plugin-updater 兼容的 metadata。
// rid 与 plugin 共用同一 webview ResourceTable，所以 new Update(metadata) 后
// 调用 download/install 走的还是 plugin 的命令，无需自己实现下载链路。
type UpdateMetadata = {
  rid: number;
  currentVersion: string;
  version: string;
  date?: string;
  body?: string;
  rawJson: Record<string, unknown>;
};

export async function checkForUpdateForChannel(): Promise<Update | null> {
  const metadata = await invoke<UpdateMetadata | null>("check_for_update");
  return metadata ? new Update(metadata) : null;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export async function installUpdateWithProgress(
  update: Update,
  source: "boot-prompt" | "tray" | "about-page",
): Promise<void> {
  const version = update.version;
  const toastId = `update-install-${version}`;

  let downloaded = 0;
  let total = 0;
  let lastRenderAt = 0;
  let lastPercent = -1;

  const showProgress = () => {
    let description: string;
    if (total > 0) {
      const percent = Math.min(100, Math.floor((downloaded / total) * 100));
      description = i18next.t("settings:about.install_progress", {
        version,
        percent,
        downloaded: formatBytes(downloaded),
        total: formatBytes(total),
      });
    } else {
      description = i18next.t("settings:about.install_starting", {
        version,
        downloaded: formatBytes(downloaded),
      });
    }
    toast.message(i18next.t("settings:about.install_in_progress"), {
      id: toastId,
      description,
      duration: Infinity,
    });
  };

  // 进入"准备下载"状态：先把现有 toast 用同一个 id 占住，避免后续刷新出现两个气泡
  toast.message(i18next.t("settings:about.install_in_progress"), {
    id: toastId,
    description: version,
    duration: Infinity,
  });

  try {
    void logInfo(`[updater] ${source} install start → ${version}`);
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") {
        total = event.data.contentLength ?? 0;
        downloaded = 0;
        lastPercent = -1;
        lastRenderAt = 0;
        showProgress();
      } else if (event.event === "Progress") {
        downloaded += event.data.chunkLength;
        // 每 1% 或每 200ms 刷新一次，避免 sonner 在每个 chunk 上重排
        const now = Date.now();
        const percent =
          total > 0 ? Math.floor((downloaded / total) * 100) : -1;
        if (percent !== lastPercent || now - lastRenderAt >= 200) {
          lastPercent = percent;
          lastRenderAt = now;
          showProgress();
        }
      } else if (event.event === "Finished") {
        toast.message(i18next.t("settings:about.install_finalizing"), {
          id: toastId,
          description: version,
          duration: Infinity,
        });
      }
    });
    void logInfo(`[updater] ${source} downloadAndInstall returned`);
  } catch (e) {
    void logError(
      `[updater] ${source} install failed: ${String((e as Error)?.message ?? e)}`,
    );
    toast.error(i18next.t("settings:about.install_failed"), {
      id: toastId,
      description: String((e as Error)?.message ?? e),
    });
    throw e;
  }
}
