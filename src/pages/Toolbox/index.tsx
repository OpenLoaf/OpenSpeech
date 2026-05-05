import { useEffect, useMemo, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Clipboard,
  ClipboardCheck,
  Copy,
  CornerUpLeft,
  Download,
  History as HistoryIcon,
  Languages,
  Play,
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
import {
  useSettingsStore,
  DEFAULT_POLISH_SCENARIOS,
  getEffectiveAiTranslationSystemPrompt,
  getEffectiveAiPolishSystemPrompt,
  type PolishScenario,
  type TranslateTargetLang,
} from "@/stores/settings";
import { resolveLang } from "@/i18n";
import { refineTextViaChatStream } from "@/lib/ai-refine";
import { handleAiRefineCustomFailure } from "@/lib/ai-refine-fallback";

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

type ToolStatus =
  | { kind: "idle" }
  | { kind: "running"; partial: string }
  | { kind: "done"; result: string }
  | { kind: "error"; message: string };

type RunMeta = { tool: ToolKey; durationMs: number; chars: number };

const ICON_BTN =
  "inline-flex h-7 items-center gap-1.5 px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray transition-colors hover:text-te-fg disabled:opacity-40 disabled:hover:text-te-light-gray";

const CHIP_TRIGGER =
  "inline-flex h-6 items-center gap-1 border border-te-gray/50 bg-te-bg px-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent";

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
}: {
  onPick: (text: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const items = useHistoryStore((s) => s.items);
  const usable = items
    .filter((it) => it.status === "success" && it.text.trim().length > 0)
    .slice(0, 30);
  return (
    <div className="absolute top-full left-0 z-30 mt-1 max-h-72 w-80 overflow-y-auto border border-te-gray/60 bg-te-bg shadow-lg">
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

type ActionRowProps = {
  tool: ToolKey;
  icon: typeof Play;
  label: string;
  enabled: boolean;
  active: boolean;
  running: boolean;
  onRun: () => void;
  param?: React.ReactNode;
};

function ActionRow({
  icon: Icon,
  label,
  enabled,
  active,
  running,
  onRun,
  param,
}: ActionRowProps) {
  return (
    <div
      className={cn(
        "flex h-10 items-center justify-between gap-2 border-t border-te-gray/30 px-3 transition-colors",
        active ? "bg-te-accent/[0.06]" : null,
      )}
    >
      <button
        type="button"
        onClick={onRun}
        disabled={!enabled || running}
        className={cn(
          "group inline-flex h-7 items-center gap-2 px-2 font-mono text-[11px] font-semibold uppercase tracking-[0.22em] transition-colors",
          enabled
            ? active
              ? "text-te-accent"
              : "text-te-fg hover:text-te-accent"
            : "text-te-light-gray/40",
          "disabled:cursor-not-allowed",
        )}
      >
        <Icon
          className={cn(
            "size-3.5",
            enabled
              ? active
                ? "text-te-accent"
                : "text-te-fg group-hover:text-te-accent"
              : "text-te-light-gray/40",
          )}
        />
        <span>{label}</span>
      </button>
      <div className="flex items-center gap-1.5">{param}</div>
    </div>
  );
}

type InputCardProps = {
  text: string;
  setText: (s: string) => void;
  charCount: number;
  doPaste: () => Promise<void>;
  onClear: () => void;
  revertSnapshot: string | null;
  onRevert: () => void;
  hasText: boolean;
  running: boolean;
  activeTool: ToolKey | null;
  runTool: (tool: ToolKey) => void;
  targetLang: TranslateTargetLang;
  setTargetLang: (l: TranslateTargetLang) => void;
  polishScenarios: PolishScenario[];
  polishScenarioId: string | null;
  setPolishScenarioId: (id: string) => void;
  voice: (typeof TTS_VOICES)[number];
  setVoice: (v: (typeof TTS_VOICES)[number]) => void;
  speed: (typeof TTS_SPEEDS)[number];
  setSpeed: (s: (typeof TTS_SPEEDS)[number]) => void;
  clipboardPreview: string | null;
  onAcceptClipboard: (action: ToolKey | null) => void;
  onDismissClipboard: () => void;
};

function InputCard({
  text,
  setText,
  charCount,
  doPaste,
  onClear,
  revertSnapshot,
  onRevert,
  hasText,
  running,
  activeTool,
  runTool,
  targetLang,
  setTargetLang,
  polishScenarios,
  polishScenarioId,
  setPolishScenarioId,
  voice,
  setVoice,
  speed,
  setSpeed,
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

  const handlePaste = async () => {
    await doPaste();
    setPasted(true);
    window.setTimeout(() => setPasted(false), 800);
  };

  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-te-bg">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-te-gray/30 px-2">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={handlePaste}
            className={cn(ICON_BTN, pasted && "text-te-accent")}
          >
            {pasted ? (
              <ClipboardCheck className="size-3.5" />
            ) : (
              <Clipboard className="size-3.5" />
            )}
            <span>{t("pages:toolbox.input.paste")}</span>
          </button>
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
                    onPick={(value) => setText(value)}
                    onClose={() => setHistoryOpen(false)}
                  />
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
          <button
            type="button"
            onClick={onClear}
            disabled={!hasText}
            className={ICON_BTN}
          >
            <Trash2 className="size-3.5" />
            <span>{t("pages:toolbox.input.clear")}</span>
          </button>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray tabular-nums">
          {t("pages:toolbox.input.char_count", { count: charCount })}
        </span>
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
                    onClick={() => onAcceptClipboard("translate")}
                    className="inline-flex h-6 items-center gap-1 bg-te-accent px-2 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-te-bg transition-opacity hover:opacity-90"
                  >
                    <Languages className="size-3" />
                    {t("pages:toolbox.input.clipboard_translate")}
                  </button>
                  <button
                    type="button"
                    onClick={() => onAcceptClipboard(null)}
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

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("pages:toolbox.input.text_placeholder")}
        className="min-h-0 w-full flex-1 resize-none bg-te-bg px-3 py-3 font-mono text-sm leading-relaxed text-te-fg/90 outline-none transition-colors placeholder:text-te-light-gray/40 focus:bg-te-surface/40 focus:text-te-fg"
      />

      <div className="shrink-0 border-t border-te-gray/40">
        <ActionRow
          tool="translate"
          icon={Languages}
          label={t("pages:toolbox.tools.tabs.translate")}
          enabled={hasText}
          active={activeTool === "translate"}
          running={running}
          onRun={() => runTool("translate")}
          param={
            <ChipDropdown<TranslateTargetLang>
              value={targetLang}
              onChange={setTargetLang}
              align="right"
              options={TRANSLATE_LANGS.map((l) => ({
                value: l,
                label: t(`pages:toolbox.tools.translate.languages.${l}`),
              }))}
            />
          }
        />
        <ActionRow
          tool="polish"
          icon={Wand2}
          label={t("pages:toolbox.tools.tabs.polish")}
          enabled={hasText && polishScenarios.length > 0}
          active={activeTool === "polish"}
          running={running}
          onRun={() => runTool("polish")}
          param={
            polishScenarios.length === 0 ? (
              <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray/60">
                {t("pages:toolbox.tools.polish.scenarios_empty")}
              </span>
            ) : (
              <ChipDropdown<string>
                value={polishScenarioId ?? polishScenarios[0]!.id}
                onChange={setPolishScenarioId}
                align="right"
                options={polishScenarios.map((s) => ({
                  value: s.id,
                  label: s.name,
                }))}
              />
            )
          }
        />
        <ActionRow
          tool="tts"
          icon={Volume2}
          label={t("pages:toolbox.tools.tabs.tts")}
          enabled={hasText}
          active={activeTool === "tts"}
          running={running}
          onRun={() => runTool("tts")}
          param={
            <div className="flex items-center gap-1">
              <ChipDropdown<(typeof TTS_VOICES)[number]>
                value={voice}
                onChange={setVoice}
                align="right"
                options={TTS_VOICES.map((v) => ({
                  value: v,
                  label: t(`pages:toolbox.tools.tts.voices.${v}`),
                }))}
              />
              <ChipDropdown<(typeof TTS_SPEEDS)[number]>
                value={speed}
                onChange={setSpeed}
                align="right"
                options={TTS_SPEEDS.map((s) => ({
                  value: s,
                  label: `${s.toFixed(2)}×`,
                }))}
              />
            </div>
          }
        />
      </div>
    </div>
  );
}

type OutputCardProps = {
  status: ToolStatus;
  activeTool: ToolKey | null;
  targetLang: TranslateTargetLang;
  polishScenarios: PolishScenario[];
  polishScenarioId: string | null;
  voice: (typeof TTS_VOICES)[number];
  speed: (typeof TTS_SPEEDS)[number];
  runMeta: RunMeta | null;
  onRerun: () => void;
  onUseAsInput: () => void;
};

function OutputCard({
  status,
  activeTool,
  targetLang,
  polishScenarios,
  polishScenarioId,
  voice,
  speed,
  runMeta,
  onRerun,
  onUseAsInput,
}: OutputCardProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

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

  const toolLabel = activeTool
    ? t(`pages:toolbox.tools.tabs.${activeTool}`)
    : null;
  const paramLabel = (() => {
    if (activeTool === "translate") {
      return t(`pages:toolbox.tools.translate.languages.${targetLang}`);
    }
    if (activeTool === "polish") {
      const sc = polishScenarios.find((s) => s.id === polishScenarioId);
      return sc?.name ?? null;
    }
    if (activeTool === "tts") {
      return `${t(`pages:toolbox.tools.tts.voices.${voice}`)} · ${speed.toFixed(2)}×`;
    }
    return null;
  })();

  const running = status.kind === "running";
  const isTtsDone = activeTool === "tts" && status.kind === "done";

  return (
    <div className="flex min-h-0 min-w-0 flex-col bg-te-surface">
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-te-gray/30 px-3">
        <div className="flex min-w-0 items-center gap-2 font-mono text-[10px] uppercase tracking-[0.22em]">
          {toolLabel ? (
            <>
              <span className="text-te-accent">{toolLabel}</span>
              {paramLabel ? (
                <>
                  <span className="text-te-gray/60">·</span>
                  <span className="truncate text-te-fg">{paramLabel}</span>
                </>
              ) : null}
            </>
          ) : (
            <span className="text-te-light-gray/60">
              {t("pages:toolbox.output.idle_label")}
            </span>
          )}
        </div>
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
            disabled={!activeTool || running}
            className={ICON_BTN}
          >
            <RotateCcw className="size-3.5" />
            <span>{t("pages:toolbox.tools.rerun")}</span>
          </button>
          <button
            type="button"
            onClick={onUseAsInput}
            disabled={status.kind !== "done" || !outputText}
            className={ICON_BTN}
          >
            <CornerUpLeft className="size-3.5 rotate-180" />
            <span>{t("pages:toolbox.tools.use_as_input")}</span>
          </button>
        </div>
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col">
        {status.kind === "idle" ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <p className="font-mono text-[11px] uppercase tracking-[0.28em] text-te-light-gray/50">
              {t("pages:toolbox.output.ready")}
            </p>
          </div>
        ) : status.kind === "error" ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 border-t border-red-500/40 bg-red-500/[0.04] px-4 py-6">
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
        ) : (
          <div className="relative min-h-0 flex-1">
            <span className="pointer-events-none absolute top-0 left-0 h-full w-0.5 bg-te-accent" />
            <p className="h-full overflow-y-auto whitespace-pre-wrap bg-te-bg px-4 py-3 font-mono text-sm leading-relaxed text-te-fg">
              {outputText}
              {running ? (
                <motion.span
                  className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-te-accent align-baseline"
                  animate={{ opacity: [1, 0.2, 1] }}
                  transition={{ repeat: Infinity, duration: 1, ease: "easeInOut" }}
                />
              ) : null}
            </p>
          </div>
        )}

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

  const [activeTool, setActiveTool] = useState<ToolKey | null>(null);
  const [status, setStatus] = useState<ToolStatus>({ kind: "idle" });
  const [runMeta, setRunMeta] = useState<RunMeta | null>(null);

  const setText = (next: string) => {
    setTextRaw(next);
    if (revertSnapshot !== null) setRevertSnapshot(null);
    if (clipboardPreview !== null) setClipboardPreview(null);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const recState = useRecordingStore((s) => s.state);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const lastTranscriptRef = useRef("");
  const prevStateRef = useRef<RecordingState>("idle");
  const textRef = useRef(text);
  textRef.current = text;

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
      if (captured && textRef.current.trim().length === 0) {
        setText(lastTranscriptRef.current);
      }
      lastTranscriptRef.current = "";
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recState]);

  const doPaste = async () => {
    try {
      const txt = await readClipboardText();
      if (txt) setText(txt);
    } catch (e) {
      console.warn("[toolbox] paste failed:", e);
    }
  };

  const runChat = async (systemPrompt: string, userText: string) => {
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
        acc += chunk;
        setStatus({ kind: "running", partial: acc });
      },
    );
    return r.refinedText || acc;
  };

  const runTool = async (tool: ToolKey) => {
    if (!text.trim()) return;
    if (status.kind === "running") return;
    setActiveTool(tool);
    setStatus({ kind: "running", partial: "" });
    setRunMeta(null);
    const start = performance.now();
    try {
      if (tool === "tts") {
        await new Promise((r) => setTimeout(r, 500));
        setStatus({ kind: "done", result: "" });
        setRunMeta({
          tool,
          durationMs: performance.now() - start,
          chars: text.length,
        });
        return;
      }
      let sysPrompt: string;
      if (tool === "translate") {
        const base = getEffectiveAiTranslationSystemPrompt(
          aiRefine.customTranslationSystemPrompt,
          promptLang,
        );
        sysPrompt = `${base}\n\nTarget language: ${TRANSLATE_LANG_NAMES[targetLang]}`;
      } else {
        const base = getEffectiveAiPolishSystemPrompt(
          aiRefine.customPolishSystemPrompt,
          promptLang,
        );
        const scenario = polishScenarios.find((s) => s.id === polishScenarioId);
        sysPrompt = scenario ? `${base}\n\n${scenario.instruction}` : base;
      }
      const result = await runChat(sysPrompt, text);
      setStatus({ kind: "done", result });
      setRunMeta({
        tool,
        durationMs: performance.now() - start,
        chars: result.length,
      });
    } catch (e) {
      await handleAiRefineCustomFailure(e);
      const msg = e instanceof Error ? e.message : String(e);
      setStatus({ kind: "error", message: msg });
    }
  };

  const rerun = () => {
    if (activeTool) void runTool(activeTool);
  };

  const useResultAsInput = () => {
    if (status.kind !== "done" || !status.result) return;
    setRevertSnapshot(text);
    setTextRaw(status.result);
    setStatus({ kind: "idle" });
    setRunMeta(null);
    setActiveTool(null);
  };

  const revertText = () => {
    if (revertSnapshot === null) return;
    setTextRaw(revertSnapshot);
    setRevertSnapshot(null);
  };

  const handleAcceptClipboard = (action: ToolKey | null) => {
    if (!clipboardPreview) return;
    setTextRaw(clipboardPreview);
    setClipboardPreview(null);
    if (action) {
      window.setTimeout(() => void runTool(action), 0);
    }
  };

  const handleSetTargetLang = (l: TranslateTargetLang) => {
    setTargetLang(l);
    void setGeneral("translateTargetLang", l);
  };

  const hasText = text.trim().length > 0;
  const charCount = text.length;
  const running = status.kind === "running";

  return (
    <section className="flex h-full flex-col overflow-hidden bg-te-bg">
      <div
        data-tauri-drag-region
        className="shrink-0 border-b border-te-gray/30 bg-te-bg"
      >
        <div
          data-tauri-drag-region
          className="mx-auto flex max-w-6xl items-center gap-3 px-[4vw] py-3"
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
        </div>
      </div>

      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col px-[4vw] pt-[clamp(0.5rem,2vh,1.25rem)] pb-[clamp(1rem,3vw,2rem)]">
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="grid min-h-0 flex-1 grid-cols-1 gap-px border border-te-gray/40 bg-te-gray/40 md:grid-cols-2"
        >
          <InputCard
            text={text}
            setText={setText}
            charCount={charCount}
            doPaste={doPaste}
            onClear={() => setText("")}
            revertSnapshot={revertSnapshot}
            onRevert={revertText}
            hasText={hasText}
            running={running}
            activeTool={activeTool}
            runTool={(tool) => void runTool(tool)}
            targetLang={targetLang}
            setTargetLang={handleSetTargetLang}
            polishScenarios={polishScenarios}
            polishScenarioId={polishScenarioId}
            setPolishScenarioId={setPolishScenarioId}
            voice={voice}
            setVoice={setVoice}
            speed={speed}
            setSpeed={setSpeed}
            clipboardPreview={clipboardPreview}
            onAcceptClipboard={handleAcceptClipboard}
            onDismissClipboard={() => setClipboardPreview(null)}
          />
          <OutputCard
            status={status}
            activeTool={activeTool}
            targetLang={targetLang}
            polishScenarios={polishScenarios}
            polishScenarioId={polishScenarioId}
            voice={voice}
            speed={speed}
            runMeta={runMeta}
            onRerun={rerun}
            onUseAsInput={useResultAsInput}
          />
        </motion.div>
      </div>
    </section>
  );
}
