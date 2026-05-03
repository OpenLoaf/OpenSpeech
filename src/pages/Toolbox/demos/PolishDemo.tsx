import { useMemo } from "react";
import { AnimatePresence, motion } from "framer-motion";
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

type PolishSeg = { text: string; filler?: boolean };
type PolishLocale = { raw: PolishSeg[]; polished: string };

const POLISH_DATA: Record<LocaleKey, PolishLocale> = {
  "zh-CN": {
    raw: [
      { text: "嗯，", filler: true },
      { text: "今天那个会议吧" },
      { text: "，我觉得就是" },
      { text: "那个，", filler: true },
      { text: "进度有点慢" },
      { text: "，就，", filler: true },
      { text: "有点拖沓。" },
    ],
    polished: "今天的会议进度略显缓慢、稍有拖沓。",
  },
  en: {
    raw: [
      { text: "Um, ", filler: true },
      { text: "yeah so the meeting today" },
      { text: ", you know, ", filler: true },
      { text: "kinda dragged on" },
      { text: ", uh, ", filler: true },
      { text: "we didn't really get through it." },
    ],
    polished:
      "Today's meeting ran longer than planned, and we didn't fully cover it.",
  },
  "zh-TW": {
    raw: [
      { text: "嗯，", filler: true },
      { text: "今天那個會議吧" },
      { text: "，我覺得就是" },
      { text: "那個，", filler: true },
      { text: "進度有點慢" },
      { text: "，就，", filler: true },
      { text: "有點拖沓。" },
    ],
    polished: "今天的會議進度略顯緩慢、稍有拖沓。",
  },
};

const STAGES = ["typing", "transform", "result", "rest"] as const;
type Stage = (typeof STAGES)[number];
const DURATIONS: Record<Stage, number> = {
  typing: 1800,
  transform: 900,
  result: 1700,
  rest: 1100,
};

export function PolishDemo() {
  const locale = useLocaleKey();
  const data = POLISH_DATA[locale];
  const stage = useStageCycle(STAGES, DURATIONS);

  const rawText = useMemo(() => data.raw.map((s) => s.text).join(""), [data]);
  const typingActive = stage === "typing";
  const typedCount = useTypewriter(rawText, typingActive, DURATIONS.typing);
  const fullyTyped = stage !== "typing";
  const dimFillers =
    stage === "transform" || stage === "result" || stage === "rest";
  const showOut = stage === "result" || stage === "rest";

  let consumed = 0;
  return (
    <DemoFrame>
      <DemoLine label="// IN" labelClass="text-te-light-gray/60">
        <p className="min-h-[1.5em] font-mono text-[15px] leading-relaxed text-te-light-gray">
          {data.raw.map((seg, i) => {
            const start = consumed;
            consumed += seg.text.length;
            const visibleLen = fullyTyped
              ? seg.text.length
              : Math.max(0, Math.min(seg.text.length, typedCount - start));
            if (visibleLen === 0) return null;
            const slice = seg.text.slice(0, visibleLen);
            const dim = dimFillers && seg.filler;
            return (
              <motion.span
                key={i}
                animate={{
                  opacity: dim ? 0.3 : 1,
                  color: dim ? "var(--te-light-gray)" : "var(--te-fg)",
                }}
                transition={{ duration: 0.35 }}
                style={dim ? { textDecoration: "line-through" } : undefined}
              >
                {slice}
              </motion.span>
            );
          })}
          {typingActive && typedCount < rawText.length ? <BlinkingCursor /> : null}
        </p>
      </DemoLine>
      <DemoArrow pulsing={stage === "transform"} />
      <DemoLine label="// OUT" labelClass="text-te-accent">
        <div className="min-h-[1.5em]">
          <AnimatePresence mode="wait">
            {showOut ? (
              <motion.p
                key="out"
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4 }}
                className="font-mono text-[15px] leading-relaxed text-te-fg"
              >
                {data.polished}
              </motion.p>
            ) : null}
          </AnimatePresence>
        </div>
      </DemoLine>
    </DemoFrame>
  );
}
