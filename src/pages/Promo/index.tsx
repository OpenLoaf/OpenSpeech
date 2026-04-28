import { motion, useScroll } from "framer-motion";
import HeroSection from "./sections/HeroSection";
import DemoSection from "./sections/DemoSection";
import PrivacySection from "./sections/PrivacySection";
import CTASection from "./sections/CTASection";

export default function PromoPage() {
  const { scrollYProgress } = useScroll();
  return (
    <div className="w-full overflow-x-hidden bg-te-bg text-te-fg font-mono">
      <motion.div
        className="fixed inset-x-0 top-0 z-[100] h-[2px] origin-left bg-te-accent"
        style={{ scaleX: scrollYProgress }}
      />
      <ScrollHint />
      <HeroSection />
      <DemoSection />
      <PrivacySection />
      <CTASection />
    </div>
  );
}

function ScrollHint() {
  return (
    <div
      data-promo-hide-mobile
      className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 text-[10px] uppercase tracking-[0.3em] text-te-light-gray opacity-60"
    >
      scroll ↓
    </div>
  );
}
