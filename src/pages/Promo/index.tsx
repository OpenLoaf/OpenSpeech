import HeroSection from "./sections/HeroSection";
import DemoSection from "./sections/DemoSection";
import CarouselSection from "./sections/CarouselSection";
import ModesSection from "./sections/ModesSection";
import PlatformsSection from "./sections/PlatformsSection";
import PrivacySection from "./sections/PrivacySection";
import CTASection from "./sections/CTASection";

export default function PromoPage() {
  return (
    <div className="w-full overflow-x-hidden bg-te-bg text-te-fg font-mono">
      <ScrollHint />
      <HeroSection />
      <DemoSection />
      <CarouselSection />
      <ModesSection />
      <PlatformsSection />
      <PrivacySection />
      <CTASection />
    </div>
  );
}

function ScrollHint() {
  return (
    <div className="pointer-events-none fixed bottom-6 left-1/2 z-50 -translate-x-1/2 text-[10px] uppercase tracking-[0.3em] text-te-light-gray opacity-60">
      scroll ↓
    </div>
  );
}
