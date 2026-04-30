import { motion } from "framer-motion";
import { PulsarGrid } from "@/components/PulsarGrid";

export default function HeroSection() {
  return (
    <section
      data-promo-section
      className="relative flex min-h-screen w-full items-center justify-center overflow-hidden"
    >
      <div className="absolute inset-0">
        <PulsarGrid />
      </div>

      <motion.div
        className="absolute top-0 left-0 h-px bg-gradient-to-r from-te-accent via-te-accent/60 to-transparent"
        initial={{ width: 0 }}
        animate={{ width: "60%" }}
        transition={{ duration: 1.8, ease: "easeOut" }}
      />

      <motion.div
        className="absolute top-20 right-[4vw] z-10 hidden items-center gap-2 font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray/60 md:flex"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.8, delay: 0.6 }}
      >
        <span className="relative flex size-1.5">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-te-accent opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-te-accent" />
        </span>
        在线运行
      </motion.div>

      <div className="relative z-10 flex flex-col items-center gap-8 px-[4vw] text-center">
        <motion.div
          className="font-mono text-xs uppercase tracking-[0.3em] text-te-light-gray/60"
          initial={{ opacity: 0, y: 8 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
        >
          [01] · OPENSPEECH
        </motion.div>

        <motion.h1
          className="font-mono font-bold leading-[0.95] tracking-tighter text-te-fg text-[clamp(2.5rem,9vw,7rem)]"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, delay: 0.1 }}
        >
          <span className="block">动嘴说，</span>
          <span className="block">
            让<span className="text-te-accent">键</span>盘休息。
          </span>
        </motion.h1>

        <motion.p
          className="max-w-xl text-sm leading-relaxed text-te-light-gray/70 md:text-base"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.3 }}
        >
          按下快捷键说话，AI 自动转写、清洗口误、注入到任意应用 · macOS / Windows / Linux
        </motion.p>

        <motion.div
          className="mt-2 flex flex-col items-center gap-3 sm:flex-row sm:gap-4"
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.45 }}
        >
          <a
            href="#download"
            className="border border-te-accent bg-te-accent px-8 py-3 font-mono text-xs uppercase tracking-[0.15em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
          >
            免费下载
          </a>
          <a
            href="#demo"
            className="border border-te-gray/40 px-8 py-3 font-mono text-xs uppercase tracking-[0.15em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          >
            观看演示
          </a>
        </motion.div>
      </div>

      <motion.div
        className="absolute bottom-6 left-1/2 z-10 flex -translate-x-1/2 flex-col items-center gap-2 font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/50"
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 0.8 }}
      >
        <span>向下滚动</span>
        <motion.span
          aria-hidden
          animate={{ y: [0, 6, 0] }}
          transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
        >
          ↓
        </motion.span>
      </motion.div>
    </section>
  );
}
