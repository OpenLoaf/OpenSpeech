import { useRef } from "react";
import {
  motion,
  useScroll,
  useTransform,
  type MotionValue,
} from "framer-motion";
import SectionLabel from "../components/SectionLabel";

const TRANSCRIPT = "帮我把这段周报改得更简洁一点";

export default function DemoSection() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });

  // 全幕进度切成 4 段：键盘按下 / 录音 / 转写 / 注入
  const keyOpacity = useTransform(scrollYProgress, [0, 0.05, 0.2, 0.3], [0, 1, 1, 0.3]);
  const keyScale = useTransform(scrollYProgress, [0, 0.05, 0.2], [0.92, 1.05, 1]);

  const barY = useTransform(scrollYProgress, [0.18, 0.28], [120, 0]);
  const barOpacity = useTransform(scrollYProgress, [0.18, 0.28], [0, 1]);
  const barFadeOut = useTransform(scrollYProgress, [0.85, 0.95], [1, 0]);

  // 录音/转写/注入的状态过渡：scrollYProgress 0.28→0.55 录音；0.55→0.75 转写；0.75→0.9 注入
  const recordingOpacity = useTransform(scrollYProgress, [0.28, 0.32, 0.55, 0.6], [0, 1, 1, 0]);
  const transcribingOpacity = useTransform(scrollYProgress, [0.55, 0.6, 0.75, 0.8], [0, 1, 1, 0]);
  const injectedOpacity = useTransform(scrollYProgress, [0.75, 0.8, 0.95], [0, 1, 1]);

  // 文字流入：从 0.7 开始逐字
  const textProgress = useTransform(scrollYProgress, [0.7, 0.92], [0, TRANSCRIPT.length]);

  return (
    <section
      ref={ref}
      data-promo-section
      style={{ position: "relative" }}
      className="h-[250vh] w-full bg-te-bg"
    >
      <div className="sticky top-0 flex h-screen w-full flex-col items-center justify-center gap-6 overflow-hidden px-6 py-16">
        <SectionLabel index="02" title="CORE DEMO" />

        <div className="relative w-full max-w-3xl">
          <MockBrowser
            transcript={TRANSCRIPT}
            textProgress={textProgress}
            cursorOpacity={recordingOpacity}
          />
          <KeyboardHint opacity={keyOpacity} scale={keyScale} />
        </div>

        <motion.div style={{ y: barY, opacity: barOpacity }}>
          <motion.div style={{ opacity: barFadeOut }}>
            <RecorderBar
              progress={scrollYProgress}
              recording={recordingOpacity}
              transcribing={transcribingOpacity}
              injected={injectedOpacity}
            />
          </motion.div>
        </motion.div>

        <Caption progress={scrollYProgress} />
      </div>
    </section>
  );
}

function MockBrowser({
  transcript,
  textProgress,
  cursorOpacity,
}: {
  transcript: string;
  textProgress: MotionValue<number>;
  cursorOpacity: MotionValue<number>;
}) {
  return (
    <div className="w-full max-w-3xl border border-te-gray bg-te-surface shadow-2xl">
      <div className="flex items-center gap-2 border-b border-te-gray bg-te-bg px-3 py-2">
        <span className="h-2.5 w-2.5 rounded-full bg-te-light-gray/40" />
        <span className="h-2.5 w-2.5 rounded-full bg-te-light-gray/40" />
        <span className="h-2.5 w-2.5 rounded-full bg-te-light-gray/40" />
        <span className="ml-3 truncate text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
          chat · 新建消息
        </span>
      </div>

      <div className="flex flex-col gap-3 p-5">
        <div className="flex items-start gap-3">
          <div className="h-6 w-6 shrink-0 rounded-full bg-te-light-gray/20" />
          <div className="rounded bg-te-surface-hover px-3 py-2 text-sm text-te-light-gray">
            上周的进度怎么样？看下你的周报。
          </div>
        </div>

        <div className="ml-9 mt-1 border-l-2 border-te-accent py-1 pl-4">
          <div className="text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
            input · type or speak
          </div>
          <TypewriterText
            text={transcript}
            progress={textProgress}
            cursorOpacity={cursorOpacity}
          />
        </div>
      </div>
    </div>
  );
}

function TypewriterText({
  text,
  progress,
  cursorOpacity,
}: {
  text: string;
  progress: MotionValue<number>;
  cursorOpacity: MotionValue<number>;
}) {
  return (
    <div className="mt-2 flex flex-wrap items-baseline text-xl font-medium text-te-fg">
      {text.split("").map((char, i) => (
        <TypewriterChar key={i} char={char} index={i} progress={progress} />
      ))}
      <motion.span
        className="ml-0.5 inline-block h-[1.1em] w-[2px] translate-y-[0.15em] bg-te-accent"
        style={{ opacity: cursorOpacity }}
      />
    </div>
  );
}

function TypewriterChar({
  char,
  index,
  progress,
}: {
  char: string;
  index: number;
  progress: MotionValue<number>;
}) {
  const opacity = useTransform(progress, [index, index + 0.6], [0, 1]);
  const y = useTransform(progress, [index, index + 0.6], [6, 0]);
  return <motion.span style={{ opacity, y }}>{char}</motion.span>;
}

