import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Trans, useTranslation } from "react-i18next";
import { ChevronDown, Plus, Settings2 } from "lucide-react";
import { HotkeyPreview } from "@/components/HotkeyPreview";
import { HotkeyBinder } from "@/components/HotkeyBinder";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { QuickDictDialog } from "@/components/QuickDictDialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useRecordingStore, type RecordingState } from "@/stores/recording";
import {
  useSettingsStore,
  type TranslateTargetLang,
} from "@/stores/settings";
import { useHistoryStore } from "@/stores/history";
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
  const latestHistoryItem = useHistoryStore((s) => s.items[0]);
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

  const [resultText, setResultText] = useState<string | null>(null);
  const [editOpen, setEditOpen] = useState(false);
  const [dictOpen, setDictOpen] = useState(false);
  const lastTranscriptRef = useRef("");
  const prevStateRef = useRef<RecordingState>("idle");

  const editBindingId: BindingId =
    hotkeyTab === "translate" ? "translate" : "dictate_ptt";

  useEffect(() => {
    if (liveTranscript) lastTranscriptRef.current = liveTranscript;
  }, [liveTranscript]);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = recState;
    if (prev === "idle" && recState !== "idle") {
      setResultText(null);
      lastTranscriptRef.current = "";
      return;
    }
    if (prev !== "idle" && recState === "idle") {
      const captured = lastTranscriptRef.current.trim();
      setResultText(captured ? lastTranscriptRef.current : null);
    }
  }, [recState]);

  // Result 模式 10s 自动关闭。下一轮录音通过上面 useEffect setResultText(null)
  // 触发 cleanup 提前清 timer，用户点 ✕ 同理。
  useEffect(() => {
    if (resultText === null) return;
    const id = window.setTimeout(() => setResultText(null), 10_000);
    return () => window.clearTimeout(id);
  }, [resultText]);

  const showResult = !isLive && resultText !== null;
  const showPanel = isLive || showResult;
  const panelTranscript = isLive ? liveTranscript : (resultText ?? "");
  // Result 模式下取最新一条 history（finalize 写入后 items[0] 即为本次结果）作为
  // 耗时统计来源——录音时长 + ASR 耗时 + AI refine 耗时。
  const resultStats = showResult
    ? {
        audioMs: latestHistoryItem?.duration_ms ?? null,
        asrMs: latestHistoryItem?.asr_ms ?? null,
        refineMs: latestHistoryItem?.refine_ms ?? null,
      }
    : null;
  // 翻译条目：把原文 / 译文分两组传给 panel 分组渲染。
  // refined_text 在翻译模式下只存译文（store 层已保证），text 是 ASR 原文。
  const resultParts =
    showResult && latestHistoryItem?.type === "translate"
      ? {
          raw: latestHistoryItem.text ?? "",
          translated: latestHistoryItem.refined_text ?? "",
          targetLang: latestHistoryItem.target_lang ?? null,
        }
      : null;

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
                onClose={showResult ? () => setResultText(null) : undefined}
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
    </motion.div>
  );
}
