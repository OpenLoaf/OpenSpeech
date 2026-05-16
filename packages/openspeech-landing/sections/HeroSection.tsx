import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import { PulsarGrid } from "../clones/PulsarGrid";
import { HeroDemo } from "../clones/PromoDemoStatic";
import { useSectionInView } from "../lib/useSectionInView";

/**
 * Hero v7 —— 大牌动画版
 *  · 主标题字符 stagger（blur+y+opacity，Linear / Stripe 同款入场）
 *  · CTA hover scale 1.03 / tap 0.98
 *  · demo 容器 max-w-4xl 自动撑下 880px panel
 */

const HEADLINE_LEFT = "说出来，".split("");
const HEADLINE_RIGHT = "写下来。".split("");

function CharStagger({
  chars,
  baseDelay = 0,
  step = 0.05,
  className,
}: {
  chars: string[];
  baseDelay?: number;
  step?: number;
  className?: string;
}) {
  return (
    <span className={className}>
      {chars.map((c, i) => (
        <motion.span
          key={`${c}-${i}`}
          initial={{ opacity: 0, y: 24, filter: "blur(10px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{
            duration: 0.85,
            delay: baseDelay + i * step,
            ease: [0.16, 1, 0.3, 1],
          }}
          className="inline-block"
        >
          {c}
        </motion.span>
      ))}
    </span>
  );
}
export default function HeroSection() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const { ref: inViewRef, active } = useSectionInView<HTMLDivElement>(0.3);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start start", "end start"],
  });

  const headerOpacity = useTransform(scrollYProgress, [0, 0.5], [1, 0]);
  const demoY = useTransform(scrollYProgress, [0, 1], [0, -80]);
  const gridOpacity = useTransform(scrollYProgress, [0, 0.6], [0.35, 0]);

  return (
    <section
      ref={sectionRef}
      id="hero"
      className="landing-section relative flex min-h-screen flex-col items-center justify-center overflow-hidden pt-24 pb-20"
    >
      {/* PulsarGrid 底板 + 中央暗罩，让前景突出 */}
      <motion.div
        aria-hidden
        style={{ opacity: gridOpacity }}
        className="pointer-events-none absolute inset-0 -z-20"
      >
        <PulsarGrid />
        <div className="absolute inset-x-0 top-0 h-32 bg-gradient-to-b from-te-bg to-transparent" />
        <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-te-bg to-transparent" />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 70% 60% at 50% 50%, rgba(10,10,10,0.78) 0%, rgba(10,10,10,0.35) 45%, rgba(10,10,10,0) 80%)",
          }}
        />
      </motion.div>

      {/* 黄色辉光 */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/3 h-[640px] w-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-te-accent/8 blur-[140px]" />
      </div>

      {/* 顶部：主标题 + 副标题 + CTA —— 仅 3 块，给 demo 让位 */}
      <motion.div
        style={{ opacity: headerOpacity }}
        className="relative z-10 mx-auto flex w-full max-w-5xl flex-col items-center gap-6 px-6 text-center"
      >
        <h1
          style={{ letterSpacing: "-0.025em" }}
          className="font-sans text-[clamp(2.8rem,7.2vw,6.4rem)] font-bold leading-[1.02]"
        >
          <CharStagger chars={HEADLINE_LEFT} className="text-te-fg" />
          <span className="relative inline-block align-baseline">
            <CharStagger
              chars={HEADLINE_RIGHT}
              baseDelay={HEADLINE_LEFT.length * 0.05 + 0.05}
              step={0.06}
              className="text-te-accent"
            />
            {/* 装饰横线：标题字符进完后再 scaleX 划出 */}
            <motion.span
              aria-hidden
              initial={{ scaleX: 0, opacity: 0 }}
              animate={{ scaleX: 1, opacity: 1 }}
              transition={{
                duration: 0.9,
                delay: 0.85,
                ease: [0.16, 1, 0.3, 1],
              }}
              style={{ originX: 0 }}
              className="absolute inset-x-2 -bottom-1 h-[2px] bg-gradient-to-r from-transparent via-te-accent/65 to-transparent"
            />
            <span
              aria-hidden
              className="absolute -inset-4 -z-10 rounded-full bg-te-accent/22 blur-3xl"
            />
          </span>
        </h1>

        <motion.p
          initial={{ opacity: 0, y: 12, filter: "blur(6px)" }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          transition={{ duration: 0.9, delay: 0.95, ease: [0.16, 1, 0.3, 1] }}
          className="text-[15px] tracking-normal text-te-light-gray md:text-[17px]"
        >
          中译英、改邮件、写报告 ——
          <span className="text-te-fg"> 一个键</span>。
        </motion.p>

        {/* CTA */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.9, delay: 1.15, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-wrap items-center justify-center gap-3"
        >
          <motion.a
            href="#download"
            whileHover={{ scale: 1.04, y: -1 }}
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="inline-flex items-center gap-2 bg-te-accent px-7 py-3 text-[14px] font-medium text-te-accent-fg shadow-[0_10px_30px_-8px_rgba(244,209,57,0.4)] transition-[filter,box-shadow] hover:brightness-110 hover:shadow-[0_14px_40px_-8px_rgba(244,209,57,0.55)]"
          >
            免费下载
          </motion.a>
          <motion.a
            href="#hero-demo"
            whileHover={{ scale: 1.04, y: -1 }}
            whileTap={{ scale: 0.97 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="inline-flex items-center gap-2 border border-te-gray/60 px-7 py-3 text-[14px] text-te-light-gray transition-colors hover:border-te-accent hover:text-te-accent"
          >
            看 30 秒演示 <span className="ml-0.5 opacity-70">↓</span>
          </motion.a>
        </motion.div>
      </motion.div>

      {/* 演示区 —— 紧贴 header 之下；section 用 justify-center 把整块垂直居中 */}
      <motion.div
        ref={inViewRef}
        id="hero-demo"
        style={{ y: demoY }}
        className="relative z-10 mx-auto mt-10 w-full max-w-4xl px-4 md:mt-14"
      >
        <HeroDemo active={active} />
      </motion.div>

      {/* 底部下滑箭头 —— 极简，无文字 */}
      <motion.a
        href="#why-not-ime"
        aria-label="scroll down"
        animate={{ y: [0, 6, 0] }}
        transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
        className="absolute bottom-5 left-1/2 -translate-x-1/2 text-base text-te-light-gray/45 hover:text-te-accent"
      >
        ↓
      </motion.a>
    </section>
  );
}
