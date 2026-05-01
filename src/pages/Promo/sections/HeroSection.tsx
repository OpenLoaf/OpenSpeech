import { motion, type Variants } from "framer-motion";
import { useState } from "react";
import AuroraBackground from "../components/AuroraBackground";
import {
  RecorderBar,
  ScratchPanel,
  ShortcutKeys,
  useStageCycle,
} from "./DemoSection";

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: {
      duration: 0.75,
      delay: 0.1 + i * 0.12,
      ease: [0.25, 0.4, 0.25, 1] as [number, number, number, number],
    },
  }),
};

export default function HeroSection() {
  const [active] = useState(true);
  const stage = useStageCycle(active);

  return (
    <section
      data-promo-section
      className="relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden pt-24 pb-12"
    >
      <AuroraBackground />

      <div className="relative z-10 mx-auto flex w-full max-w-6xl flex-col items-center gap-6 px-[4vw] text-center">
        <motion.h1
          custom={0}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="whitespace-nowrap font-mono font-bold leading-[1] tracking-tighter text-[clamp(1.5rem,4.2vw,3.25rem)]"
        >
          <span className="bg-gradient-to-b from-te-fg to-te-fg/70 bg-clip-text text-transparent">
            Open
          </span>
          <span className="relative bg-gradient-to-r from-te-accent to-te-accent/80 bg-clip-text text-transparent">
            Speech
            <span className="absolute -inset-1 -z-10 blur-2xl bg-te-accent/30" />
          </span>
          <span className="mx-3 text-te-light-gray/40">/</span>
          <span className="bg-gradient-to-b from-te-fg to-te-fg/70 bg-clip-text text-transparent">
            动嘴说，让
          </span>
          <span className="relative bg-gradient-to-r from-te-accent to-te-accent/80 bg-clip-text text-transparent">
            键盘
            <span className="absolute -inset-1 -z-10 blur-2xl bg-te-accent/30" />
          </span>
          <span className="bg-gradient-to-b from-te-fg to-te-fg/70 bg-clip-text text-transparent">
            休息。
          </span>
        </motion.h1>

        <motion.p
          custom={1}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="max-w-xl text-balance text-sm leading-relaxed text-te-light-gray/70 md:text-base"
        >
          按下快捷键说话，AI 自动转写、清洗口误、注入到任意应用。
        </motion.p>

        <motion.div
          custom={2}
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="relative mt-2 w-full max-w-3xl"
        >
          <div
            className="absolute -inset-x-12 -inset-y-8 -z-10 opacity-70"
            style={{
              background:
                "radial-gradient(ellipse 60% 50% at 50% 50%, rgba(255,204,0,0.18), transparent 70%)",
              filter: "blur(40px)",
            }}
          />
          <div className="border border-te-gray/40 bg-te-bg/60 p-px shadow-[0_30px_120px_-20px_rgba(255,204,0,0.18)] backdrop-blur-sm">
            <ScratchPanel stage={stage} />
          </div>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-4">
            <ShortcutKeys stage={stage} />
            <RecorderBar stage={stage} />
          </div>
        </motion.div>

      </div>

      <motion.a
        href="#download"
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, delay: 0.7, ease: [0.25, 0.4, 0.25, 1] }}
        className="group absolute bottom-8 left-1/2 z-20 inline-flex -translate-x-1/2 flex-col items-center gap-2"
      >
        <span className="inline-flex items-center gap-2.5 border border-te-gray/50 bg-te-bg/30 px-6 py-2 font-mono text-[11px] uppercase tracking-[0.25em] text-te-fg/70 backdrop-blur-md transition-colors group-hover:border-te-accent group-hover:text-te-accent">
          免费下载
          <span className="text-te-light-gray/50 group-hover:text-te-accent/70">
            macOS · Windows · Linux
          </span>
        </span>
        <motion.span
          aria-hidden
          animate={{ y: [0, 5, 0] }}
          transition={{ duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
          className="font-mono text-sm text-te-light-gray/40 group-hover:text-te-accent"
        >
          ↓
        </motion.span>
      </motion.a>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[5] h-32 bg-gradient-to-t from-te-bg to-transparent" />
    </section>
  );
}
