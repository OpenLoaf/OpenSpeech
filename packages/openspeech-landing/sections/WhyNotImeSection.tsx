import { motion } from "framer-motion";
import { useSectionInView } from "../lib/useSectionInView";

/**
 * Hero ↔ AccuracySection 之间的 transition 钩子条，回答用户最高频疑问：
 * "我已经用搜狗 / 系统自带听写了，凭什么换 OpenSpeech？"
 *
 * 不是独立大 section，是一条横向 strip，瘦但密度高。
 */

const COMPARE = [
  { who: "系统听写", limit: "仅限自家 App" },
  { who: "拼音输入法", limit: "还得自己打字" },
  { who: "OpenSpeech", limit: "按住说就行", accent: true },
];

export default function WhyNotImeSection() {
  const { ref, active } = useSectionInView<HTMLDivElement>(0.4);

  return (
    <section
      id="why-not-ime"
      className="relative w-full border-y border-te-gray/30 bg-te-surface/30 py-14"
    >
      <div
        ref={ref}
        className="mx-auto flex max-w-6xl flex-col gap-8 px-6 lg:flex-row lg:items-center lg:justify-between lg:gap-12 lg:px-12"
      >
        {/* 左：标题 + 解释 */}
        <motion.div
          initial={{ opacity: 0, x: -20 }}
          animate={active ? { opacity: 1, x: 0 } : { opacity: 0, x: -20 }}
          transition={{ duration: 0.7 }}
          className="flex flex-col gap-3 lg:max-w-md"
        >
          <h2 className="font-mono text-2xl font-bold leading-tight tracking-tighter text-te-fg md:text-3xl">
            不是又一个语音输入法。
          </h2>
          <p className="text-sm leading-relaxed text-te-light-gray md:text-base">
            系统自带听写只在备忘录能用，搜狗讯飞是拼音输入工具——OpenSpeech 按住快捷键，在你
            <span className="text-te-fg"> 此刻光标所在的任何输入框 </span>
            直接出字，并用 AI 顺手整理。
          </p>
        </motion.div>

        {/* 右：三 chip 对比 */}
        <div className="flex flex-col gap-2 lg:flex-row lg:items-center lg:gap-3">
          {COMPARE.map((c, i) => (
            <motion.div
              key={c.who}
              initial={{ opacity: 0, y: 12 }}
              animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
              transition={{ duration: 0.5, delay: 0.1 + i * 0.1 }}
              className={
                "flex items-center justify-between gap-3 border px-4 py-3 font-mono text-xs uppercase tracking-[0.15em] transition-colors lg:flex-col lg:items-start lg:gap-1.5 lg:px-5 " +
                (c.accent
                  ? "border-te-accent bg-te-accent/10 text-te-accent"
                  : "border-te-gray/50 bg-te-bg text-te-light-gray line-through decoration-te-light-gray/40")
              }
            >
              <span className="text-[11px]">{c.who}</span>
              <span className={c.accent ? "text-te-fg" : "text-te-light-gray/70"}>
                {c.limit}
              </span>
            </motion.div>
          ))}
        </div>
      </div>
    </section>
  );
}
