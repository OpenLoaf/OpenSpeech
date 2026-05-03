import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useTranslation } from "react-i18next";
import {
  ArrowUpFromLine,
  Copy,
  CornerUpLeft,
  Download,
  FileAudio,
  History as HistoryIcon,
  Languages,
  Mic,
  RotateCcw,
  Save,
  Sparkles,
  Type,
  Volume2,
  Wand2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { HotkeyDictationCard } from "@/components/HotkeyDictationCard";
import { useRecordingStore, type RecordingState } from "@/stores/recording";
import { useHistoryStore } from "@/stores/history";

type InputTab = "text" | "voice" | "history" | "file";
type ToolKey = "polish" | "translate" | "tts";

function shortTimeLabel(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const sameDay = now.toDateString() === d.toDateString();
  if (sameDay) {
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

const SAMPLE_TEXT = "今天天气真好，我们去公园散步吧。这里有点凉，你要多穿点衣服。";

const POLISH_PRESET_KEYS = [
  "email",
  "wechat",
  "report",
  "meeting_notes",
  "social_post",
] as const;
type PolishPresetKey = (typeof POLISH_PRESET_KEYS)[number];
const TRANSLATE_LANGS = ["en", "zh", "ja", "ko"] as const;
const TTS_VOICES = ["natural_f", "natural_m", "calm_f"] as const;
const TTS_SPEEDS = [0.8, 1.0, 1.25, 1.5] as const;

const MOCK_RESULTS: Record<Exclude<ToolKey, "tts">, string> = {
  polish:
    "各位同事好，明天我有事需要请假一天，工作如有紧急事项可以微信联系我。给大家添麻烦了，谢谢理解。",
  translate:
    "Hi all, I'll be off tomorrow for personal reasons. Feel free to reach me on WeChat if anything urgent comes up. Thanks for understanding.",
};

const BTN_BASE =
  "inline-flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] transition-all";
const BTN_GHOST = `${BTN_BASE} border border-te-gray/50 bg-te-surface text-te-fg hover:border-te-accent hover:text-te-accent`;
const CHIP_BASE =
  "inline-flex items-center justify-center border px-2.5 py-1 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors";
const CHIP_OFF = `${CHIP_BASE} border-te-gray/40 text-te-light-gray hover:border-te-gray hover:text-te-fg`;
const CHIP_ON = `${CHIP_BASE} border-te-accent text-te-accent`;

/* ──────────────────────────────────────────────────────────────── */
/*  Input · left rail                                                */
/* ──────────────────────────────────────────────────────────────── */

type InputRailProps = {
  tab: InputTab;
  onChange: (t: InputTab) => void;
};

function InputRail({ tab, onChange }: InputRailProps) {
  const { t } = useTranslation();
  const items: { key: InputTab; icon: typeof Type }[] = [
    { key: "text", icon: Type },
    { key: "voice", icon: Mic },
    { key: "file", icon: FileAudio },
    { key: "history", icon: HistoryIcon },
  ];
  return (
    <div className="flex w-24 shrink-0 flex-col border-r border-te-gray/40 bg-te-bg/40">
      {items.map(({ key, icon: Icon }) => {
        const active = tab === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "relative flex flex-1 items-center gap-2 px-3 transition-colors",
              active
                ? "bg-te-surface text-te-accent"
                : "text-te-light-gray/70 hover:bg-te-surface-hover hover:text-te-fg",
            )}
          >
            {active ? (
              <span className="absolute inset-y-0 left-0 w-0.5 bg-te-accent" />
            ) : null}
            <Icon className="size-4 shrink-0" />
            <span className="font-mono text-[11px] tracking-[0.05em]">
              {t(`pages:toolbox.input.tabs.${key}`)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Input · left source UI                                           */
/* ──────────────────────────────────────────────────────────────── */

type InputLeftProps = {
  tab: InputTab;
  text: string;
  setText: (s: string) => void;
  selectedHistoryId: string | null;
  setSelectedHistoryId: (id: string | null) => void;
  revertSnapshot: string | null;
  onRevert: () => void;
};

function InputLeft({
  tab,
  text,
  setText,
  selectedHistoryId,
  setSelectedHistoryId,
  revertSnapshot,
  onRevert,
}: InputLeftProps) {
  const { t } = useTranslation();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {tab === "text" && revertSnapshot !== null ? (
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

      {tab === "text" ? (
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t("pages:toolbox.input.text_placeholder")}
          className="min-h-0 w-full flex-1 resize-none bg-te-surface/60 px-3 py-2.5 font-mono text-sm leading-relaxed text-te-fg/90 outline-none transition-colors placeholder:text-te-light-gray/40 focus:bg-te-surface focus:text-te-fg"
        />
      ) : null}

      {tab === "voice" ? (
        <div className="flex min-h-0 flex-1 flex-col">
          <HotkeyDictationCard bare />
        </div>
      ) : null}

      {tab === "history" ? (
        <HistorySource
          selectedId={selectedHistoryId}
          onPick={(id, value) => {
            setSelectedHistoryId(id);
            setText(value);
          }}
        />
      ) : null}

      {tab === "file" ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-4">
          <FileAudio className="size-7 text-te-light-gray" />
          <button
            type="button"
            onClick={() => setText(SAMPLE_TEXT)}
            className={BTN_GHOST}
          >
            {t("pages:toolbox.input.file_button")}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  History source · real items                                      */
/* ──────────────────────────────────────────────────────────────── */

function HistorySource({
  selectedId,
  onPick,
}: {
  selectedId: string | null;
  onPick: (id: string, text: string) => void;
}) {
  const { t } = useTranslation();
  const items = useHistoryStore((s) => s.items);
  const usable = items
    .filter((it) => it.status === "success" && it.text.trim().length > 0)
    .slice(0, 50);

  if (usable.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-4">
        <p className="text-center font-mono text-[11px] uppercase tracking-[0.18em] text-te-light-gray">
          {t("pages:toolbox.input.history_empty")}
        </p>
      </div>
    );
  }

  return (
    <ul className="flex min-h-0 flex-1 flex-col divide-y divide-te-gray/20 overflow-y-auto">
      {usable.map((h) => {
        const active = selectedId === h.id;
        const display = h.refined_text?.trim() || h.text;
        return (
          <li key={h.id}>
            <button
              type="button"
              onClick={() => onPick(h.id, display)}
              className={cn(
                "relative flex w-full items-center gap-3 px-3 py-2 text-left transition-colors",
                active
                  ? "bg-te-surface-hover text-te-accent"
                  : "hover:bg-te-surface-hover",
              )}
            >
              {active ? (
                <span className="absolute inset-y-0 left-0 w-0.5 bg-te-accent" />
              ) : null}
              <span className="w-10 shrink-0 font-mono text-[10px] uppercase tracking-widest text-te-light-gray tabular-nums">
                {shortTimeLabel(h.created_at)}
              </span>
              <span
                className={cn(
                  "flex-1 truncate font-mono text-[12px]",
                  active ? "text-te-accent" : "text-te-fg",
                )}
              >
                {display}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Tools · top tab row                                              */
/* ──────────────────────────────────────────────────────────────── */

type ToolTabsProps = {
  tool: ToolKey;
  onChange: (t: ToolKey) => void;
};

function ToolTabs({ tool, onChange }: ToolTabsProps) {
  const { t } = useTranslation();
  const items: { key: ToolKey; icon: typeof Wand2 }[] = [
    { key: "polish", icon: Wand2 },
    { key: "translate", icon: Languages },
    { key: "tts", icon: Volume2 },
  ];
  return (
    <div className="flex shrink-0 items-stretch border-b border-te-gray/40">
      {items.map(({ key, icon: Icon }) => {
        const active = tool === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              "relative flex flex-1 items-center justify-center gap-2 px-3 py-2.5 font-mono text-[11px] uppercase tracking-[0.18em] transition-colors",
              active
                ? "bg-te-bg text-te-accent"
                : "text-te-light-gray hover:bg-te-surface-hover hover:text-te-fg",
            )}
          >
            <Icon className="size-3.5" />
            {t(`pages:toolbox.tools.tabs.${key}`)}
            {active ? (
              <span className="absolute inset-x-0 -bottom-px h-0.5 bg-te-accent" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Tools · body                                                     */
/* ──────────────────────────────────────────────────────────────── */

type ToolBodyProps = {
  tool: ToolKey;
  hasInput: boolean;
  onUseAsInput: (text: string) => void;
};

function ToolBody({ tool, hasInput, onUseAsInput }: ToolBodyProps) {
  const { t } = useTranslation();

  const [polishScenario, setPolishScenario] =
    useState<PolishPresetKey>("email");
  const [targetLang, setTargetLang] =
    useState<(typeof TRANSLATE_LANGS)[number]>("en");
  const [voice, setVoice] = useState<(typeof TTS_VOICES)[number]>("natural_f");
  const [speed, setSpeed] = useState<(typeof TTS_SPEEDS)[number]>(1.0);

  const paramRow =
    tool === "polish" ? (
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-te-gray/30 bg-te-bg/60 px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray">
          {t("pages:toolbox.tools.polish.scenario_label")}
        </span>
        {POLISH_PRESET_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setPolishScenario(k)}
            className={polishScenario === k ? CHIP_ON : CHIP_OFF}
          >
            {t(`pages:toolbox.tools.polish.examples.${k}`)}
          </button>
        ))}
      </div>
    ) : tool === "translate" ? (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-te-gray/30 bg-te-bg/60 px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray">
          {t("pages:toolbox.tools.translate.target_label")}
        </span>
        {TRANSLATE_LANGS.map((l) => (
          <button
            key={l}
            type="button"
            onClick={() => setTargetLang(l)}
            className={targetLang === l ? CHIP_ON : CHIP_OFF}
          >
            {t(`pages:toolbox.tools.translate.languages.${l}`)}
          </button>
        ))}
      </div>
    ) : (
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-te-gray/30 bg-te-bg/60 px-4 py-2.5">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray">
          {t("pages:toolbox.tools.tts.voice_label")}
        </span>
        {TTS_VOICES.map((v) => (
          <button
            key={v}
            type="button"
            onClick={() => setVoice(v)}
            className={voice === v ? CHIP_ON : CHIP_OFF}
          >
            {t(`pages:toolbox.tools.tts.voices.${v}`)}
          </button>
        ))}
        <span className="ml-2 font-mono text-[10px] uppercase tracking-[0.18em] text-te-light-gray">
          {t("pages:toolbox.tools.tts.speed_label")}
        </span>
        {TTS_SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => setSpeed(s)}
            className={cn(
              speed === s ? CHIP_ON : CHIP_OFF,
              "tabular-nums",
            )}
          >
            {s.toFixed(2)}×
          </button>
        ))}
      </div>
    );

  const isTts = tool === "tts";
  const outputText = !hasInput || isTts ? "" : MOCK_RESULTS[tool];

  return (
    <motion.div
      key={tool}
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
      className="flex min-h-0 flex-1 flex-col"
    >
      {paramRow}

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto p-4">
        {!hasInput ? (
          <div className="flex flex-1 items-center justify-center border border-dashed border-te-gray/40 bg-te-bg/40 px-4 py-6">
            <p className="text-center font-mono text-[11px] uppercase tracking-[0.22em] text-te-light-gray/60">
              {t("pages:toolbox.tools.output_empty")}
            </p>
          </div>
        ) : isTts ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 border border-te-accent/70 bg-te-bg p-4">
            <p className="font-mono text-sm tracking-wider text-te-fg">
              {t("pages:toolbox.tools.tts.audio_placeholder")}
            </p>
            <button type="button" className={BTN_GHOST}>
              <Download className="size-3" />
              {t("pages:toolbox.tools.download")}
            </button>
          </div>
        ) : (
          <div className="relative min-h-0 flex-1">
            <span className="pointer-events-none absolute top-0 left-0 h-full w-0.5 bg-te-accent" />
            <p className="h-full overflow-y-auto whitespace-pre-wrap border border-te-accent/40 bg-te-bg p-3 pl-4 font-mono text-sm leading-relaxed text-te-fg">
              {outputText}
            </p>
          </div>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-te-gray/40 bg-te-bg/60 px-4 py-2.5">
        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-te-accent/90">
          <span
            className={cn(
              "inline-block size-1.5 rounded-full",
              hasInput ? "bg-te-accent" : "bg-te-light-gray/40",
            )}
          />
          {hasInput
            ? t("pages:toolbox.tools.elapsed", { seconds: "1.4" })
            : t("pages:toolbox.tools.idle")}
        </span>
        <span className="mx-1 h-3 w-px bg-te-gray/40" />
        <button type="button" className={BTN_GHOST} disabled={!hasInput}>
          <RotateCcw className="size-3" />
          {t("pages:toolbox.tools.rerun")}
        </button>
        <button type="button" className={BTN_GHOST} disabled={!hasInput}>
          <Copy className="size-3" />
          {t("pages:toolbox.tools.copy")}
        </button>
        <button type="button" className={BTN_GHOST} disabled={!hasInput}>
          <Save className="size-3" />
          {t("pages:toolbox.tools.save_history")}
        </button>
        {!isTts ? (
          <>
            <div className="flex-1" />
            <motion.button
              type="button"
              onClick={() => onUseAsInput(outputText)}
              disabled={!hasInput}
              className={cn(
                "group inline-flex items-center gap-2 border px-4 py-2 font-mono text-[11px] font-bold uppercase tracking-[0.22em] transition-all",
                hasInput
                  ? "border-te-accent bg-te-accent text-te-bg shadow-[0_0_0_2px_rgba(0,0,0,0)] hover:shadow-[0_0_0_2px_var(--te-accent)]"
                  : "cursor-not-allowed border-te-gray/40 bg-te-surface/40 text-te-light-gray/40",
              )}
              whileHover={hasInput ? { y: -1 } : undefined}
              whileTap={hasInput ? { y: 0 } : undefined}
            >
              <ArrowUpFromLine className="size-3.5" />
              {t("pages:toolbox.tools.use_as_input")}
              <span className="ml-1 text-[10px] opacity-70">→ NEXT</span>
            </motion.button>
          </>
        ) : null}
      </div>
    </motion.div>
  );
}

/* ──────────────────────────────────────────────────────────────── */
/*  Page                                                             */
/* ──────────────────────────────────────────────────────────────── */

export default function ToolboxPage() {
  const { t } = useTranslation();
  const [inputTab, setInputTab] = useState<InputTab>("text");
  const [text, setTextRaw] = useState("");
  const [selectedHistoryId, setSelectedHistoryId] = useState<string | null>(null);
  const [activeTool, setActiveTool] = useState<ToolKey>("translate");
  const [revertSnapshot, setRevertSnapshot] = useState<string | null>(null);

  const setText = (next: string) => {
    setTextRaw(next);
    if (revertSnapshot !== null) setRevertSnapshot(null);
  };

  // 监听全局录音状态：active → idle 时把最近一次 liveTranscript 落到 text，
  // 仅当用户当前停留在 voice tab 才接管。
  const recState = useRecordingStore((s) => s.state);
  const liveTranscript = useRecordingStore((s) => s.liveTranscript);
  const lastTranscriptRef = useRef("");
  const prevStateRef = useRef<RecordingState>("idle");
  const inputTabRef = useRef(inputTab);
  inputTabRef.current = inputTab;

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
      if (captured && inputTabRef.current === "voice") {
        setText(lastTranscriptRef.current);
      }
      lastTranscriptRef.current = "";
    }
  }, [recState]);

  const switchInputTab = (next: InputTab) => {
    if (next === inputTab) return;
    setInputTab(next);
    setText("");
    setSelectedHistoryId(null);
  };

  const useToolOutputAsInput = (output: string) => {
    setInputTab("text");
    setRevertSnapshot(text);
    setTextRaw(output);
    setSelectedHistoryId(null);
  };

  const revertText = () => {
    if (revertSnapshot === null) return;
    setTextRaw(revertSnapshot);
    setRevertSnapshot(null);
  };

  const hasText = text.trim().length > 0;

  return (
    <section className="flex h-full flex-col overflow-hidden bg-te-bg">
      {/* Header (compact, drag region) */}
      <div
        data-tauri-drag-region
        className="shrink-0 border-b border-te-gray/30 bg-te-bg"
      >
        <div
          data-tauri-drag-region
          className="mx-auto flex max-w-6xl items-center gap-3 px-[4vw] pt-3 pb-3"
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

      {/* Body: stacked top/bottom modules, fills remaining height, no page scroll */}
      <div className="mx-auto flex w-full max-w-6xl min-h-0 flex-1 flex-col gap-[clamp(0.75rem,2vw,1.5rem)] px-[4vw] pt-[clamp(0.5rem,2vh,1.25rem)] pb-[clamp(1rem,3vw,2rem)]">
        {/* ── 01 · Input module (fixed height) — left rail + content ── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
          className="flex h-[160px] shrink-0 flex-row border border-te-gray/40 bg-te-bg/30"
        >
          <InputRail tab={inputTab} onChange={switchInputTab} />
          <InputLeft
            tab={inputTab}
            text={text}
            setText={setText}
            selectedHistoryId={selectedHistoryId}
            setSelectedHistoryId={setSelectedHistoryId}
            revertSnapshot={revertSnapshot}
            onRevert={revertText}
          />
        </motion.div>

        {/* ── Flow connector between input and tools ── */}
        <motion.div
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.08 }}
          className="flex shrink-0 items-start gap-5 border-t border-te-gray/30 pt-3"
        >
          <div className="flex shrink-0 flex-col font-mono text-[10px] uppercase leading-tight tracking-[0.3em]">
            <span className="text-te-light-gray/50">[02]</span>
            <span className="text-te-accent">TOOLS</span>
          </div>
          <p className="min-w-0 flex-1 font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
            {t("pages:toolbox.flow_hint")}
          </p>
        </motion.div>

        {/* ── 02 · Tools module (fills remaining height) ── */}
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, delay: 0.05 }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex min-h-0 flex-1 flex-col border border-te-gray/60 bg-te-surface">
            <ToolTabs tool={activeTool} onChange={setActiveTool} />
            <AnimatePresence mode="wait">
              <ToolBody
                key={activeTool}
                tool={activeTool}
                hasInput={hasText}
                onUseAsInput={useToolOutputAsInput}
              />
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
