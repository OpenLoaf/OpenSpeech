import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  Clipboard,
  ClipboardCheck,
  Copy,
  CornerUpLeft,
  Download,
  History as HistoryIcon,
  Languages,
  RotateCcw,
  Sparkles,
  Trash2,
  Volume2,
  Wand2,
  X,
} from "lucide-react";
import { readText as readClipboardText } from "@tauri-apps/plugin-clipboard-manager";
import { cn } from "@/lib/utils";
import { useHistoryStore } from "@/stores/history";
import { useRecordingStore, type RecordingState } from "@/stores/recording";
import { useHotkeysStore } from "@/stores/hotkeys";
import { Kbd, tokensFromBinding } from "@/components/HotkeyPreview";
import { LiveDictationPanel } from "@/components/LiveDictationPanel";
import { detectPlatform } from "@/lib/platform";
import type { BindingId } from "@/lib/hotkey";
import {
  useSettingsStore,
  DEFAULT_POLISH_SCENARIOS,
  getEffectiveAiTranslationSystemPrompt,
  getEffectiveAiPolishSystemPrompt,
  type PolishScenario,
  type TranslateTargetLang,
} from "@/stores/settings";
import { resolveLang } from "@/i18n";
import { refineTextViaChatStream, isSaasAuthError } from "@/lib/ai-refine";
import { handleAiRefineCustomFailure } from "@/lib/ai-refine-fallback";
import { useAuthStore } from "@/stores/auth";
import { useUIStore } from "@/stores/ui";

type ToolKey = "translate" | "polish" | "tts";

const TRANSLATE_LANGS: TranslateTargetLang[] = [
  "en",
  "zh",
  "zh-TW",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
];
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
const TTS_VOICES = ["natural_f", "natural_m", "calm_f"] as const;
const TTS_SPEEDS = [0.8, 1.0, 1.25, 1.5] as const;

const AUTO_RUN_DEBOUNCE_MS = 800;

type ToolStatus =
  | { kind: "idle" }
  | { kind: "running"; partial: string }
  | { kind: "done"; result: string }
  | { kind: "error"; message: string };

type RunMeta = { tool: ToolKey; durationMs: number; chars: number };

// 事件 handler 同步流里 setState 后立即调用 runImmediate，stateRef.current 还没更新
// （render body 同步赋值的镜像在下次 render 后才生效）。所以改 text / 参数后第一次跑
// 必须把新值通过这里直接传过去，避免 runTool 读到上一拍的 stateRef。
type RunOverrides = {
  text?: string;
  targetLang?: TranslateTargetLang;
  polishScenarioId?: string;
};

const ICON_BTN =
  "inline-flex h-8 items-center gap-1.5 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-te-light-gray transition-colors hover:text-te-fg disabled:opacity-40 disabled:hover:text-te-light-gray";

const CHIP_TRIGGER =
  "inline-flex h-7 items-center gap-1.5 border border-te-gray/50 bg-te-bg px-2 font-mono text-[11px] uppercase tracking-[0.18em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent";

function useClickOutside<T extends HTMLElement>(
  open: boolean,
  onClose: () => void,
) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

type DropdownProps<T extends string | number> = {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  align?: "left" | "right";
};

