import { useCallback, useEffect, useMemo, useState } from "react";
import { writeText as writeClipboard } from "@tauri-apps/plugin-clipboard-manager";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, Languages, Plus, Settings2, Sparkles } from "lucide-react";
import { HotkeyPreview } from "@/components/HotkeyPreview";
import { HotkeyBinder } from "@/components/HotkeyBinder";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { QuickDictDialog } from "@/components/QuickDictDialog";
import { HistoryEditDialog } from "@/components/HistoryEditDialog";
import { useHistoryStore } from "@/stores/history";
import { resolveLang } from "@/i18n";
import {
  DEFAULT_POLISH_SCENARIOS,
  type PolishScenario,
} from "@/lib/defaultAiPrompts";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useRecordingStore } from "@/stores/recording";
import {
  useSettingsStore,
  type TranslateTargetLang,
} from "@/stores/settings";
import { useDictationResultStore } from "@/stores/dictationResult";
import type { BindingId } from "@/lib/hotkey";

type HotkeyTab = "dictate" | "translate";

const TRANSLATE_LANGS: readonly TranslateTargetLang[] = [
  "en",
  "zh",
  "zh-TW",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
] as const;

export function HotkeyDictationCard({ bare = false }: { bare?: boolean } = {}) {
  const { t } = useTranslation();
  const [hotkeyTab, setHotkeyTab] = useState<HotkeyTab>("dictate");
  const recState = useRecordingStore((s) => s.state);
  const audioLevels = useRecordingStore((s) => s.audioLevels);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const escArmed = useRecordingStore((s) => s.escArmed);
  const errorMessage = useRecordingStore((s) => s.errorMessage);
  const activeBindingId = useRecordingStore((s) => s.activeId);
  const stickyResult = useDictationResultStore((s) => s.current);
  const stickyBusy = useDictationResultStore((s) => s.busy);
  const stickyStreamPartial = useDictationResultStore((s) => s.streamPartial);
  const clearStickyResult = useDictationResultStore((s) => s.clear);
  const runRefine = useDictationResultStore((s) => s.runRefine);
  const runTranslate = useDictationResultStore((s) => s.runTranslate);
  const liveHistoryItem = useHistoryStore((s) =>
    stickyResult ? s.items.find((it) => it.id === stickyResult.id) ?? null : null,
  );
  const editedOverride = liveHistoryItem?.text_edited ?? null;
  const segmentModeOverride = useRecordingStore((s) => s.segmentModeOverride);
  const settingsSegmentMode = useSettingsStore((s) => s.general.asrSegmentMode);
  const translateTargetLang = useSettingsStore(
    (s) => s.general.translateTargetLang,
  );
  const translateOutputMode = useSettingsStore(
    (s) => s.general.translateOutputMode,
  );
  const aiRefineEnabled = useSettingsStore((s) => s.aiRefine.enabled);
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const segmentMode = segmentModeOverride ?? settingsSegmentMode;
  const isLive = recState !== "idle";

  const [editOpen, setEditOpen] = useState(false);
  const [dictOpen, setDictOpen] = useState(false);
  const [historyEditOpen, setHistoryEditOpen] = useState(false);
  const handleHistoryEdit = useCallback(() => {
    if (liveHistoryItem) setHistoryEditOpen(true);
  }, [liveHistoryItem]);

  const editBindingId: BindingId =
    hotkeyTab === "translate" ? "translate" : "dictate_ptt";

  // 开始新录音时清掉旧结果；finalize 末尾由 recording store 推送新结果。
  useEffect(() => {
    if (recState !== "idle") clearStickyResult();
  }, [recState, clearStickyResult]);

  const showResult = !isLive && stickyResult !== null;
  const showPanel = isLive || showResult;
  const refineBusy = stickyBusy === "refine";
  const translateBusy = stickyBusy === "translate";
  const mainText =
    editedOverride ??
    stickyResult?.polishedText ??
    stickyResult?.refinedText ??
    stickyResult?.rawText ??
    "";
  const panelTranscript = isLive
    ? liveTranscript
    : refineBusy && stickyStreamPartial
      ? stickyStreamPartial
      : mainText;
  const resultStats = showResult
    ? {
        audioMs: stickyResult.audioMs,
        asrMs: stickyResult.asrMs,
        refineMs: stickyResult.refineMs,
      }
    : null;
  const showTranslation =
    showResult &&
    stickyResult !== null &&
    (translateBusy ||
      stickyResult.translatedText != null ||
      stickyResult.type === "translate");
  const resultParts =
    showTranslation && stickyResult
      ? {
          raw: stickyResult.type === "translate" ? stickyResult.rawText : mainText,
          translated: translateBusy
            ? stickyStreamPartial
            : stickyResult.translatedText ?? stickyResult.refinedText ?? "",
          targetLang: stickyResult.targetLang,
        }
      : null;
  const copyText = stickyResult?.translatedText ?? mainText;
  const handleCopy = useCallback(async () => {
    if (!copyText) return;
    await writeClipboard(copyText);
  }, [copyText]);
  const customPolishScenarios = useSettingsStore(
    (s) => s.aiRefine.customPolishScenarios,
  );
  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const polishScenarios = useMemo<PolishScenario[]>(
    () =>
      customPolishScenarios ??
      DEFAULT_POLISH_SCENARIOS[resolveLang(interfaceLang)],
    [customPolishScenarios, interfaceLang],
  );
  const [polishScenarioId, setPolishScenarioId] = useState<string | null>(
    polishScenarios[0]?.id ?? null,
  );
  useEffect(() => {
    if (
      polishScenarioId === null ||
      !polishScenarios.some((s) => s.id === polishScenarioId)
    ) {
      setPolishScenarioId(polishScenarios[0]?.id ?? null);
    }
  }, [polishScenarios, polishScenarioId]);

  const activeScenario = useMemo(
    () => polishScenarios.find((s) => s.id === polishScenarioId) ?? null,
    [polishScenarios, polishScenarioId],
  );
  const refineLabel = useMemo(() => {
    const base = t("overlay:panel.action.refine");
    return activeScenario ? `${base} · ${activeScenario.name}` : base;
  }, [activeScenario, t]);
  const handleRefine = useCallback(() => {
    void runRefine(polishScenarioId);
  }, [runRefine, polishScenarioId]);

  const refineSlot = (
    <div className="inline-flex">
      <button
        type="button"
        onClick={handleRefine}
        disabled={refineBusy}
        aria-label={t("overlay:panel.action.refine")}
        className={cn(
          "inline-flex items-center gap-2 border border-r-0 px-3 py-2 font-mono text-xs uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-te-accent",
          refineBusy
            ? "border-te-accent/60 bg-te-surface text-te-accent animate-pulse"
            : "border-te-accent/70 bg-te-surface text-te-accent hover:bg-te-accent hover:text-te-bg",
        )}
      >
        <Sparkles className="size-3.5" aria-hidden />
        {refineBusy ? t("overlay:panel.action.refining") : refineLabel}
      </button>
      <Menu.Root>
        <Menu.Trigger
          disabled={refineBusy || polishScenarios.length === 0}
          aria-label={t("overlay:panel.refine_scenario.menu_aria")}
          className={cn(
            "inline-flex items-center justify-center border px-2 py-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-te-accent",
            refineBusy
              ? "border-te-accent/60 bg-te-surface text-te-accent"
              : "border-te-accent/70 bg-te-surface text-te-accent hover:bg-te-accent hover:text-te-bg",
          )}
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="end" className="z-50">
            <Menu.Popup className="min-w-[160px] border border-te-gray/60 bg-te-bg shadow-lg outline-none">
              {polishScenarios.map((s) => {
                const active = s.id === polishScenarioId;
                return (
                  <Menu.Item
                    key={s.id}
                    onClick={() => setPolishScenarioId(s.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between gap-3 px-2.5 py-1.5 text-left font-mono text-[11px] uppercase tracking-[0.16em] transition-colors outline-none",
                      active
                        ? "bg-te-surface text-te-accent"
                        : "text-te-fg data-[highlighted]:bg-te-surface-hover",
                    )}
                  >
                    <span>{s.name}</span>
                    {active ? <Check className="size-3" aria-hidden /> : null}
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );

  const targetLang = useSettingsStore((s) => s.general.translateTargetLang);
  const handleTranslate = useCallback(() => {
    void runTranslate();
  }, [runTranslate]);
  const translateLabel = useMemo(() => {
    const base = t("overlay:panel.action.translate");
    const langName = t(`overlay:translate.lang.${targetLang}`, {
      defaultValue: targetLang,
    });
    return `${base} · ${langName}`;
  }, [t, targetLang]);

  const translateSlot = (
    <div className="inline-flex">
      <button
        type="button"
        onClick={handleTranslate}
        disabled={translateBusy}
        aria-label={t("overlay:panel.action.translate")}
        className={cn(
          "inline-flex items-center gap-2 border border-r-0 px-3 py-2 font-mono text-xs uppercase tracking-widest transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-te-accent",
          translateBusy
            ? "border-te-accent/60 bg-te-surface text-te-accent animate-pulse"
            : "border-te-accent/70 bg-te-surface text-te-accent hover:bg-te-accent hover:text-te-bg",
        )}
      >
        <Languages className="size-3.5" aria-hidden />
        {translateBusy
          ? t("overlay:panel.action.translating")
          : translateLabel}
      </button>
      <Menu.Root>
        <Menu.Trigger
          disabled={translateBusy}
          aria-label={t("overlay:panel.translate_lang.menu_aria")}
          className={cn(
            "inline-flex items-center justify-center border px-2 py-2 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-te-accent",
            translateBusy
              ? "border-te-accent/60 bg-te-surface text-te-accent"
              : "border-te-accent/70 bg-te-surface text-te-accent hover:bg-te-accent hover:text-te-bg",
          )}
        >
          <ChevronDown className="size-3.5" aria-hidden />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="end" className="z-50">
            <Menu.Popup className="min-w-[160px] border border-te-gray/60 bg-te-bg shadow-lg outline-none">
              {TRANSLATE_LANGS.map((lang) => {
                const active = lang === targetLang;
                return (
                  <Menu.Item
                    key={lang}
                    onClick={() =>
                      void setGeneral("translateTargetLang", lang)
                    }
                    className={cn(
                      "flex w-full cursor-pointer items-center justify-between gap-3 px-2.5 py-1.5 text-left font-mono text-[11px] uppercase tracking-[0.16em] transition-colors outline-none",
                      active
                        ? "bg-te-surface text-te-accent"
                        : "text-te-fg data-[highlighted]:bg-te-surface-hover",
                    )}
                  >
                    <span>
                      {t(`overlay:translate.lang.${lang}`, {
                        defaultValue: lang,
                      })}
                    </span>
                    {active ? <Check className="size-3" aria-hidden /> : null}
                  </Menu.Item>
                );
              })}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );

  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true }}
      transition={{ duration: 0.4, delay: 0.03 }}
      className={cn(
        "flex min-h-0 w-full flex-col",
        bare && "flex-1",
      )}
    >
      {!showPanel && (
        <>
          <div className="mb-2 flex shrink-0 items-end justify-between md:mb-3">
            <h2 className="font-mono text-base font-bold uppercase tracking-tighter text-te-fg md:text-lg">
              {t(`pages:home.hotkey_title.${hotkeyTab}`)}
            </h2>
            <div
              className="flex shrink-0 border border-te-gray/60 bg-te-surface font-mono text-[10px] uppercase tracking-widest"
              role="tablist"
            >
              {(["translate", "dictate"] as const).map((tab) => {
                const active = hotkeyTab === tab;
                return (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={active}
                    onClick={() => setHotkeyTab(tab)}
                    className={
                      active
                        ? "px-2.5 py-1 bg-te-accent text-te-bg"
                        : "px-2.5 py-1 text-te-light-gray hover:text-te-fg"
                    }
                  >
                    {t(`pages:home.hotkey_tab.${tab}`)}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="mb-2 flex shrink-0 flex-wrap items-center gap-1.5 md:mb-3">
            {hotkeyTab === "translate" ? (
              <>
                <div className="relative inline-flex items-center border border-te-gray/60 bg-te-surface transition-colors hover:border-te-accent focus-within:border-te-accent">
                  <select
                    value={translateTargetLang}
                    onChange={(e) =>
                      void setGeneral(
                        "translateTargetLang",
                        e.target.value as TranslateTargetLang,
                      )
                    }
                    aria-label={t("overlay:translate.mode_label")}
                    className="cursor-pointer appearance-none bg-transparent py-0.5 pr-6 pl-2 font-mono text-[10px] uppercase tracking-widest text-te-fg focus:outline-none md:text-xs"
                  >
                    {TRANSLATE_LANGS.map((lang) => (
                      <option key={lang} value={lang}>
                        {t(`overlay:translate.lang.${lang}`, {
                          defaultValue: lang,
                        })}
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-1.5 size-3 text-te-light-gray" />
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={translateOutputMode === "bilingual"}
                  aria-label={t("pages:home.translate_bilingual_aria")}
                  onClick={() =>
                    void setGeneral(
                      "translateOutputMode",
                      translateOutputMode === "bilingual"
                        ? "target_only"
                        : "bilingual",
                    )
                  }
                  className={cn(
                    "border px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest transition-colors md:text-xs",
                    translateOutputMode === "bilingual"
                      ? "border-te-accent bg-te-accent text-te-bg"
                      : "border-te-gray/60 text-te-light-gray hover:border-te-accent hover:text-te-accent",
                  )}
                >
                  {t("pages:home.translate_bilingual")}
                </button>
              </>
            ) : (
              <>
                <span className="border border-te-gray/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
                  {t(
                    settingsSegmentMode === "UTTERANCE"
                      ? "overlay:panel.mode_segment.utterance"
                      : "overlay:panel.mode_segment.realtime",
                  )}
                </span>
                <span className="border border-te-gray/60 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest text-te-light-gray md:text-xs">
                  {t(
                    aiRefineEnabled
                      ? "overlay:panel.dictate_status.ai_on"
                      : "overlay:panel.dictate_status.ai_off",
                  )}
                </span>
              </>
            )}
          </div>
        </>
      )}

      <div
        className={cn(
          "flex min-h-0 flex-1 flex-col overflow-hidden transition-colors",
          bare
            ? "p-3"
            : cn(
                "border bg-te-surface p-4 md:p-5",
                isLive ? "border-te-accent/80" : "border-te-gray/60",
              ),
        )}
      >
        <AnimatePresence mode="wait" initial={false}>
          {showPanel ? (
            <motion.div
              key="live"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <LiveDictationPanel
                state={recState}
                audioLevels={audioLevels}
                liveTranscript={panelTranscript}
                segmentMode={segmentMode}
                escArmed={escArmed}
                activeBindingId={activeBindingId}
                resultStats={resultStats}
                resultParts={resultParts}
                errorMessage={errorMessage}
                onClose={showResult ? clearStickyResult : undefined}
                onCopy={showResult && copyText ? handleCopy : undefined}
                onEdit={showResult && liveHistoryItem ? handleHistoryEdit : undefined}
                onRefine={showResult ? handleRefine : undefined}
                refineBusy={refineBusy}
                refineSlot={showResult ? refineSlot : undefined}
                translateSlot={showResult ? translateSlot : undefined}
              />
            </motion.div>
          ) : (
            <motion.div
              key="preview"
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="flex min-h-0 flex-1 flex-col"
            >
              <HotkeyPreview
                fillHeight
                hideHeader
                swapToActivatorWhenUnfocused
                bindingIds={[editBindingId]}
                trailing={
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => setDictOpen(true)}
                      aria-label={t("pages:home.quick_dict.button_aria")}
                      title={t("pages:home.quick_dict.button_aria")}
                      className="inline-flex size-8 items-center justify-center border border-te-gray/60 bg-te-surface text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent focus:outline-none focus-visible:border-te-accent"
                    >
                      <Plus className="size-4" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditOpen(true)}
                      aria-label={t("pages:home.edit_hotkey")}
                      title={t("pages:home.edit_hotkey")}
                      className="inline-flex size-8 items-center justify-center border border-te-gray/60 bg-te-surface text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent focus:outline-none focus-visible:border-te-accent"
                    >
                      <Settings2 className="size-4" aria-hidden />
                    </button>
                  </div>
                }
              />
              <p className="mt-3 max-w-2xl shrink-0 font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
                <Trans
                  i18nKey={
                    hotkeyTab === "translate"
                      ? "pages:home.translate_hint"
                      : "pages:home.hotkey_hint"
                  }
                  components={{
                    esc: <span className="mx-1 font-mono text-te-fg" />,
                  }}
                />
              </p>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <Dialog
        open={editOpen}
        onOpenChange={(next, details) => {
          // ESC 必须留给 HotkeyBinder 退出录入态——base-ui useDismiss 默认 ESC=close
          // 会抢在 binder capture listener 前关 dialog（用户主诉：按 ESC 直接关掉编辑面板）。
          if (!next && details?.reason === "escape-key") {
            details.cancel();
            return;
          }
          setEditOpen(next);
        }}
      >
        <DialogContent
          showCloseButton
          className="flex w-[92vw] max-w-md flex-col !gap-0 rounded-none border border-te-dialog-border bg-te-dialog-bg p-0 shadow-2xl ring-0 sm:max-w-md"
        >
          <DialogHeader className="border-b border-te-dialog-border bg-te-surface-hover px-5 py-4">
            <DialogTitle className="font-mono text-base font-bold tracking-tighter text-te-fg">
              {t("pages:home.edit_hotkey_dialog_title")}
            </DialogTitle>
            <DialogDescription className="sr-only">
              {t("pages:home.edit_hotkey_dialog_description")}
            </DialogDescription>
          </DialogHeader>
          <div className="px-5 py-2">
            <HotkeyBinder
              filterIds={[editBindingId]}
              divided={false}
              size="comfortable"
            />
          </div>
        </DialogContent>
      </Dialog>

      <QuickDictDialog open={dictOpen} onOpenChange={setDictOpen} />

      {liveHistoryItem ? (
        <HistoryEditDialog
          open={historyEditOpen}
          onOpenChange={setHistoryEditOpen}
          item={liveHistoryItem}
        />
      ) : null}
    </motion.div>
  );
}
