import { motion, useScroll } from "framer-motion";
import TopNav from "./components/TopNav";
import SectionIndicator from "./components/SectionIndicator";
import HeroSection from "./sections/HeroSection";
import WhyNotImeSection from "./sections/WhyNotImeSection";
import AccuracySection from "./sections/AccuracySection";
import DictionarySection from "./sections/DictionarySection";
import MeetingSection from "./sections/MeetingSection";
import CTASection from "./sections/CTASection";

// 6 段叙事：钩（Hero）→ 差异化锚点（凭什么换）→ 解（润色对比）→ 深（词典）→ 拓（会议）→ 收（隐私 + 下载）
const SECTIONS = [
  { id: "hero", label: "首页" },
  { id: "accuracy", label: "润色" },
  { id: "dictionary", label: "词典" },
  { id: "meeting", label: "会议" },
  { id: "download", label: "下载" },
];

export default function LandingPage() {
  const { scrollYProgress } = useScroll();

  return (
    <div className="relative w-full bg-te-bg text-te-fg">
      {/* 顶部进度条 */}
      <motion.div
        style={{ scaleX: scrollYProgress }}
        className="fixed inset-x-0 top-0 z-50 h-[2px] origin-left bg-te-accent"
      />
      <TopNav />
      <SectionIndicator sections={SECTIONS} />

      <main className="relative">
        <HeroSection />
        <WhyNotImeSection />
        <AccuracySection />
        <DictionarySection />
        <MeetingSection />
        <CTASection />
      </main>

      <footer className="relative border-t border-te-gray/30 bg-te-bg py-10 text-center">
        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray">
          OpenSpeech © 2026 · Voice Typing for Every App
        </p>
      </footer>
    </div>
  );
}