function ChipDropdown<T extends string | number>({
  value,
  options,
  onChange,
  align = "left",
}: DropdownProps<T>) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(open, () => setOpen(false));
  const current = options.find((o) => o.value === value);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={CHIP_TRIGGER}
      >
        <span className="tabular-nums">{current?.label ?? "—"}</span>
        <ChevronDown className="size-3 opacity-70" />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className={cn(
              "absolute top-full z-30 mt-1 min-w-[10rem] border border-te-gray/60 bg-te-bg shadow-lg",
              align === "right" ? "right-0" : "left-0",
            )}
          >
            <ul className="flex flex-col">
              {options.map((o) => {
                const active = o.value === value;
                return (
                  <li key={String(o.value)}>
                    <button
                      type="button"
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                      className={cn(
                        "flex w-full items-center justify-between gap-3 px-2.5 py-1.5 text-left font-mono text-[11px] uppercase tracking-[0.16em] transition-colors",
                        active
                          ? "bg-te-surface text-te-accent"
                          : "text-te-fg hover:bg-te-surface-hover",
                      )}
                    >
                      <span className="tabular-nums">{o.label}</span>
                      {active ? <Check className="size-3" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function HistoryPopover({
  onPick,
  onClose,
  align = "left",
}: {
  onPick: (text: string) => void;
  onClose: () => void;
  align?: "left" | "right";
}) {
  const { t } = useTranslation();
  const items = useHistoryStore((s) => s.items);
  const usable = items
    .filter((it) => it.status === "success" && it.text.trim().length > 0)
    .slice(0, 30);
  return (
    <div
      className={cn(
        "absolute top-full z-30 mt-1 max-h-72 w-80 overflow-y-auto border border-te-gray/60 bg-te-bg shadow-lg",
        align === "right" ? "right-0" : "left-0",
      )}
    >
      {usable.length === 0 ? (
        <div className="px-3 py-6 text-center font-mono text-[11px] uppercase tracking-[0.18em] text-te-light-gray">
          {t("pages:toolbox.input.history_empty")}
        </div>
      ) : (
        <ul className="divide-y divide-te-gray/20">
          {usable.map((h) => {
            const display = h.refined_text?.trim() || h.text;
            const ts = new Date(h.created_at);
            const sameDay = new Date().toDateString() === ts.toDateString();
            const label = sameDay
              ? `${String(ts.getHours()).padStart(2, "0")}:${String(ts.getMinutes()).padStart(2, "0")}`
              : `${String(ts.getMonth() + 1).padStart(2, "0")}/${String(ts.getDate()).padStart(2, "0")}`;
            return (
              <li key={h.id}>
                <button
                  type="button"
                  onClick={() => {
                    onPick(display);
                    onClose();
                  }}
                  className="flex w-full items-start gap-3 px-3 py-2 text-left transition-colors hover:bg-te-surface-hover"
                >
                  <span className="w-10 shrink-0 font-mono text-[10px] uppercase tracking-widest text-te-light-gray tabular-nums">
                    {label}
                  </span>
                  <span className="flex-1 line-clamp-2 font-mono text-[12px] text-te-fg">
                    {display}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

type InputCardProps = {
  text: string;
  onTextInput: (s: string) => void;
  onTextFill: (s: string, options: { autoRun: boolean }) => void;
  hasText: boolean;
  onClear: () => void;
  revertSnapshot: string | null;
  onRevert: () => void;
  doPaste: () => Promise<void>;
  clipboardPreview: string | null;
  onAcceptClipboard: (autoRun: boolean) => void;
  onDismissClipboard: () => void;
};

function InputCard({
  text,
  onTextInput,
  onTextFill,
  hasText,
  onClear,
  revertSnapshot,
  onRevert,
  doPaste,
  clipboardPreview,
  onAcceptClipboard,
  onDismissClipboard,
}: InputCardProps) {
  const { t } = useTranslation();
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyRef = useClickOutside<HTMLDivElement>(historyOpen, () =>
    setHistoryOpen(false),
  );
  const [pasted, setPasted] = useState(false);
  const [hasPasteable, setHasPasteable] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const refocusTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const len = el.value.length;
    try {
      el.setSelectionRange(len, len);
    } catch {}
  }, []);
  const recState = useRecordingStore((s) => s.state);
  const audioLevels = useRecordingStore((s) => s.audioLevels);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const escArmed = useRecordingStore((s) => s.escArmed);
  const activeBindingId = useRecordingStore((s) => s.activeId);
  const segmentModeOverride = useRecordingStore((s) => s.segmentModeOverride);
  const settingsSegmentMode = useSettingsStore((s) => s.general.asrSegmentMode);
  const segmentMode = segmentModeOverride ?? settingsSegmentMode;
  const errorMessage = useRecordingStore((s) => s.errorMessage);
  const isLive = recState !== "idle";
  // mount 时（recState===idle）+ 录音结束切回 idle 时都跑一次。textarea 在 isLive 时
  // 不渲染，所以这里只负责 idle 状态下保证光标在 textarea 内。
  useEffect(() => {
    if (recState === "idle") refocusTextarea();
  }, [recState, refocusTextarea]);

  useEffect(() => {
    let alive = true;
    const check = async () => {
      try {
        const txt = (await readClipboardText())?.trim() ?? "";
        if (alive) setHasPasteable(txt.length > 0);
      } catch {
        if (alive) setHasPasteable(false);
      }
    };
    void check();
    const onRefocus = () => void check();
    window.addEventListener("focus", onRefocus);
    document.addEventListener("visibilitychange", onRefocus);
    return () => {
      alive = false;
      window.removeEventListener("focus", onRefocus);
      document.removeEventListener("visibilitychange", onRefocus);
    };
  }, []);

  const handlePaste = async () => {
    await doPaste();
    setPasted(true);
    setHasPasteable(true);
    window.setTimeout(() => setPasted(false), 800);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-te-bg">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-te-gray/30 bg-te-bg/40 px-3">
        <div className="relative" ref={historyRef}>
          <button
            type="button"
            onClick={() => setHistoryOpen((v) => !v)}
            className={ICON_BTN}
          >
            <HistoryIcon className="size-3.5" />
            <span>{t("pages:toolbox.input.history")}</span>
            <ChevronDown className="size-2.5 opacity-70" />
          </button>
          <AnimatePresence>
            {historyOpen ? (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.12 }}
              >
                <HistoryPopover
                  onPick={(value) => onTextFill(value, { autoRun: true })}
                  onClose={() => setHistoryOpen(false)}
                  align="left"
                />
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={onClear}
            disabled={!hasText}
            className={ICON_BTN}
          >
            <Trash2 className="size-3.5" />
            <span>{t("pages:toolbox.input.clear")}</span>
          </button>
          <button
            type="button"
            onClick={handlePaste}
            disabled={!hasPasteable}
            className={cn(ICON_BTN, pasted && "text-te-accent")}
          >
            {pasted ? (
              <ClipboardCheck className="size-3.5" />
            ) : (
              <Clipboard className="size-3.5" />
            )}
            <span>{t("pages:toolbox.input.paste")}</span>
          </button>
        </div>
      </div>

      {revertSnapshot !== null ? (
        <button
          type="button"
          onClick={onRevert}
          className="flex shrink-0 items-center justify-between gap-2 border-b border-te-accent/30 bg-te-accent/[0.06] px-3 py-1 text-left transition-colors hover:bg-te-accent/[0.12]"
        >
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.22em] text-te-accent/90">
            <span className="inline-block size-1.5 bg-te-accent" />
            {t("pages:toolbox.input.replaced_hint")}
          </span>
          <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-te-accent">
            <CornerUpLeft className="size-3" />
            {t("pages:toolbox.input.restore_original")}
          </span>
        </button>
      ) : null}

      <AnimatePresence>
        {clipboardPreview && !hasText ? (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden border-b border-te-accent/40 bg-te-accent/[0.04]"
          >
            <div className="flex items-start gap-2 px-3 py-2">
              <Clipboard className="mt-0.5 size-3.5 shrink-0 text-te-accent" />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-[10px] uppercase tracking-[0.22em] text-te-accent">
                  {t("pages:toolbox.input.clipboard_detected")}
                </p>
                <p className="mt-1 line-clamp-2 font-mono text-[12px] text-te-fg/90">
                  {clipboardPreview}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-1">
                  <button
                    type="button"
                    onClick={() => onAcceptClipboard(true)}
                    className="inline-flex h-6 items-center gap-1 bg-te-accent px-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-te-bg transition-opacity hover:opacity-90"
                  >
                    <Languages className="size-3" />
                    {t("pages:toolbox.input.clipboard_translate")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAcceptClipboard(false)}
                    className="inline-flex h-6 items-center border border-te-gray/50 bg-te-bg px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
                  >
                    {t("pages:toolbox.input.clipboard_fill_only")}
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={onDismissClipboard}
                className="shrink-0 p-0.5 text-te-light-gray transition-colors hover:text-te-fg"
                aria-label="dismiss"
              >
                <X className="size-3.5" />
              </button>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {isLive ? (
          <div className="flex min-h-0 flex-1 flex-col px-4 py-3">
            <LiveDictationPanel
              state={recState}
              audioLevels={audioLevels}
              liveTranscript={liveTranscript}
              segmentMode={segmentMode}
              escArmed={escArmed}
              activeBindingId={activeBindingId}
              errorMessage={errorMessage}
              stack
              hideActions
            />
          </div>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              value={text}
              onChange={(e) => onTextInput(e.target.value)}
              placeholder={t("pages:toolbox.input.text_placeholder")}
              className="min-h-0 w-full flex-1 resize-none bg-te-bg px-4 py-3 font-mono text-base leading-relaxed text-te-fg/90 outline-none transition-colors placeholder:text-te-light-gray/40 focus:bg-te-surface/40 focus:text-te-fg"
            />
            {!hasText && !clipboardPreview ? <DictateHint /> : null}
          </>
        )}
      </div>
    </div>
  );
}

function RecordingActionsCard() {
  const { t } = useTranslation();
  const escArmed = useRecordingStore((s) => s.escArmed);
  const activeBindingId = useRecordingStore((s) => s.activeId);
  const isTranslate = activeBindingId === "translate";
  const activeKey: BindingId = isTranslate ? "translate" : "dictate_ptt";
  const activeBinding = useHotkeysStore((s) => s.bindings[activeKey]);
  const platform = detectPlatform();
  const activeTokens = useMemo(
    () => tokensFromBinding(activeBinding, platform),
    [activeBinding, platform],
  );
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center bg-te-surface px-6">
      <div
        className={cn(
          "absolute right-3 top-3 flex items-center gap-2",
          escArmed && "animate-pulse",
        )}
      >
        <Kbd highlight={escArmed}>{t("overlay:panel.action.kbd_esc")}</Kbd>
        <span
          className={cn(
            "font-mono text-[10px] uppercase tracking-widest",
            escArmed ? "text-te-accent" : "text-te-light-gray",
          )}
        >
          {escArmed
            ? t("overlay:toast.esc_arm.title")
            : t("overlay:panel.action.cancel")}
        </span>
      </div>
      <div className="flex flex-col items-center gap-3">
        <div className="flex items-center gap-1.5">
          {activeTokens.map((tok, i) => (
            <Fragment key={i}>
              {i > 0 ? (
                <span className="font-mono text-[10px] text-te-light-gray">
                  +
                </span>
              ) : null}
              <Kbd highlight>
                {tok.kind !== "prefix" && tok.icon ? (
                  <span aria-hidden className="mr-1 opacity-60">
                    {tok.icon}
                  </span>
                ) : null}
                {tok.label}
              </Kbd>
            </Fragment>
          ))}
        </div>
        <span className="font-mono text-[10px] uppercase tracking-widest text-te-accent md:text-xs">
          {t(
            isTranslate
              ? "overlay:panel.action.stop_translate"
              : "overlay:panel.action.stop",
          )}
        </span>
      </div>
    </div>
  );
}

function DictateHint() {
  const { t } = useTranslation();
  const platform = detectPlatform();
  const binding = useHotkeysStore((s) => s.bindings["dictate_ptt"]);
  const tokens = useMemo(
    () => tokensFromBinding(binding, platform),
    [binding, platform],
  );
  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-6 flex justify-center">
      <div className="flex items-center gap-2.5 font-mono text-[10px] uppercase tracking-[0.22em] text-te-light-gray/60">
        <span className="flex items-center gap-1.5">
          {tokens.length === 0 ? (
            <span>{t("pages:toolbox.input.dictate_unbound")}</span>
          ) : (
            tokens.map((tok, i) => (
              <Fragment key={i}>
                {i > 0 ? (
                  <span className="text-te-light-gray/40">+</span>
                ) : null}
                <Kbd>{tok.label}</Kbd>
              </Fragment>
            ))
          )}
        </span>
        <span>{t("pages:toolbox.input.dictate_hint")}</span>
      </div>
    </div>
  );
}

type ToolTabsProps = {
  tool: ToolKey;
  onChange: (tool: ToolKey) => void;
};

function ToolTabs({ tool, onChange }: ToolTabsProps) {
  const { t } = useTranslation();
  const items: { key: ToolKey; icon: typeof Languages }[] = [
    { key: "translate", icon: Languages },
    { key: "polish", icon: Wand2 },
    { key: "tts", icon: Volume2 },
  ];
  return (
    <div className="flex shrink-0 items-stretch gap-px self-end border border-te-gray/40 bg-te-gray/40">
      {items.map(({ key, icon: Icon }) => {
        const active = tool === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 px-3 font-mono text-[10px] uppercase tracking-[0.22em] transition-colors",
              active
                ? "bg-te-accent text-te-bg"
                : "bg-te-bg text-te-light-gray hover:bg-te-surface-hover hover:text-te-fg",
            )}
          >
            <Icon className="size-3.5" />
            <span>{t(`pages:toolbox.tools.tabs.${key}`)}</span>
          </button>
        );
      })}
    </div>
  );
}

type OutputCardProps = {
  status: ToolStatus;
  activeTool: ToolKey;
  hasText: boolean;
  targetLang: TranslateTargetLang;
  setTargetLang: (l: TranslateTargetLang) => void;
  polishScenarios: PolishScenario[];
  polishScenarioId: string | null;
  setPolishScenarioId: (id: string) => void;
  voice: (typeof TTS_VOICES)[number];
  setVoice: (v: (typeof TTS_VOICES)[number]) => void;
  speed: (typeof TTS_SPEEDS)[number];
  setSpeed: (s: (typeof TTS_SPEEDS)[number]) => void;
  runMeta: RunMeta | null;
  onRerun: () => void;
  onUseAsInput: () => void;
};

function OutputCard({
  status,
  activeTool,
  hasText,
  targetLang,
  setTargetLang,
  polishScenarios,
  polishScenarioId,
  setPolishScenarioId,
  voice,
  setVoice,
  speed,
  setSpeed,
  runMeta,
  onRerun,
  onUseAsInput,
}: OutputCardProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const recState = useRecordingStore((s) => s.state);

  const outputText =
    status.kind === "done"
      ? status.result
      : status.kind === "running"
        ? status.partial
        : "";

  const copy = async () => {
    if (!outputText) return;
    try {
      await navigator.clipboard.writeText(outputText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      /* ignore */
    }
  };

  const running = status.kind === "running";
  const isTtsDone = activeTool === "tts" && status.kind === "done";

  const paramRow = (() => {
    if (activeTool === "translate") {
      return (
        <ChipDropdown<TranslateTargetLang>
          value={targetLang}
          onChange={setTargetLang}
          options={TRANSLATE_LANGS.map((l) => ({
            value: l,
            label: t(`pages:toolbox.tools.translate.languages.${l}`),
          }))}
        />
      );
    }
    if (activeTool === "polish") {
      if (polishScenarios.length === 0) {
        return (
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray/60">
            {t("pages:toolbox.tools.polish.scenarios_empty")}
          </span>
        );
      }
      return (
        <ChipDropdown<string>
          value={polishScenarioId ?? polishScenarios[0]!.id}
          onChange={setPolishScenarioId}
          options={polishScenarios.map((s) => ({
            value: s.id,
            label: s.name,
          }))}
        />
      );
    }
    return (
      <div className="flex items-center gap-1">
        <ChipDropdown<(typeof TTS_VOICES)[number]>
          value={voice}
          onChange={setVoice}
          options={TTS_VOICES.map((v) => ({
            value: v,
            label: t(`pages:toolbox.tools.tts.voices.${v}`),
          }))}
        />
        <ChipDropdown<(typeof TTS_SPEEDS)[number]>
          value={speed}
          onChange={setSpeed}
          options={TTS_SPEEDS.map((s) => ({
            value: s,
            label: `${s.toFixed(2)}×`,
          }))}
        />
      </div>
    );
  })();

  if (recState !== "idle") return <RecordingActionsCard />;

  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-te-surface">
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-te-gray/30 bg-te-bg/40 px-3">
        <div className="flex items-center gap-2">{paramRow}</div>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={copy}
            disabled={!outputText || running}
            className={cn(ICON_BTN, copied && "text-te-accent")}
          >
            {copied ? (
              <ClipboardCheck className="size-3.5" />
            ) : (
              <Copy className="size-3.5" />
            )}
            <span>{t("pages:toolbox.tools.copy")}</span>
          </button>
          <button
            type="button"
            onClick={onRerun}
            disabled={!hasText || running}
            className={ICON_BTN}
          >
            <RotateCcw className="size-3.5" />
            <span>{t("pages:toolbox.tools.rerun")}</span>
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {!hasText ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-te-light-gray/50">
              {t("pages:toolbox.output.ready")}
            </p>
          </div>
        ) : status.kind === "error" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-red-500/[0.04] px-4 py-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-red-400">
              {t("pages:toolbox.tools.error_title")}
            </p>
            <p className="max-w-md text-center font-mono text-[12px] leading-relaxed text-te-light-gray break-words">
              {status.message}
            </p>
            <button
              type="button"
              onClick={onRerun}
              className="inline-flex items-center gap-2 border border-te-gray/50 bg-te-bg px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.22em] text-te-fg hover:border-te-accent hover:text-te-accent"
            >
              <RotateCcw className="size-3" />
              {t("pages:toolbox.tools.rerun")}
            </button>
          </div>
        ) : isTtsDone ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6">
            <div className="flex h-12 w-full max-w-sm items-center justify-center border border-te-accent bg-te-bg font-mono text-[11px] tracking-wider text-te-fg">
              {t("pages:toolbox.tools.tts.audio_placeholder")}
            </div>
            <button
              type="button"
              className="inline-flex items-center gap-1.5 border border-te-gray/50 bg-te-bg px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-te-fg hover:border-te-accent hover:text-te-accent"
            >
              <Download className="size-3" />
              {t("pages:toolbox.tools.download")}
            </button>
          </div>
        ) : status.kind === "idle" ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-te-light-gray/50">
              {t("pages:toolbox.output.waiting_input")}
            </p>
          </div>
        ) : (
          <p className="h-full overflow-y-auto whitespace-pre-wrap bg-te-bg px-4 py-3 font-mono text-base leading-relaxed text-te-fg">
            {outputText}
            {running ? (
              <motion.span
                className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-te-accent align-baseline"
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ repeat: Infinity, duration: 1, ease: "easeInOut" }}
              />
            ) : null}
          </p>
        )}

        {activeTool === "polish" &&
        status.kind === "done" &&
        outputText ? (
          <button
            type="button"
            onClick={onUseAsInput}
            aria-label={t("pages:toolbox.tools.use_as_input")}
            title={t("pages:toolbox.tools.use_as_input")}
            className="absolute left-0 bottom-12 z-10 inline-flex size-9 -translate-x-1/2 items-center justify-center border border-te-gray/50 bg-te-bg text-te-light-gray shadow-md transition-colors hover:border-te-accent hover:bg-te-accent hover:text-te-bg"
          >
            <ArrowLeft className="size-4" />
          </button>
        ) : null}

        {runMeta && status.kind === "done" ? (
          <div className="flex h-7 shrink-0 items-center justify-between border-t border-te-gray/30 px-3 font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray tabular-nums">
            <span>
              {t("pages:toolbox.output.meta_chars", { count: runMeta.chars })}
            </span>
            <span>
              {t("pages:toolbox.output.meta_elapsed", {
                seconds: (runMeta.durationMs / 1000).toFixed(2),
              })}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

export default function ToolboxPage() {
  const { t } = useTranslation();

  const interfaceLang = useSettingsStore((s) => s.general.interfaceLang);
  const aiRefine = useSettingsStore((s) => s.aiRefine);
  const storedTargetLang = useSettingsStore(
    (s) => s.general.translateTargetLang,
  );
  const setGeneral = useSettingsStore((s) => s.setGeneral);
  const promptLang = resolveLang(interfaceLang);

  const polishScenarios = useMemo(
    () => aiRefine.customPolishScenarios ?? DEFAULT_POLISH_SCENARIOS[promptLang],
    [aiRefine.customPolishScenarios, promptLang],
  );

  const [text, setTextRaw] = useState("");
  const [revertSnapshot, setRevertSnapshot] = useState<string | null>(null);
  const [clipboardPreview, setClipboardPreview] = useState<string | null>(null);

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

  const [targetLang, setTargetLang] =
    useState<TranslateTargetLang>(storedTargetLang);
  const [voice, setVoice] = useState<(typeof TTS_VOICES)[number]>("natural_f");
  const [speed, setSpeed] = useState<(typeof TTS_SPEEDS)[number]>(1.0);

  const [activeTool, setActiveTool] = useState<ToolKey>("translate");
  const [status, setStatus] = useState<ToolStatus>({ kind: "idle" });
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);

  const debounceRef = useRef<number | null>(null);
  const cancelDebounce = useCallback(() => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }, []);
  useEffect(() => () => cancelDebounce(), [cancelDebounce]);

  const stateRef = useRef({
    text,
    activeTool,
    targetLang,
    polishScenarioId,
    voice,
    speed,
    polishScenarios,
    aiRefine,
    promptLang,
  });
  stateRef.current = {
    text,
    activeTool,
    targetLang,
    polishScenarioId,
    voice,
    speed,
    polishScenarios,
    aiRefine,
    promptLang,
  };

  const runIdRef = useRef(0);

  const runChat = async (
    systemPrompt: string,
    userText: string,
    runId: number,
  ) => {
    const aiSettings = useSettingsStore.getState().aiRefine;
    const provider =
      aiSettings.mode === "custom"
        ? aiSettings.customProviders.find(
            (p) => p.id === aiSettings.activeCustomProviderId,
          ) ?? null
        : null;
    if (aiSettings.mode === "custom" && !provider) {
      throw new Error("no_active_custom_provider");
    }
    let acc = "";
    const r = await refineTextViaChatStream(
      {
        mode: aiSettings.mode,
        systemPrompt,
        userText,
        customBaseUrl: provider?.baseUrl,
        customModel: provider?.model,
        customKeyringId: provider ? `ai_provider_${provider.id}` : undefined,
      },
      (chunk) => {
        if (runIdRef.current !== runId) return;
        acc += chunk;
        setStatus({ kind: "running", partial: acc });
      },
    );
    return r.refinedText || acc;
  };

  const runTool = useCallback(
    async (tool: ToolKey, overrides?: RunOverrides) => {
      const myRunId = ++runIdRef.current;
      const snap = stateRef.current;
      const value = overrides?.text ?? snap.text;
      if (!value.trim()) {
        if (runIdRef.current !== myRunId) return;
        setStatus({ kind: "idle" });
        setRunMeta(null);
        return;
      }
      if (runIdRef.current !== myRunId) return;
      setActiveTool(tool);

      // 前置 gate：SaaS chat 通道未登录时直接弹登录框，不发 invoke。靠后端报错
      // 再正则识别本来就是反模式——登录态前端已知，应在源头拦住。BYOK custom
      // 路径自带凭证跳过此 gate；token 过期但 isAuthenticated=true 的兜底由后端
      // handle_session_expired 走 auth-lost 事件触发全局拦截器。
      if (tool !== "tts") {
        const aiMode = useSettingsStore.getState().aiRefine.mode;
        if (aiMode === "saas" && !useAuthStore.getState().isAuthenticated) {
          useUIStore.getState().openLogin();
          if (runIdRef.current !== myRunId) return;
          setStatus({ kind: "error", message: t("errors:auth.session_expired") });
          setRunMeta(null);
          return;
        }
      }

      if (runIdRef.current !== myRunId) return;
      setStatus({ kind: "running", partial: "" });
      setRunMeta(null);
      const start = performance.now();
      try {
        if (tool === "tts") {
          await new Promise((r) => setTimeout(r, 500));
          if (runIdRef.current !== myRunId) return;
          setStatus({ kind: "done", result: "" });
          setRunMeta({
            tool,
            durationMs: performance.now() - start,
            chars: value.length,
          });
          return;
        }
        let sysPrompt: string;
        if (tool === "translate") {
          const base = getEffectiveAiTranslationSystemPrompt(
            snap.aiRefine.customTranslationSystemPrompt,
            snap.promptLang,
          );
          const targetLang = overrides?.targetLang ?? snap.targetLang;
          sysPrompt = `${base}\n\nTarget language: ${TRANSLATE_LANG_NAMES[targetLang]}`;
        } else {
          const base = getEffectiveAiPolishSystemPrompt(
            snap.aiRefine.customPolishSystemPrompt,
            snap.promptLang,
          );
          const scenarioId = overrides?.polishScenarioId ?? snap.polishScenarioId;
          const scenario = snap.polishScenarios.find(
            (s) => s.id === scenarioId,
          );
          sysPrompt = scenario ? `${base}\n\n${scenario.instruction}` : base;
        }
        const result = await runChat(sysPrompt, value, myRunId);
        if (runIdRef.current !== myRunId) return;
        setStatus({ kind: "done", result });
        setRunMeta({
          tool,
          durationMs: performance.now() - start,
          chars: result.length,
        });
      } catch (e) {
        if (runIdRef.current !== myRunId) return;
        await handleAiRefineCustomFailure(e);
        const raw = e instanceof Error ? e.message : String(e);
        const msg = isSaasAuthError(raw) ? t("errors:auth.session_expired") : raw;
        setStatus({ kind: "error", message: msg });
      }
    },
    [],
  );

  const runImmediate = useCallback(
    (tool?: ToolKey, overrides?: RunOverrides) => {
      cancelDebounce();
      void runTool(tool ?? stateRef.current.activeTool, overrides);
    },
    [cancelDebounce, runTool],
  );

  const runDebounced = useCallback(
    (tool?: ToolKey) => {
      cancelDebounce();
      debounceRef.current = window.setTimeout(() => {
        debounceRef.current = null;
        void runTool(tool ?? stateRef.current.activeTool);
      }, AUTO_RUN_DEBOUNCE_MS);
    },
    [cancelDebounce, runTool],
  );

  // 写入 textarea 的统一入口：清掉 revertSnapshot / clipboardPreview，按 mode 决定后续是否激活。
  // - "immediate"：粘贴 / 历史 / 录音结束等，下一帧立刻跑；text 通过 override 直接传入避免 stateRef 滞后。
  // - "debounce"：用户打字，800ms 防抖。
  // - "none"：仅写入文本，不激活（外部场景如 setTextValue autoRun:false）。
  const applyTextChange = (
    next: string,
    mode: "immediate" | "debounce" | "none",
  ) => {
    setTextRaw(next);
    if (revertSnapshot !== null) setRevertSnapshot(null);
    if (clipboardPreview !== null) setClipboardPreview(null);
    if (next.trim().length === 0) {
      cancelDebounce();
      setStatus({ kind: "idle" });
      setRunMeta(null);
      return;
    }
    if (mode === "immediate") runImmediate(undefined, { text: next });
    else if (mode === "debounce") runDebounced();
    else cancelDebounce();
  };

  const setTextValue = (next: string, options: { autoRun: boolean }) => {
    applyTextChange(next, options.autoRun ? "immediate" : "none");
  };

  const handleTextInput = (next: string) => {
    applyTextChange(next, "debounce");
  };

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const txt = (await readClipboardText())?.trim() ?? "";
        if (!alive) return;
        if (txt && txt.length <= 4000) setClipboardPreview(txt);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const recState = useRecordingStore((s) => s.state);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const lastTranscriptRef = useRef("");
  const prevStateRef = useRef<RecordingState>("idle");
  const textForRecRef = useRef(text);
  textForRecRef.current = text;

  useEffect(() => {
    if (liveTranscript) lastTranscriptRef.current = liveTranscript;
  }, [liveTranscript]);

  useEffect(() => {
    const prev = prevStateRef.current;
    prevStateRef.current = recState;
    if (prev === "idle" && recState !== "idle") {
      lastTranscriptRef.current = "";
      return;
    }
    if (prev !== "idle" && recState === "idle") {
      const captured = lastTranscriptRef.current.trim();
      if (captured && textForRecRef.current.trim().length === 0) {
        setTextValue(lastTranscriptRef.current, { autoRun: true });
      }
      lastTranscriptRef.current = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recState]);

  const doPaste = async () => {
    try {
      const txt = await readClipboardText();
      if (txt) setTextValue(txt, { autoRun: true });
    } catch (e) {
      console.warn("[toolbox] paste failed:", e);
    }
  };

  const handleClear = () => {
    cancelDebounce();
    setTextRaw("");
    setStatus({ kind: "idle" });
    setRunMeta(null);
  };

  const rerun = () => {
    if (text.trim().length > 0) runImmediate();
  };

  const useResultAsInput = () => {
    if (activeTool !== "polish") return;
    if (status.kind !== "done" || !status.result) return;
    if (status.result === text) return;
    const next = status.result;
    setRevertSnapshot(text);
    setTextRaw(next);
    setRunMeta(null);
    runImmediate("polish", { text: next });
  };

  const revertText = () => {
    if (revertSnapshot === null) return;
    cancelDebounce();
    setTextRaw(revertSnapshot);
    setRevertSnapshot(null);
    setStatus({ kind: "idle" });
    setRunMeta(null);
  };

  const handleAcceptClipboard = (autoRun: boolean) => {
    if (!clipboardPreview) return;
    const txt = clipboardPreview;
    setClipboardPreview(null);
    setTextValue(txt, { autoRun });
  };

  const handleSetTargetLang = (l: TranslateTargetLang) => {
    setTargetLang(l);
    void setGeneral("translateTargetLang", l);
    if (text.trim().length > 0 && stateRef.current.activeTool === "translate") {
      runImmediate("translate", { targetLang: l });
    }
  };
  const handleSetPolishScenarioId = (id: string) => {
    setPolishScenarioId(id);
    if (text.trim().length > 0 && stateRef.current.activeTool === "polish") {
      runImmediate("polish", { polishScenarioId: id });
    }
  };
  const handleSetVoice = (v: (typeof TTS_VOICES)[number]) => {
    setVoice(v);
    if (text.trim().length > 0 && stateRef.current.activeTool === "tts") {
      runImmediate("tts");
    }
  };
  const handleSetSpeed = (s: (typeof TTS_SPEEDS)[number]) => {
    setSpeed(s);
    if (text.trim().length > 0 && stateRef.current.activeTool === "tts") {
      runImmediate("tts");
    }
  };

  const handleToolChange = (tool: ToolKey) => {
    if (tool === activeTool) return;
    setActiveTool(tool);
    if (text.trim().length > 0) runImmediate(tool);
    else {
      cancelDebounce();
      setStatus({ kind: "idle" });
      setRunMeta(null);
    }
  };

  const hasText = text.trim().length > 0;

  return (
    <section className="flex h-full flex-col overflow-hidden bg-te-bg">
      <div
        data-tauri-drag-region
        className="shrink-0 bg-te-bg"
      >
        <div
          data-tauri-drag-region
          className="mx-auto flex max-w-6xl items-center justify-between gap-3 px-[4vw] py-3"
        >
          <motion.div
            data-tauri-drag-region
            className="flex items-center gap-3"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3 }}
          >
            <Sparkles className="size-6 text-te-accent" />
            <div data-tauri-drag-region className="flex flex-col">
              <h1 className="font-mono text-2xl font-bold tracking-tighter text-te-fg">
                {t("pages:toolbox.title")}
              </h1>
              <p className="font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
                {t("pages:toolbox.subtitle")}
              </p>
            </div>
          </motion.div>
          <ToolTabs tool={activeTool} onChange={handleToolChange} />
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-[4vw] pt-2 pb-[clamp(1rem,3vw,2rem)]">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="grid min-h-0 flex-1 grid-cols-1 gap-px border border-te-gray/40 bg-te-gray/40 md:grid-cols-2"
        >
          <InputCard
            text={text}
            onTextInput={handleTextInput}
            onTextFill={(v, o) => setTextValue(v, o)}
            hasText={hasText}
            onClear={handleClear}
            revertSnapshot={revertSnapshot}
            onRevert={revertText}
            doPaste={doPaste}
            clipboardPreview={clipboardPreview}
            onAcceptClipboard={handleAcceptClipboard}
            onDismissClipboard={() => setClipboardPreview(null)}
          />
          <OutputCard
            status={status}
            activeTool={activeTool}
            hasText={hasText}
            targetLang={targetLang}
            setTargetLang={handleSetTargetLang}
            polishScenarios={polishScenarios}
            polishScenarioId={polishScenarioId}
            setPolishScenarioId={handleSetPolishScenarioId}
            voice={voice}
            setVoice={handleSetVoice}
            speed={speed}
            setSpeed={handleSetSpeed}
            runMeta={runMeta}
            onRerun={rerun}
            onUseAsInput={useResultAsInput}
          />
        </motion.div>
      </div>
    </section>
  );
}
