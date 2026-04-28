import { useRef } from "react";
import { motion, useScroll, useTransform } from "framer-motion";
import SectionLabel from "../components/SectionLabel";

export default function HeroSection() {
  const ref = useRef<HTMLDivElement>(null);
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start start", "end end"],
  });

  const strikeWidth = useTransform(scrollYProgress, [0.1, 0.45], ["0%", "100%"]);
  const slowOpacity = useTransform(scrollYProgress, [0.45, 0.55], [1, 0]);
  const speakOpacity = useTransform(scrollYProgress, [0.5, 0.7], [0, 1]);
  const speakY = useTransform(scrollYProgress, [0.5, 0.7], [20, 0]);
  const cursorOpacity = useTransform(scrollYProgress, [0.7, 0.75], [0, 1]);

  return (
    <section
      ref={ref}
      data-promo-section
      style={{ position: "relative" }}
      className="h-[150vh] w-full"
    >
      <div className="sticky top-0 flex h-screen w-full items-center justify-center overflow-hidden">
        <SectionLabel index="01" title="HERO" />
        <BackgroundWaveform progress={scrollYProgress} />

        <div className="relative flex flex-col items-center gap-6 px-8 text-center">
          <div className="relative grid">
            <motion.div
              className="relative col-start-1 row-start-1"
              style={{ opacity: slowOpacity }}
            >
              <h1 className="font-mono text-5xl font-bold uppercase tracking-tight text-te-fg sm:text-7xl md:text-8xl">
                Typing is slow.
              </h1>
              <motion.div
                className="absolute left-0 top-1/2 h-[6px] -translate-y-1/2 bg-te-accent"
                style={{ width: strikeWidth }}
              />
            </motion.div>

            <motion.h1
              className="col-start-1 row-start-1 font-mono text-5xl font-bold uppercase tracking-tight text-te-fg sm:text-7xl md:text-8xl"
              style={{ opacity: speakOpacity, y: speakY }}
            >
              Just speak.
              <motion.span
                className="ml-2 inline-block h-[0.85em] w-[0.5em] translate-y-[0.05em] bg-te-accent align-middle"
                style={{ opacity: cursorOpacity }}
              />
            </motion.h1>
          </div>

          <motion.p
            className="mt-4 max-w-md text-xs uppercase tracking-[0.3em] text-te-light-gray"
            style={{ opacity: speakOpacity }}
          >
            OpenSpeech · cross-platform voice typing
          </motion.p>
        </div>
      </div>
    </section>
  );
}

function BackgroundWaveform({ progress }: { progress: import("framer-motion").MotionValue<number> }) {
  const opacity = useTransform(progress, [0, 0.5, 1], [0.04, 0.08, 0.12]);
  return (
    <motion.svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1200 600"
      preserveAspectRatio="none"
      style={{ opacity }}
    >
      {Array.from({ length: 80 }).map((_, i) => {
        const x = (i + 0.5) * 15;
        const h = 40 + Math.abs(Math.sin(i * 0.4)) * 200;
        return (
          <rect
            key={i}
            x={x}
            y={300 - h / 2}
            width={2}
            height={h}
            fill="currentColor"
            className="text-te-fg"
          />
        );
      })}
    </motion.svg>
  );
}
