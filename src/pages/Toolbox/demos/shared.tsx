import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { useTranslation } from "react-i18next";

export type LocaleKey = "zh-CN" | "en" | "zh-TW";

export function useLocaleKey(): LocaleKey {
  const { i18n } = useTranslation();
  const lang = i18n.language ?? "zh-CN";
  if (lang.startsWith("zh-TW") || lang.startsWith("zh-Hant")) return "zh-TW";
  if (lang.startsWith("en")) return "en";
  return "zh-CN";
}

export function useStageCycle<T extends string>(
  stages: readonly T[],
  durations: Record<T, number>,
): T {
  const [stage, setStage] = useState<T>(stages[0]);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) return;
    const t = setTimeout(() => {
      const i = stages.indexOf(stage);
      setStage(stages[(i + 1) % stages.length]);
    }, durations[stage]);
    return () => clearTimeout(t);
  }, [stage, reduce, stages, durations]);

  return stage;
}

export function useTypewriter(
  text: string,
  active: boolean,
  durationMs: number,
): number {
  const [count, setCount] = useState(0);
  const reduce = useReducedMotion();

  useEffect(() => {
    if (!active) {
      setCount(0);
      return;
    }
    if (reduce) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const total = text.length;
    if (total === 0) return;
    const step = Math.max(28, Math.floor(durationMs / total));
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
  }, [text, active, durationMs, reduce]);

  return count;
}

export function DemoFrame({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 w-full flex-1 flex-col justify-between gap-2 border border-te-gray/40 bg-te-bg/40 p-3">
      {children}
    </div>
  );
}

export function DemoLine({
  label,
  labelClass,
  children,
}: {
  label: string;
  labelClass: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5 px-1 py-2 text-left">
      <span
        className={`font-mono text-[11px] uppercase tracking-[0.22em] ${labelClass}`}
      >
        {label}
      </span>
      {children}
    </div>
  );
}

export function DemoArrow({ pulsing = false }: { pulsing?: boolean }) {
  return (
    <div className="flex items-center gap-2 self-start pl-2 font-mono text-[13px] leading-none text-te-accent/70">
      <motion.span
        animate={pulsing ? { opacity: [1, 0.3, 1] } : { opacity: 1 }}
        transition={{ repeat: pulsing ? Infinity : 0, duration: 1 }}
      >
        ↓
      </motion.span>
      {pulsing ? (
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-te-accent/80">
          // running
        </span>
      ) : null}
    </div>
  );
}

export function BlinkingCursor() {
  return (
    <motion.span
      className="ml-0.5 inline-block h-[1em] w-[2px] translate-y-[0.15em] bg-te-accent align-baseline"
      animate={{ opacity: [1, 0.2, 1] }}
      transition={{ repeat: Infinity, duration: 1, ease: "easeInOut" }}
    />
  );
}
