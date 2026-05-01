import { motion, useScroll } from "framer-motion";
import Navigation from "./components/Navigation";
import Footer from "./components/Footer";
import HeroSection from "./sections/HeroSection";
import FeaturesSection from "./sections/FeaturesSection";
import FAQSection from "./sections/FAQSection";
import CTASection from "./sections/CTASection";

export default function PromoPage() {
  const { scrollYProgress } = useScroll();
  return (
    <div className="w-full overflow-x-hidden bg-te-bg text-te-fg font-sans">
      <motion.div
        className="fixed inset-x-0 top-0 z-[100] h-[2px] origin-left bg-te-accent"
        style={{ scaleX: scrollYProgress }}
      />
      <Navigation />
      <main>
        <HeroSection />
        <FeaturesSection />
        <FAQSection />
        <CTASection />
      </main>
      <Footer />
    </div>
  );
}
