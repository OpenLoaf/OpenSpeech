import { motion, useScroll, useTransform } from "framer-motion";
import { useRef, useState } from "react";
import { useSectionInView } from "../lib/useSectionInView";
import AppWindow from "../components/AppWindow";
import {
  MeetingsLiveStatic,
  type MeetingsView,
} from "../clones/MeetingsLiveStatic";

export default function MeetingSection() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const { ref: viewRef, active } = useSectionInView<HTMLDivElement>(0.25, {
    sticky: true,
  });
  const [view, setView] = useState<MeetingsView>("live");

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "end start"],
  });
  // 滚动绑定的轻微 tilt；rotateX 单一来源，不再与进入动画的 keyframe 抢控制权
  const tilt = useTransform(scrollYProgress, [0, 1], [4, -4]);

  const subtitle =
    view === "live" ? "会议录制中… 12:34" : "会议纪要 · 12:34";

  return (
    <section
      ref={sectionRef}
      id="meeting"
      className="landing-section relative flex min-h-screen items-center overflow-hidden py-24"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/2 h-[700px] w-[700px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-te-accent/8 blur-[160px]" />
      </div>

      <div
        ref={viewRef}
        className="relative mx-auto flex w-full max-w-7xl flex-col gap-14 px-6 lg:px-12"
      >
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }}
          transition={{ duration: 0.7 }}
          className="flex flex-col items-center gap-4 text-center"
        >
          <span className="te-eyebrow">03 · Meeting Recorder</span>
          <h2 className="font-mono text-[clamp(2rem,4.6vw,3.6rem)] font-bold leading-[1.05] tracking-tighter text-te-fg">
            <span>开会的时候，</span>
            <span className="bg-gradient-to-r from-te-accent to-te-accent/80 bg-clip-text text-transparent">
              它在记笔记
            </span>
          </h2>
          <p className="max-w-2xl text-balance text-base leading-relaxed text-te-light-gray md:text-lg">
            实时转写、说话人区分、AI 自动生成 Markdown 纪要 —
            散会即拿到结构化决策与待办。
          </p>
        </motion.div>

        <div className="relative w-full" style={{ perspective: 1800 }}>
          <motion.div
            initial={{ opacity: 0, y: 32 }}
            animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 32 }}
            transition={{ duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
            style={{
              transformStyle: "preserve-3d",
              rotateX: tilt,
              transformOrigin: "50% 100%",
            }}
            className="relative mx-auto w-full max-w-5xl"
          >
            <div
              aria-hidden
              className="pointer-events-none absolute inset-x-20 -bottom-12 h-32 rounded-full bg-te-accent/25 opacity-60 blur-3xl"
            />
            <AppWindow
              title="OpenSpeech"
              subtitle={subtitle}
              bodyClassName="bg-te-bg"
            >
              <MeetingsLiveStatic active={active} onViewChange={setView} />
            </AppWindow>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
