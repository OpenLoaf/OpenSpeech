import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Check, Diamond, X } from "lucide-react";
import { detectPlatform, type Platform } from "@/lib/platform";

type SegKind = "keep" | "filler" | "correction";
type Segment = { text: string; kind: SegKind };

type DemoLocale = {
  raw: Segment[];
  polishedHeader: string;
  polishedList: string[];
  scratchPath: string;
  scratchFooterPrompt: string;
  charsUnit: string;
  liveLabel: string;
  waiting: string;
  listening: string;
};

const LOCALES: Record<"zh-CN" | "en" | "zh-TW", DemoLocale> = {
  "zh-CN": {
    raw: [
      { text: "嗯，", kind: "filler" },
      { text: "我们这周要做三件事", kind: "keep" },
      { text: "啊", kind: "filler" },
      { text: "。第一个，", kind: "keep" },
      { text: "呃，", kind: "filler" },
      { text: "把", kind: "keep" },
      { text: "那个", kind: "filler" },
      { text: "登录页面…不对不对，是", kind: "correction" },
      { text: "注册页面修一下", kind: "keep" },
      { text: "。然后", kind: "keep" },
      { text: "呢", kind: "filler" },
      { text: "，把数据库迁移搞完", kind: "keep" },
      { text: "。最后，把测试覆盖率提到 80% 以上。", kind: "keep" },
    ],
    polishedHeader: "本周任务 · 共 3 项",
    polishedList: ["修改注册页面", "完成数据库迁移", "测试覆盖率提升至 80% 以上"],
    scratchPath: "~/scratch.md",
    scratchFooterPrompt: "输入 · 按一下快捷键开始 · 再按一下结束",
    charsUnit: "字",
    liveLabel: "实时",
    waiting: "// 等待按键",
    listening: "// 正在听...",
  },
  en: {
    raw: [
      { text: "Um, ", kind: "filler" },
      { text: "we've got three things to ship this week", kind: "keep" },
      { text: ", uh", kind: "filler" },
      { text: ". First, ", kind: "keep" },
      { text: "uh, ", kind: "filler" },
      { text: "fix the ", kind: "keep" },
      { text: "you know, ", kind: "filler" },
      { text: "login page... wait no, the ", kind: "correction" },
      { text: "signup page", kind: "keep" },
      { text: ". Then ", kind: "keep" },
      { text: "well, ", kind: "filler" },
      { text: "finish the database migration", kind: "keep" },
      { text: ". Finally, lift test coverage above 80%.", kind: "keep" },
    ],
    polishedHeader: "This week · 3 items",
    polishedList: [
      "Fix the signup page",
      "Finish the database migration",
      "Lift test coverage above 80%",
    ],
    scratchPath: "~/scratch.md",
    scratchFooterPrompt: "input · press hotkey to start · press again to stop",
    charsUnit: "chars",
    liveLabel: "live",
    waiting: "// awaiting hotkey",
    listening: "// listening...",
  },
  "zh-TW": {
    raw: [
      { text: "嗯，", kind: "filler" },
      { text: "我們這週要做三件事", kind: "keep" },
      { text: "啊", kind: "filler" },
      { text: "。第一個，", kind: "keep" },
      { text: "呃，", kind: "filler" },
      { text: "把", kind: "keep" },
      { text: "那個", kind: "filler" },
      { text: "登入頁面…不對不對，是", kind: "correction" },
      { text: "註冊頁面修一下", kind: "keep" },
      { text: "。然後", kind: "keep" },
      { text: "呢", kind: "filler" },
      { text: "，把資料庫遷移搞完", kind: "keep" },
      { text: "。最後，把測試覆蓋率提到 80% 以上。", kind: "keep" },
    ],
    polishedHeader: "本週任務 · 共 3 項",
    polishedList: ["修改註冊頁面", "完成資料庫遷移", "測試覆蓋率提升至 80% 以上"],
    scratchPath: "~/scratch.md",
    scratchFooterPrompt: "輸入 · 按一下快捷鍵開始 · 再按一下結束",
    charsUnit: "字",
    liveLabel: "即時",
    waiting: "// 等待按鍵",
    listening: "// 正在聽...",
  },
};

