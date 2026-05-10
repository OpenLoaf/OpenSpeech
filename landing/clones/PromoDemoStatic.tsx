import {
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { Mic, X } from "lucide-react";

/**
 * Hero 演示组件 v7 —— 大牌感重做
 *  · 按键 (Fn + Ctrl) 内嵌 panel footer，作为浮窗自身的一部分
 *  · 整窗口 max-w 880，更宽敞
 *  · idle 微呼吸（5s y±3px），录音时整窗 scale 1.018 + 辉光放大
 *  · stage 切换 spring scale 0.96→1，重量感
 *  · 进入动画 spring + cubic-bezier(0.16, 1, 0.3, 1) Apple ease-out-expo
 */

export type Stage = "idle" | "recording" | "transcribing" | "output" | "hold";

interface DemoCase {
  id: string;
  raw: string;
  zh: string;
  en: string;
}

const DEMO_CASES: DemoCase[] = [
  {
    id: "meeting",
    raw: "嗯就是会议改到下午三点，麻烦同步一下大家",
    zh: "会议改到下午 3 点，麻烦同步给大家。",
    en: "The meeting is moved to 3 PM. Please sync everyone.",
  },
  {
    id: "client",
    raw: "跟客户说一下，新版方案下周一之前给到",
    zh: "新版方案我下周一之前发给您。",
    en: "I'll send the revised proposal by next Monday.",
  },
  {
    id: "weekend",
    raw: "周末要加班，那个聚会下周再约吧",
    zh: "周末要加班，下周再约吧。",
    en: "I have to work this weekend. Let's plan for next week.",
  },
];

const STAGE_DURATION: Record<Stage, number> = {
  idle: 1300,
  recording: 2800,
  transcribing: 700,
  output: 5500,
  hold: 1700,
};

const NEXT_STAGE: Record<Stage, Stage> = {
  idle: "recording",
  recording: "transcribing",
  transcribing: "output",
  output: "hold",
  hold: "idle",
};

export function useStageCycle(active: boolean, onCycle?: () => void): Stage {
  const [stage, setStage] = useState<Stage>("idle");
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!active || reduce) return;
    const t = setTimeout(() => {
      const next = NEXT_STAGE[stage];
      setStage(next);
      if (next === "idle") onCycle?.();
    }, STAGE_DURATION[stage]);
    return () => clearTimeout(t);
  }, [stage, active, reduce, onCycle]);

  useEffect(() => {
    if (reduce) setStage("output");
  }, [reduce]);

  return stage;
}

interface HeroDemoProps {
  active: boolean;
}

export function HeroDemo({ active }: HeroDemoProps) {
  const [caseIdx, setCaseIdx] = useState(0);
  const onCycle = () => setCaseIdx((i) => (i + 1) % DEMO_CASES.length);
  const stage = useStageCycle(active, onCycle);
  const demo = DEMO_CASES[caseIdx];

  return (
    <div className="flex w-full justify-center">
      <OpenSpeechPanel stage={stage} demo={demo} />
    </div>
  );
}

// ──────────── OpenSpeechPanel ────────────