function KeyboardHint({
  opacity,
  scale,
}: {
  opacity: MotionValue<number>;
  scale: MotionValue<number>;
}) {
  const keys = ["Ctrl", "Shift", "Space"];
  return (
    <motion.div
      data-promo-hide-mobile
      className="absolute -top-12 right-0 flex items-center gap-2"
      style={{ opacity, scale }}
    >
      <span className="text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
        press
      </span>
      {keys.map((k) => (
        <span
          key={k}
          className="rounded border border-te-accent bg-te-bg px-2 py-1 font-mono text-xs text-te-fg shadow-[0_0_0_3px_rgba(255,204,0,0.2)]"
        >
          {k}
        </span>
      ))}
    </motion.div>
  );
}

function RecorderBar({
  progress,
  recording,
  transcribing,
  injected,
}: {
  progress: MotionValue<number>;
  recording: MotionValue<number>;
  transcribing: MotionValue<number>;
  injected: MotionValue<number>;
}) {
  const timer = useTransform(progress, [0.3, 0.55], [0, 6.4]);

  return (
    <div className="relative flex h-14 w-[420px] items-center gap-3 border border-te-gray bg-te-bg px-4 shadow-2xl">
      <span className="text-[9px] font-bold uppercase tracking-[0.3em] text-te-accent">
        DICTATE
      </span>
      <span className="h-4 w-px bg-te-gray/60" />

      {/* Recording state */}
      <motion.div className="flex flex-1 items-center gap-3" style={{ opacity: recording }}>
        <BreathingDot />
        <Waveform progress={progress} />
        <Timer value={timer} />
      </motion.div>

      {/* Transcribing state */}
      <motion.div
        className="absolute inset-0 flex items-center gap-3 px-4"
        style={{ opacity: transcribing }}
      >
        <span className="text-[9px] font-bold uppercase tracking-[0.3em] text-te-accent">
          DICTATE
        </span>
        <span className="h-4 w-px bg-te-gray/60" />
        <Spinner />
        <span className="text-xs text-te-light-gray">
          Transcribing via realtime-asr…
        </span>
      </motion.div>

      {/* Injected state */}
      <motion.div
        className="absolute inset-0 flex items-center justify-center gap-2"
        style={{ opacity: injected }}
      >
        <span className="text-te-accent">✓</span>
        <span className="text-xs uppercase tracking-[0.3em] text-te-fg">
          inserted
        </span>
      </motion.div>
    </div>
  );
}

function BreathingDot() {
  return (
    <motion.span
      className="block h-2.5 w-2.5 rounded-full bg-red-500"
      animate={{ opacity: [1, 0.4, 1], scale: [1, 0.85, 1] }}
      transition={{ repeat: Infinity, duration: 1.2, ease: "easeInOut" }}
    />
  );
}

function Waveform({ progress }: { progress: MotionValue<number> }) {
  const bars = 28;
  const amplitude = useTransform(progress, [0.28, 0.55], [0.3, 1]);
  return (
    <div className="flex flex-1 items-center gap-[2px]">
      {Array.from({ length: bars }).map((_, i) => (
        <WaveBar key={i} index={i} amplitude={amplitude} />
      ))}
    </div>
  );
}

function WaveBar({
  index,
  amplitude,
}: {
  index: number;
  amplitude: MotionValue<number>;
}) {
  const baseHeight = 6 + Math.abs(Math.sin(index * 0.6)) * 18;
  const height = useTransform(amplitude, (a) => `${baseHeight * a + 3}px`);
  return (
    <motion.span
      className="block w-[2px] bg-te-fg"
      style={{ height }}
      animate={{
        scaleY: [0.6, 1.1, 0.7, 1, 0.5],
      }}
      transition={{
        repeat: Infinity,
        duration: 0.8 + (index % 5) * 0.1,
        ease: "easeInOut",
        delay: (index % 7) * 0.05,
      }}
    />
  );
}

function Timer({ value }: { value: MotionValue<number> }) {
  const display = useTransform(value, (v) => {
    const s = Math.max(0, v);
    const sec = Math.floor(s);
    const ms = Math.floor((s - sec) * 10);
    return `0:0${sec}.${ms}`;
  });
  return (
    <motion.span className="font-mono text-xs text-te-fg">{display}</motion.span>
  );
}

function Spinner() {
  return (
    <motion.span
      className="block h-3 w-3 rounded-full border-2 border-te-accent border-t-transparent"
      animate={{ rotate: 360 }}
      transition={{ repeat: Infinity, duration: 0.9, ease: "linear" }}
    />
  );
}

function Caption({ progress }: { progress: MotionValue<number> }) {
  const lines: { text: string; range: [number, number] }[] = [
    { text: "PRESS · 按下快捷键", range: [0.05, 0.27] },
    { text: "SPEAK · 实时录音 + 波形", range: [0.3, 0.54] },
    { text: "TRANSCRIBE · 大模型转写", range: [0.57, 0.74] },
    { text: "RELEASE · 写入光标位置", range: [0.78, 0.95] },
  ];
  return (
    <div className="pointer-events-none absolute bottom-8 left-1/2 h-4 -translate-x-1/2 text-[10px] uppercase tracking-[0.4em] text-te-light-gray">
      {lines.map((l) => (
        <CaptionLine key={l.text} text={l.text} range={l.range} progress={progress} />
      ))}
    </div>
  );
}

function CaptionLine({
  text,
  range,
  progress,
}: {
  text: string;
  range: [number, number];
  progress: MotionValue<number>;
}) {
  const [a, b] = range;
  const fadeIn = (b - a) * 0.3;
  const fadeOut = (b - a) * 0.3;
  const opacity = useTransform(
    progress,
    [a, a + fadeIn, b - fadeOut, b],
    [0, 1, 1, 0],
  );
  return (
    <motion.div className="absolute inset-x-0 whitespace-nowrap text-center" style={{ opacity }}>
      {text}
    </motion.div>
  );
}