function useDemoLocale(): DemoLocale {
  return useMemo(() => {
    if (typeof window === "undefined") return LOCALES["zh-CN"];
    const lang = new URLSearchParams(window.location.search).get("lang");
    if (lang === "en") return LOCALES.en;
    if (lang === "zh-TW" || lang === "zhTW" || lang === "tw") return LOCALES["zh-TW"];
    return LOCALES["zh-CN"];
  }, []);
}

// 对齐 src/pages/Overlay 的真实 RecordingState：preparing / recording / transcribing / injecting / idle
export type Stage =
  | "idle"
  | "recording"
  | "transcribing"
  | "polishing"
  | "injecting";

export const STAGE_DURATION: Record<Stage, number> = {
  idle: 1000,
  recording: 1500,
  transcribing: 2400,
  polishing: 1500,
  injecting: 2200,
};

export const NEXT_STAGE: Record<Stage, Stage> = {
  idle: "recording",
  recording: "transcribing",
  transcribing: "polishing",
  polishing: "injecting",
  injecting: "idle",
};

export function useStageCycle(active: boolean): Stage {
  const [stage, setStage] = useState<Stage>("idle");
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!active || reduce) return;
    const t = setTimeout(() => setStage(NEXT_STAGE[stage]), STAGE_DURATION[stage]);
    return () => clearTimeout(t);
  }, [stage, active, reduce]);

  useEffect(() => {
    if (reduce) setStage("injecting");
  }, [reduce]);

  return stage;
}

// 对齐 LiveDictationPanel.statusCopy 的工业 tag 风格
const STAGE_TAG: Record<Stage, string> = {
  idle: "// 待机",
  recording: "// 收音中",
  transcribing: "// 转写中",
  polishing: "// 清洗中",
  injecting: "// 注入中",
};

const CAPTIONS: Record<Stage, string> = {
  idle: "// 待机 · 按一下快捷键开始",
  recording: "// 收音中 · 再按一次快捷键结束并转写",
  transcribing: "// 转写中 · 正在转写…",
  polishing: "// 清洗中 · AI 抹平口误并重排",
  injecting: "// 注入中 · 写入光标位置…",
};

export default function DemoSection() {
  const [active, setActive] = useState(false);
  const stage = useStageCycle(active);

  return (
    <section
      id="demo"
      data-promo-section
      className="relative bg-te-bg px-[4vw] py-[clamp(5rem,11vw,9rem)]"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.35]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
          maskImage:
            "radial-gradient(ellipse 70% 60% at 50% 30%, #000 30%, transparent 90%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 70% 60% at 50% 30%, #000 30%, transparent 90%)",
        }}
      />
      <div className="relative mx-auto max-w-6xl">
        <motion.div
          className="mb-14 flex flex-col gap-6 border-b border-te-gray/30 pb-8 md:mb-20 md:flex-row md:items-end md:justify-between"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="flex flex-col gap-3">
            <span className="font-mono text-xs uppercase tracking-[0.3em] text-te-light-gray/50">
              [02] · Core Demo
            </span>
            <h2 className="max-w-2xl font-mono text-3xl font-bold leading-[1.05] tracking-tighter text-te-fg md:text-5xl">
              说一段大白话，落到光标里就是
              <span className="text-te-accent">结构化文档</span>。
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-te-light-gray/60 md:text-right">
            录音 → 转写 → AI 清洗。口误、语气词、自我纠错全部抹平，再按你想要的格式重排。
          </p>
        </motion.div>

        <motion.div
          className="relative flex flex-col items-center gap-10"
          initial={{ opacity: 0, y: 24 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-15% 0px" }}
          transition={{ duration: 0.6 }}
          onViewportEnter={() => setActive(true)}
          onViewportLeave={() => setActive(false)}
        >
          <div className="relative w-full max-w-4xl">
            <ScratchPanel stage={stage} />
          </div>

          <div className="flex flex-wrap items-center justify-center gap-4">
            <ShortcutKeys stage={stage} />
            <RecorderBar stage={stage} />
          </div>
        </motion.div>
      </div>
    </section>
  );
}

