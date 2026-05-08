import { create } from "zustand";
import { toast } from "sonner";
import i18n, { resolveLang } from "@/i18n";
import { newId } from "@/lib/ids";
import { refineTextViaChatStream, isSaasAuthError } from "@/lib/ai-refine";
import { handleAiRefineCustomFailure } from "@/lib/ai-refine-fallback";
import {
  DEFAULT_POLISH_SCENARIOS,
  getEffectiveAiPolishSystemPrompt,
  getEffectiveAiTranslationSystemPrompt,
  type PolishScenario,
} from "@/lib/defaultAiPrompts";
import {
  useSettingsStore,
  type TranslateTargetLang,
} from "@/stores/settings";
import { useHistoryStore, type HistoryItem } from "@/stores/history";
import { useAuthStore } from "@/stores/auth";

const TRANSLATE_LANG_NAMES: Record<TranslateTargetLang, string> = {
  en: "English",
  zh: "Simplified Chinese (简体中文)",
  "zh-TW": "Traditional Chinese (繁體中文)",
  ja: "Japanese (日本語)",
  ko: "Korean (한국어)",
  fr: "French (Français)",
  de: "German (Deutsch)",
  es: "Spanish (Español)",
};

export interface DictationResult {
  id: string;
  type: "dictation" | "translate";
  rawText: string;
  refinedText: string | null;
  polishedText: string | null;
  translatedText: string | null;
  targetLang: string | null;
  audioMs: number;
  asrMs: number | null;
  refineMs: number | null;
  createdAt: number;
}

type Busy = "refine" | "translate" | null;

interface DictationResultState {
  current: DictationResult | null;
  busy: Busy;
  streamPartial: string;
  setFromHistory: (item: HistoryItem) => void;
  clear: () => void;
  /** scenarioId: 选中的 PolishScenario id；null/undefined = 不带场景指令（仅基础润色 prompt） */
  runRefine: (scenarioId?: string | null) => Promise<void>;
  /** lang: 目标语言；不传走 settings.general.translateTargetLang */
  runTranslate: (lang?: TranslateTargetLang) => Promise<void>;
}

function resolvePolishScenarios(): PolishScenario[] {
  const aiSettings = useSettingsStore.getState().aiRefine;
  const lang = resolveLang(useSettingsStore.getState().general.interfaceLang);
  return aiSettings.customPolishScenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
}

