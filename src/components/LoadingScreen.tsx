import { motion } from "framer-motion";
import { PulsarGrid } from "@/components/PulsarGrid";

/**
 * 应用启动时的全屏 loading 界面。
 * TE 工业风：黑底 + 黄点缀 + Space Mono + 脉冲网格动画。
 */
export function LoadingScreen() {
  return (
    <section className="relative h-svh w-full overflow-hidden bg-te-bg">
      {/* 交互式脉冲网格动画背景 */}
      <PulsarGrid />

      {/* 边缘径向渐变遮罩 */}
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        style={{
          background:
            "radial-gradient(ellipse 80% 60% at 50% 50%, transparent 20%, rgba(0,0,0,0.6) 60%, black 100%)",
        }}
      />

      {/* 顶部黄色点缀线动画 */}
      <motion.div
        className="absolute top-0 left-0 z-[2] h-px bg-te-accent"
        style={{
          background:
            "linear-gradient(to right, var(--te-accent), transparent)",
        }}
        initial={{ width: "0%" }}
        animate={{ width: "60%" }}
        transition={{ duration: 1.8, ease: "easeOut" }}
      />

      {/* 主要内容 */}
      <div className="relative z-10 flex h-full flex-col items-center justify-center">
        {/* 顶部 logo */}
        <motion.img
          src="/logo-write.png"
          alt=""
          aria-hidden
          draggable={false}
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.2 }}
          className="mb-6 size-16 select-none md:size-20"
        />

        {/* 顶部标签 */}
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.3 }}
          className="mb-8"
        >
          <span
            className="inline-flex items-center gap-2 border border-te-gray px-3 py-1 font-mono text-xs tracking-[0.2em] text-te-light-gray uppercase backdrop-blur-sm"
            style={{ backgroundColor: "rgba(0,0,0,0.6)" }}
          >
            <motion.span
              className="inline-block size-1.5 bg-te-accent"
              animate={{ opacity: [1, 0.3, 1] }}
              transition={{ duration: 2, repeat: Infinity }}
            />
            INITIALIZING
          </span>
        </motion.div>

        {/* 主标题 */}
        <motion.h1
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.4 }}
          className="mb-4 text-center font-mono leading-[0.9] font-bold tracking-tighter text-te-fg"
          style={{ fontSize: "clamp(3.5rem, 12vw, 8rem)" }}
        >
          OPEN<span className="text-te-accent">SPEECH</span>
        </motion.h1>

        {/* 副标题 */}
        <motion.p
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.7 }}
          className="mb-10 text-center font-mono text-sm tracking-[0.2em] text-te-light-gray uppercase md:text-base"
        >
          Speak less, write more.
        </motion.p>

        {/* 加载进度指示器 */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 1.0 }}
          className="flex flex-col items-center gap-4"
        >
          <div className="relative h-px w-48 overflow-hidden bg-te-gray">
            <motion.div
              className="absolute inset-y-0 left-0 h-full bg-te-accent"
              animate={{ x: ["-100%", "200%"] }}
              transition={{
                duration: 1.6,
                repeat: Infinity,
                ease: "easeInOut",
              }}
              initial={{ width: "40%" }}
            />
          </div>
          <motion.span
            className="font-mono text-xs tracking-[0.3em] text-te-light-gray uppercase opacity-70"
            animate={{ opacity: [0.4, 1, 0.4] }}
            transition={{ duration: 2, repeat: Infinity }}
          >
            Loading
          </motion.span>
        </motion.div>
      </div>

      {/* 底部黄色点缀线 */}
      <motion.div
        className="absolute right-0 bottom-0 z-[2] h-px"
        style={{
          background:
            "linear-gradient(to left, var(--te-accent), transparent)",
        }}
        initial={{ width: "0%" }}
        animate={{ width: "40%" }}
        transition={{ duration: 1.8, delay: 0.5, ease: "easeOut" }}
      />
    </section>
  );
}