export function ScratchPanel({ stage }: { stage: Stage }) {
  const locale = useDemoLocale();
  const rawText = useMemo(() => locale.raw.map((s) => s.text).join(""), [locale]);
  const charCount =
    stage === "injecting"
      ? locale.polishedList.join("").length + locale.polishedHeader.length
      : stage === "polishing"
        ? rawText.length
        : 0;
  const isLive = stage === "recording" || stage === "transcribing";

  return (
    <div className="border border-te-gray/30 p-px">
      <div className="flex flex-col bg-te-surface">
        <div className="flex items-center justify-between gap-3 border-b border-te-gray/30 px-5 py-3">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-te-light-gray/70">
            <span className="text-te-accent">▍</span>
            <span>{locale.scratchPath}</span>
          </div>
          <span className="font-mono text-[11px] uppercase tracking-[0.25em] text-te-accent">
            {STAGE_TAG[stage]}
          </span>
        </div>

        <div className="px-8 py-7 md:px-12 md:py-9">
          <ChatBody stage={stage} />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-te-gray/30 px-5 py-2.5 font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray/40">
          <span>{locale.scratchFooterPrompt}</span>
          <span className="flex items-center gap-2">
            {isLive ? (
              <>
                <motion.span
                  className="size-1.5 rounded-full bg-te-accent"
                  animate={{ opacity: [1, 0.3, 1] }}
                  transition={{ duration: 1.4, repeat: Infinity }}
                />
                {locale.liveLabel}
              </>
            ) : (
              <span>
                {charCount} {locale.charsUnit}
              </span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}

function ChatBody({ stage }: { stage: Stage }) {
  const showList = stage === "injecting";

  return (
    <div className="relative h-[11rem]">
      <AnimatePresence mode="wait" initial={false}>
        {!showList && (
          <motion.div
            key="raw"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.35, ease: "easeOut" }}
          >
            <RawTranscript stage={stage} />
          </motion.div>
        )}
        {showList && (
          <motion.div
            key="list"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.5, ease: "easeOut", delay: 0.1 }}
          >
            <PolishedList />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function RawTranscript({ stage }: { stage: Stage }) {
  const locale = useDemoLocale();
  const rawText = useMemo(() => locale.raw.map((s) => s.text).join(""), [locale]);
  const [count, setCount] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (stage === "transcribing") {
      setCount(0);
      const total = rawText.length;
      const step = Math.max(28, Math.floor(STAGE_DURATION.transcribing / total));
      const id = setInterval(() => {
        setCount((c) => {
          if (c >= total) {
            clearInterval(id);
            return c;
          }
          return c + 1;
        });
      }, step);
      return () => clearInterval(id);
    }
    if (stage === "polishing") setCount(rawText.length);
    if (stage === "idle" || stage === "recording") setCount(0);
  }, [stage, rawText]);

  useEffect(() => {
    if (reduce) setCount(rawText.length);
  }, [reduce, rawText]);

  const showCursor = stage === "recording" || stage === "transcribing";

  if (stage === "idle" || stage === "recording") {
    return (
      <div className="flex min-h-[1.6em] items-baseline">
        <span className="font-mono text-sm text-te-light-gray/40">
          {stage === "recording" ? locale.listening : locale.waiting}
        </span>
        <motion.span
          className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-te-accent"
          animate={
            stage === "recording" ? { opacity: [1, 0.2, 1] } : { opacity: 0.3 }
          }
          transition={{
            repeat: stage === "recording" ? Infinity : 0,
            duration: 1,
            ease: "easeInOut",
          }}
        />
      </div>
    );
  }

  let consumed = 0;
  return (
    <div className="text-lg leading-relaxed text-te-fg md:text-xl">
      {locale.raw.map((seg, i) => {
        const start = consumed;
        consumed = start + seg.text.length;
        const visible = Math.max(0, Math.min(seg.text.length, count - start));
        if (visible === 0) return null;
        const slice = seg.text.slice(0, visible);
        const isMarked = stage === "polishing" && seg.kind !== "keep";
        return (
          <motion.span
            key={i}
            className="inline align-baseline transition-colors"
            animate={{
              opacity: isMarked ? 0.45 : 1,
              color: isMarked
                ? seg.kind === "correction"
                  ? "var(--te-accent)"
                  : "var(--te-light-gray)"
                : "var(--te-fg)",
            }}
            transition={{ duration: 0.35 }}
            style={isMarked ? { textDecoration: "line-through" } : undefined}
          >
            {slice}
          </motion.span>
        );
      })}
      {showCursor && (
        <motion.span
          className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-te-accent"
          animate={{ opacity: [1, 0.2, 1] }}
          transition={{ repeat: Infinity, duration: 1, ease: "easeInOut" }}
        />
      )}
    </div>
  );
}

function PolishedList() {
  const locale = useDemoLocale();
  return (
    <div className="flex flex-col gap-3 text-lg leading-relaxed text-te-fg md:text-xl">
      <div className="font-mono text-lg text-te-accent md:text-xl">
        {locale.polishedHeader}
      </div>
      <ol className="flex flex-col gap-2">
        {locale.polishedList.map((item, i) => (
          <motion.li
            key={item}
            className="flex items-baseline gap-3"
            initial={{ opacity: 0, x: -6 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ duration: 0.35, delay: 0.15 + i * 0.08 }}
          >
            <span className="font-mono text-base text-te-accent md:text-lg">
              {i + 1}.
            </span>
            <span>{item}</span>
          </motion.li>
        ))}
      </ol>
    </div>
  );
}

// 平台对应默认快捷键（与 src/lib/hotkey.ts getDefaultBindings 完全一致）
function defaultKeys(platform: Platform): { glyph?: ReactNode; label: string }[] {
  if (platform === "macos") {
    return [{ label: "Fn" }, { glyph: "⌃", label: "Ctrl" }];
  }
  if (platform === "windows") {
    return [{ glyph: "⌃", label: "Ctrl" }, { glyph: <WinIcon />, label: "Win" }];
  }
  return [
    { glyph: "⌃", label: "Ctrl" },
    { glyph: <Diamond size={11} strokeWidth={2.5} />, label: "Super" },
  ];
}

// 复刻 HotkeyPreview.WinIcon
function WinIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 16 16"
      fill="currentColor"
      aria-hidden
    >
      <path d="M1 3.5l5.5-.75v5.5H1V3.5z" />
      <path d="M7.5 2.5L15 1v7H7.5V2.5z" />
      <path d="M1 9h5.5v5.5L1 13.5V9z" />
      <path d="M7.5 9H15v7l-7.5-1.5V9z" />
    </svg>
  );
}

