import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Bot, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { resolveLang } from "@/i18n";
import { useUIStore } from "@/stores/ui";
import {
  useSettingsStore,
  DEFAULT_AI_SYSTEM_PROMPTS,
  DEFAULT_AI_TRANSLATION_SYSTEM_PROMPTS,
  DEFAULT_AI_POLISH_SYSTEM_PROMPTS,
  DEFAULT_AI_MEETING_SUMMARY_PROMPTS,
  DEFAULT_POLISH_SCENARIOS,
  type PolishScenario,
} from "@/stores/settings";

function PromptEditDialog({
  open,
  onOpenChange,
  title,
  description,
  value,
  isCustom,
  onChange,
  onReset,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description: string;
  value: string;
  isCustom: boolean;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[88vh] w-[92vw] max-w-2xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-2xl"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <Bot className="size-4 shrink-0 text-te-accent" aria-hidden />
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {title}
          </DialogTitle>
          <DialogDescription className="sr-only">{description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">
          <p className="font-sans text-xs leading-relaxed text-te-light-gray">
            {description}
          </p>

          <div>
            <label className="mb-1.5 block font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
              {t("ai.prompt_dialog_textarea_label")}
            </label>
            <textarea
              value={value}
              onChange={(e) => onChange(e.target.value)}
              rows={14}
              className="w-full resize-y border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-xs leading-relaxed text-te-fg transition-colors focus:border-te-accent focus:outline-none"
            />
          </div>

          <div className="flex flex-row-reverse items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex items-center gap-2 border border-te-accent bg-te-accent px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
            >
              {t("common:actions.done")}
            </button>
            <button
              type="button"
              disabled={!isCustom}
              onClick={onReset}
              className="mr-auto inline-flex items-center gap-2 border border-te-gray bg-te-surface px-4 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-light-gray transition-colors enabled:hover:border-te-accent enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t("ai.prompt_reset")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

type PolishTab = "prompt" | "scenarios";

function PolishSettingsDialog({
  open,
  onOpenChange,
  promptValue,
  isPromptCustom,
  onPromptChange,
  onPromptReset,
  scenarios,
  onScenariosChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  promptValue: string;
  isPromptCustom: boolean;
  onPromptChange: (v: string) => void;
  onPromptReset: () => void;
  scenarios: PolishScenario[] | null;
  onScenariosChange: (next: PolishScenario[] | null) => void;
}) {
  const { t } = useTranslation("settings");
  const [tab, setTab] = useState<PolishTab>("prompt");

  const tabs: { id: PolishTab; label: string }[] = [
    { id: "prompt", label: t("ai.polish_dialog_tab_prompt") },
    { id: "scenarios", label: t("ai.polish_dialog_tab_scenarios") },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton
        className="flex max-h-[88vh] w-[92vw] max-w-2xl flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-2xl"
      >
        <DialogHeader className="flex flex-row items-center gap-2 border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
          <Bot className="size-4 shrink-0 text-te-accent" aria-hidden />
          <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
            {t("ai.polish_dialog_title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("ai.polish_dialog_subtitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-5">
          <p className="font-sans text-xs leading-relaxed text-te-light-gray">
            {t("ai.polish_dialog_subtitle")}
          </p>

          <div className="flex items-center gap-px self-start border border-te-gray/60">
            {tabs.map((it) => {
              const active = it.id === tab;
              return (
                <button
                  key={it.id}
                  type="button"
                  onClick={() => setTab(it.id)}
                  className={cn(
                    "px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors",
                    active
                      ? "bg-te-accent text-te-bg"
                      : "bg-te-bg text-te-light-gray hover:text-te-fg",
                  )}
                >
                  {it.label}
                </button>
              );
            })}
          </div>

          {tab === "prompt" ? (
            <div>
              <div className="mb-1.5 flex items-end justify-between gap-3">
                <label className="block font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray">
                  {t("ai.polish_dialog_prompt_label")}
                </label>
                <button
                  type="button"
                  disabled={!isPromptCustom}
                  onClick={onPromptReset}
                  className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray transition-colors enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t("ai.prompt_reset")}
                </button>
              </div>
              <textarea
                value={promptValue}
                onChange={(e) => onPromptChange(e.target.value)}
                rows={14}
                className="w-full resize-y border border-te-gray/40 bg-te-surface px-3 py-2 font-mono text-xs leading-relaxed text-te-fg transition-colors focus:border-te-accent focus:outline-none"
              />
            </div>
          ) : (
            <PolishScenariosEditor
              scenarios={scenarios}
              onChange={onScenariosChange}
            />
          )}

          <div className="flex flex-row-reverse items-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="inline-flex items-center gap-2 border border-te-accent bg-te-accent px-5 py-2.5 font-mono text-xs uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
            >
              {t("common:actions.done")}
            </button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function PolishScenariosEditor({
  scenarios,
  onChange,
}: {
  scenarios: PolishScenario[] | null;
  onChange: (next: PolishScenario[] | null) => void;
}) {
  const { t } = useTranslation("settings");
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const lang = resolveLang(interfaceLang);
  const effective = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
  const isCustom = scenarios !== null;

  const updateAt = (idx: number, patch: Partial<PolishScenario>) => {
    const base = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
    const next = base.map((s, i) => (i === idx ? { ...s, ...patch } : s));
    onChange(next);
  };
  const removeAt = (idx: number) => {
    const base = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
    const next = base.filter((_, i) => i !== idx);
    onChange(next);
  };
  const addNew = () => {
    const base = scenarios ?? DEFAULT_POLISH_SCENARIOS[lang];
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `scn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const next: PolishScenario[] = [
      ...base,
      {
        id,
        name: t("ai.polish_scenario_default_name"),
        instruction: "",
      },
    ];
    onChange(next);
  };

  return (
    <div>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray">
            {t("ai.polish_scenarios_title")}
          </div>
          <div className="mt-1 font-sans text-xs text-te-light-gray/80">
            {t("ai.polish_scenarios_hint")}
          </div>
        </div>
        <button
          type="button"
          disabled={!isCustom}
          onClick={() => onChange(null)}
          className={cn(
            "font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors",
            "enabled:hover:text-te-accent disabled:cursor-not-allowed disabled:opacity-40",
          )}
        >
          {t("ai.prompt_reset")}
        </button>
      </div>

      {effective.length === 0 ? (
        <div className="border border-dashed border-te-gray/40 px-4 py-6 text-center font-mono text-xs text-te-light-gray">
          {t("ai.polish_scenarios_empty")}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {effective.map((s, idx) => (
            <div
              key={s.id}
              className="flex flex-col gap-2 border border-te-gray/40 bg-te-surface/50 px-3 py-3"
            >
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={s.name}
                  onChange={(e) => updateAt(idx, { name: e.target.value })}
                  className="flex-1 border border-te-gray/40 bg-te-surface px-3 py-1.5 font-mono text-sm text-te-fg outline-none transition-colors focus:border-te-accent"
                />
                <button
                  type="button"
                  onClick={() => removeAt(idx)}
                  className="inline-flex items-center gap-1 border border-te-gray/60 px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray transition-colors hover:border-red-400 hover:text-red-400"
                >
                  <Trash2 className="size-3" />
                  {t("ai.polish_scenario_remove")}
                </button>
              </div>
              <textarea
                value={s.instruction}
                onChange={(e) => updateAt(idx, { instruction: e.target.value })}
                rows={3}
                placeholder={t("ai.polish_scenario_instruction_placeholder") ?? ""}
                className="w-full resize-y border border-te-gray/40 bg-te-surface p-2 font-mono text-xs text-te-fg outline-none transition-colors focus:border-te-accent"
              />
            </div>
          ))}
        </div>
      )}

      <div className="mt-3">
        <button
          type="button"
          onClick={addNew}
          className="inline-flex items-center gap-2 border border-te-gray/60 px-4 py-2 font-mono text-xs uppercase tracking-[0.2em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          <Plus className="size-3.5" />
          {t("ai.polish_scenario_add")}
        </button>
      </div>
    </div>
  );
}

/// 顶层 host：根据 useUIStore.aiPromptDialog 渲染对应的 Dialog。
/// 放在 Layout（与 SettingsDialog 同级）确保打开时不会因为 SettingsDialog 关闭而被卸载。
export function AiPromptDialogHost() {
  const { t } = useTranslation("settings");
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const lang = resolveLang(interfaceLang);

  const aiPromptDialog = useUIStore((s) => s.aiPromptDialog);
  const closeAiPromptDialog = useUIStore((s) => s.closeAiPromptDialog);

  const aiRefine = useSettingsStore((s) => s.aiRefine);
  const setAiSystemPrompt = useSettingsStore((s) => s.setAiSystemPrompt);
  const setAiTranslationSystemPrompt = useSettingsStore(
    (s) => s.setAiTranslationSystemPrompt,
  );
  const setAiPolishSystemPrompt = useSettingsStore(
    (s) => s.setAiPolishSystemPrompt,
  );
  const setAiMeetingSummaryPrompt = useSettingsStore(
    (s) => s.setAiMeetingSummaryPrompt,
  );
  const setPolishScenarios = useSettingsStore((s) => s.setPolishScenarios);

  const handleClose = (open: boolean) => {
    if (!open) closeAiPromptDialog();
  };

  const refineDefault = DEFAULT_AI_SYSTEM_PROMPTS[lang];
  const translateDefault = DEFAULT_AI_TRANSLATION_SYSTEM_PROMPTS[lang];
  const polishDefault = DEFAULT_AI_POLISH_SYSTEM_PROMPTS[lang];
  const meetingDefault = DEFAULT_AI_MEETING_SUMMARY_PROMPTS[lang];

  return (
    <>
      <PromptEditDialog
        open={aiPromptDialog === "refine"}
        onOpenChange={handleClose}
        title={t("ai.prompt_dialog_title_refine")}
        description={t("ai.prompt_desc_refine")}
        value={aiRefine.customSystemPrompt ?? refineDefault}
        isCustom={aiRefine.customSystemPrompt !== null}
        onChange={(v) => void setAiSystemPrompt(v)}
        onReset={() => void setAiSystemPrompt(null)}
      />
      <PromptEditDialog
        open={aiPromptDialog === "translate"}
        onOpenChange={handleClose}
        title={t("ai.prompt_dialog_title_translate")}
        description={t("ai.prompt_desc_translate")}
        value={aiRefine.customTranslationSystemPrompt ?? translateDefault}
        isCustom={aiRefine.customTranslationSystemPrompt !== null}
        onChange={(v) => void setAiTranslationSystemPrompt(v)}
        onReset={() => void setAiTranslationSystemPrompt(null)}
      />
      <PromptEditDialog
        open={aiPromptDialog === "meeting"}
        onOpenChange={handleClose}
        title={t("ai.prompt_dialog_title_meeting")}
        description={t("ai.prompt_desc_meeting")}
        value={aiRefine.customMeetingSummaryPrompt ?? meetingDefault}
        isCustom={aiRefine.customMeetingSummaryPrompt !== null}
        onChange={(v) => void setAiMeetingSummaryPrompt(v)}
        onReset={() => void setAiMeetingSummaryPrompt(null)}
      />
      <PolishSettingsDialog
        open={aiPromptDialog === "polish"}
        onOpenChange={handleClose}
        promptValue={aiRefine.customPolishSystemPrompt ?? polishDefault}
        isPromptCustom={aiRefine.customPolishSystemPrompt !== null}
        onPromptChange={(v) => void setAiPolishSystemPrompt(v)}
        onPromptReset={() => void setAiPolishSystemPrompt(null)}
        scenarios={aiRefine.customPolishScenarios}
        onScenariosChange={(v) => void setPolishScenarios(v)}
      />
    </>
  );
}
