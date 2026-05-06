import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";

import { detectPlatform } from "@/lib/platform";

export type ReportErrorInput = {
  scope: string;
  code: string;
  message?: string | null;
  extra?: Record<string, unknown>;
};

// 复用 feedback 通道：public 端点匿名可发，type=bug + 自动 context。
// 抛出原始后端 code（如 FEEDBACK_AUTH_LOST / FEEDBACK_NETWORK），由调用方自定 toast。
export async function reportError(input: ReportErrorInput): Promise<void> {
  const appVersion = await getVersion().catch(() => "");

  let logTail: string | null = null;
  try {
    logTail = await invoke<string>("read_recent_log_tail");
  } catch (err) {
    console.warn("[report-error] read log tail failed", err);
  }

  const summary = input.message?.trim()
    ? `${input.scope}/${input.code}: ${input.message.trim()}`
    : `${input.scope}/${input.code}`;

  await invoke("openloaf_submit_feedback", {
    payload: {
      type: "bug",
      content: `[auto-report] ${summary}`,
      email: null,
      context: {
        platform: detectPlatform(),
        appVersion,
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        autoReport: true,
        scope: input.scope,
        code: input.code,
        ...(input.message ? { errorMessage: input.message } : {}),
        ...(input.extra ?? {}),
        ...(logTail ? { logs: logTail } : {}),
      },
    },
  });
}
