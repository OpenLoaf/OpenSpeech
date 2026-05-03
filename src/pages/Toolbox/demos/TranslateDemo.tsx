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

const TRANSLATE_DATA: Record<LocaleKey, { source: string; target: string }> = {
  "zh-CN": {
    source: "今天天气真好，我们去公园散步吧。",
    target: "The weather is wonderful today — let's take a walk in the park.",
  },
  en: {
    source: "今天天气真好，我们去公园散步吧。",
    target: "The weather is wonderful today — let's take a walk in the park.",
  },
  "zh-TW": {
    source: "今天天氣真好，我們去公園散步吧。",
    target: "The weather is wonderful today — let's take a walk in the park.",
  },
};

const STAGES = ["typeSource", "translating", "typeTarget", "rest"] as const;
type Stage = (typeof STAGES)[number];
const DURATIONS: Record<Stage, number> = {
  typeSource: 1500,
  translating: 700,
  typeTarget: 1700,
  rest: 1300,
};

export function TranslateDemo() {
  const locale = useLocaleKey();
  const data = TRANSLATE_DATA[locale];
  const stage = useStageCycle(STAGES, DURATIONS);

  const sourceTyping = stage === "typeSource";
  const sourceFull = stage !== "typeSource";
  const sourceCount = useTypewriter(
    data.source,
    sourceTyping,
    DURATIONS.typeSource,
  );
  const sourceVisible = sourceFull ? data.source.length : sourceCount;

  const targetTyping = stage === "typeTarget";
  const targetVisible = stage === "rest";
  const targetCount = useTypewriter(
    data.target,
    targetTyping,
    DURATIONS.typeTarget,
  );
  const targetText =
    stage === "rest"
      ? data.target
      : targetTyping
        ? data.target.slice(0, targetCount)
        : "";

  return (
    <DemoFrame>
      <DemoLine label="// SRC" labelClass="text-te-light-gray/60">
        <p className="min-h-[1.5em] font-mono text-[15px] leading-relaxed text-te-fg">
          {data.source.slice(0, sourceVisible)}
          {sourceTyping && sourceCount < data.source.length ? (
            <BlinkingCursor />
          ) : null}
        </p>
      </DemoLine>
      <DemoArrow pulsing={stage === "translating"} />
      <DemoLine label="// → EN" labelClass="text-te-accent">
        <p className="min-h-[1.5em] font-mono text-[15px] leading-relaxed text-te-fg">
          {targetText}
          {targetTyping && targetCount < data.target.length ? (
            <BlinkingCursor />
          ) : null}
          {!targetTyping && !targetVisible ? (
            <span className="text-te-light-gray/40">...</span>
          ) : null}
        </p>
      </DemoLine>
    </DemoFrame>
  );
}