export const useDictationResultStore = create<DictationResultState>((set, get) => ({
  current: null,
  busy: null,
  streamPartial: "",

  setFromHistory: (item) => {
    if (item.status !== "success") return;
    if (item.type !== "dictation" && item.type !== "translate") return;
    const raw = (item.text ?? "").trim();
    if (!raw) return;
    set({
      current: {
        id: item.id,
        type: item.type,
        rawText: item.text ?? "",
        refinedText: item.refined_text ?? null,
        polishedText: null,
        translatedText: item.type === "translate" ? item.refined_text ?? null : null,
        targetLang: item.target_lang ?? null,
        audioMs: item.duration_ms,
        asrMs: item.asr_ms ?? null,
        refineMs: item.refine_ms ?? null,
        createdAt: item.created_at,
      },
      busy: null,
      streamPartial: "",
    });
  },

  clear: () => set({ current: null, busy: null, streamPartial: "" }),

  runRefine: async (scenarioId) => {
    const cur = get().current;
    if (!cur || get().busy) return;
    const sourceText = (cur.polishedText ?? cur.refinedText ?? cur.rawText).trim();
    if (!sourceText) return;

    const aiSettings = useSettingsStore.getState().aiRefine;
    const generalSettings = useSettingsStore.getState().general;
    const lang = resolveLang(generalSettings.interfaceLang);

    if (aiSettings.mode === "saas" && !useAuthStore.getState().user) {
      toast.error(i18n.t("dialogs:login.title"), {
        description: i18n.t("dialogs:login.description"),
      });
      return;
    }

    let activeProvider = null as
      | { id: string; name: string; baseUrl: string; model: string }
      | null;
    if (aiSettings.mode === "custom") {
      activeProvider =
        aiSettings.customProviders.find(
          (p) => p.id === aiSettings.activeCustomProviderId,
        ) ?? null;
      if (!activeProvider) {
        await handleAiRefineCustomFailure(new Error("no_active_custom_provider"));
        return;
      }
    }

    const targetId = cur.id;
    set({ busy: "refine", streamPartial: "" });

    const polishBase = getEffectiveAiPolishSystemPrompt(
      aiSettings.customPolishSystemPrompt,
      lang,
    );
    const scenario = scenarioId
      ? resolvePolishScenarios().find((s) => s.id === scenarioId) ?? null
      : null;
    const systemPrompt = scenario
      ? `${polishBase}\n\n${scenario.instruction}`
      : polishBase;

    let streamed = "";
    try {
      const r = await refineTextViaChatStream(
        {
          mode: aiSettings.mode,
          systemPrompt,
          userText: sourceText,
          customBaseUrl: activeProvider?.baseUrl,
          customModel: activeProvider?.model,
          customKeyringId: activeProvider
            ? `ai_provider_${activeProvider.id}`
            : undefined,
          taskId: `home-polish-${newId()}`,
        },
        (chunk) => {
          if (get().current?.id !== targetId) return;
          streamed += chunk;
          set({ streamPartial: streamed });
        },
      );
      if (get().current?.id !== targetId) {
        set({ busy: null, streamPartial: "" });
        return;
      }
      const polished = (r.refinedText ?? "").trim() || cur.rawText;
      const next = get().current;
      if (!next || next.id !== targetId) {
        set({ busy: null, streamPartial: "" });
        return;
      }
      set({
        current: { ...next, polishedText: polished },
        busy: null,
        streamPartial: "",
      });
      void useHistoryStore.getState().setRefinedText(targetId, polished);
    } catch (e) {
      set({ busy: null, streamPartial: "" });
      const raw = e instanceof Error ? e.message : String(e);
      if (isSaasAuthError(raw)) {
        toast.error(i18n.t("dialogs:login.title"), {
          description: i18n.t("dialogs:login.description"),
        });
        return;
      }
      const handled = await handleAiRefineCustomFailure(e);
      if (!handled) {
        toast.error(i18n.t("overlay:toast.ai_refine_custom_failed.title"), {
          description: raw,
        });
      }
    }
  },

  runTranslate: async (langOverride) => {
    const cur = get().current;
    if (!cur || get().busy) return;
    const sourceText = (
      cur.polishedText ??
      cur.refinedText ??
      cur.rawText
    ).trim();
    if (!sourceText) return;

    const aiSettings = useSettingsStore.getState().aiRefine;
    const generalSettings = useSettingsStore.getState().general;
    const lang = resolveLang(generalSettings.interfaceLang);
    const targetLang = langOverride ?? generalSettings.translateTargetLang;

    if (aiSettings.mode === "saas" && !useAuthStore.getState().user) {
      toast.error(i18n.t("dialogs:login.title"), {
        description: i18n.t("dialogs:login.description"),
      });
      return;
    }

    let activeProvider = null as
      | { id: string; name: string; baseUrl: string; model: string }
      | null;
    if (aiSettings.mode === "custom") {
      activeProvider =
        aiSettings.customProviders.find(
          (p) => p.id === aiSettings.activeCustomProviderId,
        ) ?? null;
      if (!activeProvider) {
        await handleAiRefineCustomFailure(new Error("no_active_custom_provider"));
        return;
      }
    }

    const targetId = cur.id;
    set({ busy: "translate", streamPartial: "" });

    const base = getEffectiveAiTranslationSystemPrompt(
      aiSettings.customTranslationSystemPrompt,
      lang,
    );
    const targetLangName = TRANSLATE_LANG_NAMES[targetLang] ?? targetLang;
    const systemPrompt = `${base}\n\nTarget language: ${targetLangName}`;

    let streamed = "";
    try {
      const r = await refineTextViaChatStream(
        {
          mode: aiSettings.mode,
          systemPrompt,
          userText: sourceText,
          customBaseUrl: activeProvider?.baseUrl,
          customModel: activeProvider?.model,
          customKeyringId: activeProvider
            ? `ai_provider_${activeProvider.id}`
            : undefined,
          taskId: `home-translate-${newId()}`,
        },
        (chunk) => {
          if (get().current?.id !== targetId) return;
          streamed += chunk;
          set({ streamPartial: streamed });
        },
      );
      if (get().current?.id !== targetId) {
        set({ busy: null, streamPartial: "" });
        return;
      }
      const translated = (r.refinedText ?? "").trim();
      const next = get().current;
      if (!next || next.id !== targetId) {
        set({ busy: null, streamPartial: "" });
        return;
      }
      set({
        current: {
          ...next,
          translatedText: translated || next.translatedText,
          targetLang,
        },
        busy: null,
        streamPartial: "",
      });
    } catch (e) {
      set({ busy: null, streamPartial: "" });
      const raw = e instanceof Error ? e.message : String(e);
      if (isSaasAuthError(raw)) {
        toast.error(i18n.t("dialogs:login.title"), {
          description: i18n.t("dialogs:login.description"),
        });
        return;
      }
      const handled = await handleAiRefineCustomFailure(e);
      if (!handled) {
        toast.error(i18n.t("overlay:toast.ai_refine_custom_failed.title"), {
          description: raw,
        });
      }
    }
  },
}));
