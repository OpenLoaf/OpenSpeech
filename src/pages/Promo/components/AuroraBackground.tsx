import { motion, useReducedMotion } from "framer-motion";

export default function AuroraBackground() {
  const reduce = useReducedMotion() ?? false;

  return (
    <div className="absolute inset-0 overflow-hidden bg-te-bg">
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.5]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "72px 72px",
          maskImage:
            "radial-gradient(ellipse 90% 70% at 50% 40%, #000 30%, transparent 85%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 90% 70% at 50% 40%, #000 30%, transparent 85%)",
        }}
      />

      <motion.div
        className="absolute left-1/2 top-[20%] h-[80vh] w-[110vh] -translate-x-1/2 rounded-full"
        style={{
          background:
            "radial-gradient(ellipse, rgba(255,204,0,0.14) 0%, transparent 65%)",
          filter: "blur(90px)",
        }}
        initial={{ opacity: 0 }}
        animate={reduce ? { opacity: 0.9 } : { opacity: [0.6, 1, 0.6] }}
        transition={{ duration: 11, repeat: Infinity, ease: "easeInOut" }}
      />

      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[35%]"
        style={{
          background:
            "linear-gradient(to top, var(--te-bg) 0%, transparent 100%)",
        }}
      />
    </div>
  );
}
