// AI refine（翻译 / 润色 / 改写）custom 模式失败时的统一处理。
//
// 与 BYOK 听写通道的 fallback 策略对齐：
// - 结构性缺失（用户根本没配齐自定义 provider）→ 静默切回 SaaS + 提示
// - 凭证 / 运行时错误（key 丢、网络断、上游 4xx/5xx）→ 不强切，给一个"切到 SaaS"
//   action 让用户决定，避免悄悄绕过用户的自定义配置
//
// 调用方在 catch 块里先 await handleAiRefineCustomFailure(error)；返回 true 表示
// 已经托管处理（弹了 toast 或自动 fallback），不要再叠加自家的 toast。

import { toast } from "sonner";
import i18n from "@/i18n";
import { useSettingsStore } from "@/stores/settings";

export type AiRefineCustomFailureKind = "missing_provider" | "missing_key" | "runtime";

export function classifyAiRefineCustomFailure(raw: string): AiRefineCustomFailureKind {
  if (raw.includes("missing_custom_provider") || raw.includes("no_active_custom_provider")) {
    return "missing_provider";
  }
  if (raw.includes("missing_api_key")) return "missing_key";
  return "runtime";
}

export async function handleAiRefineCustomFailure(error: unknown): Promise<boolean> {
  const aiRefine = useSettingsStore.getState().aiRefine;
  if (aiRefine.mode !== "custom") return false;

  const raw = error instanceof Error ? error.message : String(error ?? "");
  const kind = classifyAiRefineCustomFailure(raw);
  const setAiRefineMode = useSettingsStore.getState().setAiRefineMode;

  if (kind === "missing_provider") {
    await setAiRefineMode("saas");
    toast.success(i18n.t("overlay:toast.ai_refine_auto_fallback.title"), {
      description: i18n.t("overlay:toast.ai_refine_auto_fallback.description"),
    });
    return true;
  }

  toast.warning(i18n.t("overlay:toast.ai_refine_custom_failed.title"), {
    description: i18n.t(
      kind === "missing_key"
        ? "overlay:toast.ai_refine_custom_failed.description_missing_key"
        : "overlay:toast.ai_refine_custom_failed.description_runtime",
      { error: raw },
    ),
    action: {
      label: i18n.t("overlay:toast.ai_refine_custom_failed.action"),
      onClick: () => {
        void setAiRefineMode("saas");
      },
    },
  });
  return true;
}