export function ShortcutKeys({ stage }: { stage: Stage }) {
  const platform = useMemo(() => detectPlatform(), []);
  const keys = useMemo(() => defaultKeys(platform), [platform]);
  const pressed = stage === "recording";

  return (
    <div className="flex h-[52px] items-center gap-2">
      {keys.map((k, i) => (
        <Fragment key={k.label}>
          {i > 0 && (
            <span className="font-mono text-base text-te-light-gray/60">+</span>
          )}
          <ShortcutKey pressed={pressed} glyph={k.glyph} label={k.label} />
        </Fragment>
      ))}
    </div>
  );
}

function ShortcutKey({
  pressed,
  glyph,
  label,
}: {
  pressed: boolean;
  glyph?: ReactNode;
  label: string;
}) {
  return (
    <motion.span
      animate={{ y: pressed ? 2 : 0, scale: pressed ? 0.97 : 1 }}
      transition={{ duration: 0.12, ease: "easeOut" }}
      className={
        "inline-flex h-[52px] min-w-[64px] items-center justify-center gap-1.5 border px-3 font-mono text-xs uppercase tracking-[0.15em] transition-colors " +
        (pressed
          ? "border-te-accent bg-te-accent/15 text-te-accent shadow-[inset_0_-3px_0_0_var(--te-accent)]"
          : "border-te-gray bg-te-bg text-te-fg shadow-[inset_0_-3px_0_0_var(--te-gray)]")
      }
    >
      {glyph && <span className="opacity-80">{glyph}</span>}
      <span>{label}</span>
    </motion.span>
  );
}