function OpenSpeechPanel({ stage, demo }: { stage: Stage; demo: DemoCase }) {
  const reduce = useReducedMotion();
  const recording = stage === "recording";
  const pressed = recording;

  return (
    <div
      className="relative w-full max-w-[880px]"
      style={{ perspective: "2400px" }}
    >
      {/* 桌面光投影 + 黄辉光：录音时增强 */}
      <motion.div
        aria-hidden
        animate={{
          opacity: recording ? 0.95 : 0.55,
          scale: recording ? 1.18 : 1,
        }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
        className="pointer-events-none absolute -inset-x-10 -bottom-14 h-44 rounded-[50%] bg-te-accent/22 blur-[80px]"
      />

      {/* 进入动画外层 + idle 微呼吸 */}
      <motion.div
        initial={{ opacity: 0, y: 32, scale: 0.95 }}
        animate={
          reduce
            ? { opacity: 1, y: 0, scale: 1 }
            : { opacity: 1, y: [0, -3, 0], scale: 1 }
        }
        transition={{
          opacity: { duration: 0.9, ease: [0.16, 1, 0.3, 1] },
          scale: { duration: 0.9, ease: [0.16, 1, 0.3, 1] },
          y: reduce
            ? { duration: 0.9, ease: [0.16, 1, 0.3, 1] }
            : { duration: 5, repeat: Infinity, ease: "easeInOut" },
        }}
      >
        {/* stage 控制：rotate + 录音 scale */}
        <motion.div
          animate={{
            rotateX: recording ? 4 : 8,
            rotateY: -3,
            scale: recording ? 1.018 : 1,
          }}
          transition={{ duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
          style={{
            transformStyle: "preserve-3d",
            boxShadow:
              "0 90px 140px -40px rgba(0,0,0,0.88), 0 60px 90px -30px rgba(244,209,57,0.22), 0 0 0 1px rgba(255,255,255,0.04), inset 0 1px 0 0 rgba(255,255,255,0.07)",
          }}
          className="relative overflow-hidden rounded-[28px] border border-te-gray/40 bg-te-surface"
        >
          {/* 玻璃高光 */}
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0 z-20 rounded-[28px]"
            style={{
              background:
                "linear-gradient(135deg, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 32%, rgba(255,255,255,0) 68%, rgba(255,255,255,0.04) 100%)",
            }}
          />

          {/* 录音时整窗的内辉光环 */}
          <AnimatePresence>
            {recording && (
              <motion.div
                aria-hidden
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
                className="pointer-events-none absolute inset-0 z-20 rounded-[28px] ring-1 ring-te-accent/30"
              />
            )}
          </AnimatePresence>

          {/* Header */}
          <div className="relative z-10 flex items-center justify-between gap-3 border-b border-te-gray/30 px-7 py-4">
            <div className="flex min-w-0 items-center gap-3">
              <span className="font-mono text-[12.5px] font-bold tracking-[0.2em]">
                <span className="text-te-fg">OPEN</span>
                <span className="text-te-accent">·SPEECH</span>
              </span>
              <span aria-hidden className="h-3 w-px bg-te-gray/50" />
              <span className="inline-flex items-center gap-1.5 text-[12.5px] tracking-normal text-te-light-gray">
                <span className="size-1.5 rounded-full bg-te-accent" />
                听写 + 翻译
              </span>
            </div>
            <button
              type="button"
              tabIndex={-1}
              aria-label="close"
              className="grid size-5 place-items-center text-te-light-gray/60"
            >
              <X className="size-3.5" strokeWidth={2.2} />
            </button>
          </div>

          {/* Body —— stage 切换：spring scale 重量感 */}
          <div className="relative z-10 min-h-[340px] px-8 py-8">
            <AnimatePresence mode="wait">
              {stage === "idle" && (
                <motion.div
                  key="idle"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{
                    type: "spring",
                    stiffness: 280,
                    damping: 30,
                  }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3.5"
                >
                  <motion.div
                    animate={{ scale: [1, 1.08, 1] }}
                    transition={{
                      duration: 2.2,
                      repeat: Infinity,
                      ease: "easeInOut",
                    }}
                  >
                    <Mic
                      className="size-11 text-te-light-gray/35"
                      strokeWidth={1.4}
                    />
                  </motion.div>
                  <span className="text-[13.5px] tracking-normal text-te-light-gray/55">
                    等待开口…
                  </span>
                </motion.div>
              )}

              {stage === "recording" && (
                <motion.div
                  key="recording"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{
                    type: "spring",
                    stiffness: 280,
                    damping: 30,
                  }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-5 px-2"
                >
                  <span className="flex items-center gap-2 text-[13px] tracking-normal text-te-accent">
                    <motion.span
                      className="size-1.5 rounded-full bg-te-accent"
                      animate={{ opacity: [1, 0.3, 1] }}
                      transition={{
                        duration: 1,
                        repeat: Infinity,
                        ease: "easeInOut",
                      }}
                    />
                    <span className="font-mono text-[11px] uppercase tracking-[0.25em]">
                      REC
                    </span>
                    <span className="opacity-60">·</span>
                    <span>正在听</span>
                  </span>
                  <div className="w-full">
                    <SymmetricWaveform active height={140} />
                  </div>
                </motion.div>
              )}

              {stage === "transcribing" && (
                <motion.div
                  key="transcribing"
                  initial={{ opacity: 0, scale: 0.96 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.96 }}
                  transition={{
                    type: "spring",
                    stiffness: 280,
                    damping: 30,
                  }}
                  className="absolute inset-0 flex flex-col items-center justify-center gap-3"
                >
                  <span className="text-[13.5px] tracking-normal text-te-light-gray/75">
                    整理 + 翻译中…
                  </span>
                  <div className="w-[260px]">
                    <FrozenScanline />
                  </div>
                </motion.div>
              )}

              {(stage === "output" || stage === "hold") && (
                <motion.div
                  key={`output-${demo.id}`}
                  initial={{ opacity: 0, scale: 0.97 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.97 }}
                  transition={{
                    type: "spring",
                    stiffness: 260,
                    damping: 30,
                  }}
                  className="flex flex-col gap-3.5"
                >
                  {/* 你说 —— 头像（左） + 灰气泡 */}
                  <motion.div
                    initial={{ opacity: 0, x: -10, scale: 0.96 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 280,
                      damping: 26,
                    }}
                    className="flex max-w-[78%] items-start gap-3 self-start"
                  >
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-te-gray/40 bg-te-gray/30 text-[14px] font-medium text-te-light-gray">
                      你
                    </div>
                    <div className="flex flex-col gap-0.5 rounded-2xl rounded-tl-sm bg-te-gray/30 px-4 py-2.5">
                      <div className="text-[11px] tracking-normal text-te-light-gray/55">
                        你说
                      </div>
                      <span className="text-[14.5px] leading-snug text-te-light-gray">
                        「{demo.raw}」
                      </span>
                    </div>
                  </motion.div>

                  {/* AI 整理 + 翻译 —— 黄边气泡 + ✦ 头像（右） */}
                  <motion.div
                    initial={{ opacity: 0, x: 10, scale: 0.96 }}
                    animate={{ opacity: 1, x: 0, scale: 1 }}
                    transition={{
                      type: "spring",
                      stiffness: 260,
                      damping: 26,
                      delay: 0.45,
                    }}
                    className="flex max-w-[88%] items-start gap-3 self-end"
                  >
                    <div className="flex flex-col gap-1 rounded-2xl rounded-tr-sm border border-te-accent/40 bg-te-accent/[0.08] px-4 py-3 shadow-[0_8px_30px_-12px_rgba(244,209,57,0.35)]">
                      <div className="flex items-center gap-1.5 text-[11px] tracking-normal text-te-accent">
                        <span>OpenSpeech · 整理 + 翻译</span>
                      </div>
                      <BilingualOutput
                        zh={demo.zh}
                        en={demo.en}
                        startDelay={500}
                      />
                    </div>
                    <div className="flex size-10 shrink-0 items-center justify-center rounded-full border border-te-accent/45 bg-te-accent/15 text-[16px] font-bold text-te-accent">
                      ✦
                    </div>
                  </motion.div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Footer —— 内嵌按键栏 */}
          <div className="relative z-10 border-t border-te-gray/30 bg-te-bg/50 px-7 py-4">
            <div className="flex items-center justify-between gap-4">
              {/* 左：实体按键 + caption */}
              <div className="flex items-center gap-3.5">
                <div className="flex items-center gap-1.5">
                  <KeyCap pressed={pressed} label="Fn" />
                  <span className="font-mono text-[13px] text-te-light-gray/50">
                    +
                  </span>
                  <KeyCap pressed={pressed} glyph="⌃" label="Ctrl" />
                </div>
                <span className="text-[12.5px] tracking-normal text-te-light-gray/65">
                  按住开始说话
                </span>
              </div>
              {/* 右：辅助快捷键 */}
              <div className="flex items-center gap-2.5 text-[11.5px] tracking-normal text-te-light-gray/50">
                <span className="flex items-center gap-1">
                  <span className="font-mono text-te-light-gray/70">⏎</span>
                  写入光标
                </span>
                <span className="opacity-50">·</span>
                <span className="flex items-center gap-1">
                  <span className="font-mono tracking-[0.05em] text-te-light-gray/70">
                    Esc
                  </span>
                  关闭
                </span>
              </div>
            </div>
          </div>

          {/* hold 阶段：右下角"已写入"浮标 */}
          <AnimatePresence>
            {stage === "hold" && (
              <motion.div
                initial={{ opacity: 0, y: -8, scale: 0.88 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.92 }}
                transition={{
                  type: "spring",
                  stiffness: 320,
                  damping: 24,
                }}
                className="absolute right-5 bottom-[88px] z-30 bg-te-accent px-3 py-1.5 text-[11.5px] font-medium tracking-normal text-te-accent-fg shadow-[0_10px_30px_-8px_rgba(244,209,57,0.5)]"
              >
                <span className="mr-0.5 font-mono">✓</span>
                已写入光标
              </motion.div>
            )}
          </AnimatePresence>
        </motion.div>
      </motion.div>
    </div>
  );
}

// ──────────── KeyCap：紧凑按键（panel footer 内嵌用） ────────────

interface KeyCapProps {
  pressed: boolean;
  glyph?: ReactNode;
  label: string;
}

function KeyCap({ pressed, glyph, label }: KeyCapProps) {
  return (
    <motion.span
      animate={{ y: pressed ? 1.5 : 0, scale: pressed ? 0.96 : 1 }}
      transition={{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }}
      className={
        "inline-flex h-9 min-w-[44px] items-center justify-center gap-1 rounded-md border px-2.5 font-mono text-[12px] uppercase tracking-[0.1em] transition-colors " +
        (pressed
          ? "border-te-accent bg-te-accent/15 text-te-accent shadow-[inset_0_-2px_0_0_var(--te-accent),0_0_20px_-4px_rgba(244,209,57,0.5)]"
          : "border-te-gray/55 bg-te-bg text-te-fg shadow-[inset_0_-2px_0_0_rgba(255,255,255,0.05),0_2px_0_0_rgba(0,0,0,0.4)]")
      }
    >
      {glyph && <span className="opacity-80">{glyph}</span>}
      <span>{label}</span>
    </motion.span>
  );
}

// ──────────── 中央对称镜像波形 ────────────

function SymmetricWaveform({
  active,
  height = 88,
}: {
  active: boolean;
  height?: number;
}) {
  const SAMPLES = 68;
  const [amps, setAmps] = useState<number[]>(() => Array(SAMPLES).fill(0.06));
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!active) return;
    const tick = () => {
      const t = performance.now() / 1000;
      const next = Array.from({ length: SAMPLES }, (_, i) => {
        const env = Math.sin((i / (SAMPLES - 1)) * Math.PI);
        const v =
          0.32 * Math.sin(t * 5.6 + i * 0.32) +
          0.18 * Math.sin(t * 12.3 + i * 0.71) +
          0.1 * Math.sin(t * 21.7 + i * 1.31) +
          (Math.random() - 0.5) * 0.1;
        return Math.max(0.06, Math.min(1, env * (0.55 + v)));
      });
      setAmps(next);
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [active]);

  const W = SAMPLES * 4;
  const center = (SAMPLES - 1) / 2;

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${W} ${height}`}
      preserveAspectRatio="none"
      aria-hidden
    >
      {amps.map((amp, i) => {
        const x = i * 4 + 2;
        const halfH = amp * (height / 2 - 4);
        const cy = height / 2;
        const distFromCenter = Math.abs(i - center) / center;
        const opacity = 1 - distFromCenter * 0.55;
        return (
          <line
            key={i}
            x1={x}
            y1={cy - halfH}
            x2={x}
            y2={cy + halfH}
            stroke="var(--te-accent)"
            strokeWidth={1.5}
            strokeLinecap="round"
            opacity={opacity}
            style={{ transition: "all 80ms ease-out" }}
          />
        );
      })}
    </svg>
  );
}

// ──────────── 转写中：扫描光 ────────────

function FrozenScanline() {
  return (
    <div className="relative h-[3px] w-full overflow-hidden bg-te-accent/30">
      <motion.span
        className="absolute inset-y-0 w-1/3 bg-te-accent"
        initial={{ left: "-33%" }}
        animate={{ left: "100%" }}
        transition={{ duration: 0.6, ease: "easeInOut" }}
      />
    </div>
  );
}

// ──────────── 双行（中 + 英）逐字浮现 ────────────

function BilingualOutput({
  zh,
  en,
  startDelay = 0,
}: {
  zh: string;
  en: string;
  startDelay?: number;
}) {
  const [zhCount, setZhCount] = useState(0);
  const [enCount, setEnCount] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) {
      setZhCount(zh.length);
      setEnCount(en.length);
      return;
    }
    setZhCount(0);
    setEnCount(0);

    const total = zh.length + en.length;
    const usable = Math.max(800, STAGE_DURATION.output - startDelay - 700);
    const stepMs = Math.max(28, Math.floor(usable / total));
    const gapTicks = Math.ceil(280 / stepMs);

    let i = 0;
    let j = 0;
    let phase: "zh" | "gap" | "en" | "done" = "zh";
    let gap = 0;
    let intervalId: ReturnType<typeof setInterval> | null = null;

    const startTimer = setTimeout(() => {
      intervalId = setInterval(() => {
        if (phase === "zh") {
          if (i < zh.length) {
            i += 1;
            setZhCount(i);
          } else {
            phase = "gap";
          }
        } else if (phase === "gap") {
          gap += 1;
          if (gap >= gapTicks) phase = "en";
        } else if (phase === "en") {
          if (j < en.length) {
            j += 1;
            setEnCount(j);
          } else {
            phase = "done";
          }
        } else if (intervalId) {
          clearInterval(intervalId);
        }
      }, stepMs);
    }, startDelay);

    return () => {
      clearTimeout(startTimer);
      if (intervalId) clearInterval(intervalId);
    };
  }, [zh, en, reduce, startDelay]);

  const zhDone = zhCount >= zh.length;
  const enStarted = enCount > 0;

  return (
    <div className="flex w-full flex-col gap-1.5 leading-snug">
      <span className="text-[16px] text-te-fg">
        {zh.slice(0, zhCount)}
        {!zhDone && <Cursor size="sm" />}
      </span>
      {(zhDone || enStarted) && (
        <span className="text-[13.5px] italic text-te-light-gray/70">
          {en.slice(0, enCount)}
          {zhDone && enCount < en.length && <Cursor size="sm" />}
        </span>
      )}
    </div>
  );
}

function Cursor({ size = "md" }: { size?: "sm" | "md" }) {
  return (
    <motion.span
      className={
        "ml-0.5 inline-block w-[2px] translate-y-[0.15em] bg-te-accent " +
        (size === "sm" ? "h-[0.9em]" : "h-[1em]")
      }
      animate={{ opacity: [1, 0.2, 1] }}
      transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
    />
  );
}
