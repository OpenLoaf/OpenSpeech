import { motion } from "framer-motion";
import {
  BlinkingCursor,
  DemoArrow,
  DemoFrame,
  DemoLine,
  type LocaleKey,
  useLocaleKey,
  useStageCycle,
  useTypewriter,
} from "./shared";

const TTS_DATA: Record<LocaleKey, string> = {
  "zh-CN": "你好，这是朗读功能的演示。",
  en: "Hello, this is a sample of read-aloud.",
  "zh-TW": "你好，這是朗讀功能的演示。",
};

const STAGES = ["typing", "playing", "rest"] as const;
type Stage = (typeof STAGES)[number];
const DURATIONS: Record<Stage, number> = {
  typing: 1400,
  playing: 3200,
  rest: 900,
};

export function TtsDemo() {
  const locale = useLocaleKey();
  const text = TTS_DATA[locale];
  const stage = useStageCycle(STAGES, DURATIONS);

  const typing = stage === "typing";
  const typedCount = useTypewriter(text, typing, DURATIONS.typing);
  const visibleText = typing ? text.slice(0, typedCount) : text;
  const playing = stage === "playing";

  return (
    <DemoFrame>
      <DemoLine label="// TXT" labelClass="text-te-light-gray/60">
        <p className="min-h-[1.5em] font-mono text-[15px] leading-relaxed text-te-fg">
          {visibleText}
          {typing && typedCount < text.length ? <BlinkingCursor /> : null}
        </p>
      </DemoLine>
      <DemoArrow pulsing={playing} />
      <DemoLine label="// AUDIO" labelClass="text-te-accent">
        <div className="flex items-center gap-3">
          <span
            className={
              playing
                ? "flex size-9 shrink-0 items-center justify-center border border-te-accent text-te-accent"
                : "flex size-9 shrink-0 items-center justify-center border border-te-gray/50 text-te-light-gray/50"
            }
          >
            <PlayGlyph />
          </span>
          <div className="flex flex-1 items-center gap-2">
            <Waveform active={playing} />
            <ProgressBar active={playing} duration={DURATIONS.playing} />
          </div>
        </div>
      </DemoLine>
    </DemoFrame>
  );
}

function Waveform({ active }: { active: boolean }) {
  const bars = 28;
  return (
    <div className="flex h-7 flex-1 items-center gap-[2px]">
      {Array.from({ length: bars }).map((_, i) => {
        const seed = Math.abs(Math.sin(i * 0.7)) * 0.7 + 0.3;
        return (
          <motion.span
            key={i}
            className={
              active
                ? "block h-full flex-1 rounded-[1px] bg-te-accent"
                : "block h-full flex-1 rounded-[1px] bg-te-light-gray/25"
            }
            style={{ originY: 0.5 }}
            animate={
              active
                ? { scaleY: [seed * 0.3, seed, seed * 0.5, seed * 0.85, seed * 0.4] }
                : { scaleY: 0.3 }
            }
            transition={
              active
                ? {
                    repeat: Infinity,
                    duration: 0.7 + (i % 5) * 0.1,
                    ease: "easeInOut",
                    delay: (i % 7) * 0.04,
                  }
                : { duration: 0.2 }
            }
          />
        );
      })}
    </div>
  );
}

function ProgressBar({
  active,
  duration,
}: {
  active: boolean;
  duration: number;
}) {
  return (
    <div className="relative h-px w-24 overflow-hidden bg-te-gray/40">
      {active ? (
        <motion.span
          key="run"
          className="absolute inset-y-0 left-0 bg-te-accent"
          initial={{ width: "0%" }}
          animate={{ width: "100%" }}
          transition={{ duration: duration / 1000, ease: "linear" }}
        />
      ) : null}
    </div>
  );
}

function PlayGlyph() {
  return (
    <svg width="11" height="12" viewBox="0 0 9 10" fill="currentColor" aria-hidden>
      <path d="M0 0v10l9-5z" />
    </svg>
  );
}