export function RecorderBar({ stage }: { stage: Stage }) {
  const canConfirm = stage === "recording";
  const canCancel = stage === "recording";

  return (
    <div className="flex h-[52px] w-[340px] max-w-full items-center gap-2 border border-te-gray bg-te-bg px-2">
      <button
        type="button"
        disabled={!canCancel}
        aria-label="cancel"
        className={
          canCancel
            ? "flex size-9 shrink-0 items-center justify-center border border-te-gray text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
            : "flex size-9 shrink-0 items-center justify-center border border-te-gray/40 text-te-light-gray/40"
        }
      >
        <X className="size-4" />
      </button>

      <div className="flex min-w-0 flex-1 items-center justify-center">
        <AnimatePresence mode="wait" initial={false}>
          {stage === "recording" && (
            <motion.div
              key="wave"
              className="flex h-full w-full items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <CapsuleWaveform />
            </motion.div>
          )}

          {stage === "transcribing" && (
            <CapsuleStatus key="transcribing" label="// 转写中" />
          )}

          {stage === "polishing" && (
            <CapsuleStatus key="polishing" label="// 清洗中" />
          )}

          {stage === "injecting" && (
            <CapsuleStatus key="injecting" label="// 注入中" />
          )}

          {stage === "idle" && (
            <motion.div
              key="idle"
              className="flex h-full w-full items-center justify-center"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.12 }}
            >
              <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-te-light-gray/50">
                // 待机
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <button
        type="button"
        disabled={!canConfirm}
        aria-label="confirm"
        className={
          canConfirm
            ? "flex size-9 shrink-0 items-center justify-center border border-te-accent text-te-accent transition-colors hover:bg-te-accent hover:text-te-accent-fg"
            : "flex size-9 shrink-0 items-center justify-center border border-te-gray/40 text-te-light-gray/40"
        }
      >
        <Check className="size-4" />
      </button>
    </div>
  );
}

function CapsuleStatus({ label }: { label: string }) {
  return (
    <motion.div
      className="flex h-full w-full flex-col items-center justify-center gap-1.5 px-2"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.12 }}
    >
      <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-te-fg">
        {label}
      </span>
      <SlidingProgress />
    </motion.div>
  );
}

function CapsuleWaveform() {
  const bars = 36;
  return (
    <div className="flex h-9 w-full items-center gap-[2px]">
      {Array.from({ length: bars }).map((_, i) => {
        const seed = Math.abs(Math.sin(i * 0.7)) * 0.7 + 0.3;
        return (
          <motion.span
            key={i}
            className="block flex-1 rounded-[1px] bg-te-accent"
            style={{ height: "100%", originY: 0.5 }}
            animate={{ scaleY: [seed * 0.3, seed * 1, seed * 0.5, seed * 0.85, seed * 0.4] }}
            transition={{
              repeat: Infinity,
              duration: 0.7 + (i % 5) * 0.1,
              ease: "easeInOut",
              delay: (i % 7) * 0.04,
            }}
          />
        );
      })}
    </div>
  );
}

function SlidingProgress() {
  return (
    <div className="relative h-px w-24 overflow-hidden bg-te-gray/40">
      <motion.span
        className="absolute inset-y-0 bg-te-accent"
        style={{ width: "33%" }}
        initial={{ left: "-33%" }}
        animate={{ left: "100%" }}
        transition={{ repeat: Infinity, duration: 1.1, ease: "linear" }}
      />
    </div>
  );
}

export function Caption({ stage }: { stage: Stage }) {
  return (
    <div className="relative h-4 w-full text-center">
      <AnimatePresence mode="wait">
        <motion.div
          key={stage}
          className="absolute inset-x-0 whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.4em] text-te-light-gray md:text-[11px]"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
        >
          {CAPTIONS[stage]}
        </motion.div>
      </AnimatePresence>
    </div>
  );
}
