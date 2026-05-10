import { motion, useScroll, useTransform } from "framer-motion";
import { useRef } from "react";
import AppWindow from "../components/AppWindow";
import { DictionaryStatic } from "../clones/DictionaryStatic";
import { useSectionInView } from "../lib/useSectionInView";

export default function DictionarySection() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const { ref: viewRef, active } = useSectionInView<HTMLDivElement>(0.35);

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "end start"],
  });
  const tilt = useTransform(scrollYProgress, [0, 1], [6, -6]);

  return (
    <section
      ref={sectionRef}
      id="dictionary"
      className="landing-section relative flex min-h-screen items-center overflow-hidden py-24"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute right-0 top-0 h-[500px] w-[500px] rounded-full bg-te-accent/10 blur-[140px]" />
        <div className="absolute bottom-0 left-0 h-[400px] w-[400px] rounded-full bg-te-accent/8 blur-[120px]" />
      </div>

      <div
        ref={viewRef}
        className="relative mx-auto flex w-full max-w-7xl flex-col gap-14 px-6 lg:px-12"
      >
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
          transition={{ duration: 0.9 }}
          className="flex flex-col items-center gap-4 text-center"
        >
          <span className="te-eyebrow">04 · Custom Dictionary</span>
          <h2 className="font-mono text-[clamp(2rem,4.6vw,3.6rem)] font-bold leading-[1.05] tracking-tighter text-te-fg">
            <span>同事的英文名，</span>
            <span className="bg-gradient-to-r from-te-accent to-te-accent/80 bg-clip-text text-transparent">
              再也不会写错
            </span>
          </h2>
          <p className="max-w-2xl text-balance text-base leading-relaxed text-te-light-gray md:text-lg">
            把人名、品牌、术语写进词典；勾你的领域，AI 不再瞎改专有词。
          </p>
        </motion.div>

        <div className="relative w-full" style={{ perspective: 1800 }}>
          <motion.div
            initial={{ opacity: 0, y: 60, rotateX: 14 }}
            animate={
              active
                ? { opacity: 1, y: 0, rotateX: 0 }
                : { opacity: 0, y: 60, rotateX: 14 }
            }
            transition={{ duration: 1.0, ease: [0.22, 1, 0.36, 1] }}
            style={{
              transformStyle: "preserve-3d",
              rotateX: tilt,
              transformOrigin: "50% 100%",
            }}
            className="relative"
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-20 -bottom-12 h-32 rounded-full bg-te-accent/25 opacity-60 blur-3xl"
            />
            <AppWindow
              title="OpenSpeech"
              subtitle="Dictionary · 14 条 · 3 领域"
              bodyClassName="relative"
            >
              <DictionaryStatic />
            </AppWindow>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
