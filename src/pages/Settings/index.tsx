import { motion } from "framer-motion";
import SettingsContent from "@/components/SettingsContent";

export default function SettingsPage() {
  return (
    <section className="h-full overflow-y-auto bg-te-bg px-[4vw] py-[clamp(4rem,10vw,8rem)]">
      <div className="mx-auto max-w-6xl">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="mb-3 font-mono text-xs uppercase tracking-[0.25em] text-te-light-gray">
            [04] 系统
          </div>
          <h1 className="font-mono text-3xl font-bold tracking-tighter text-te-fg md:text-4xl">
            设置
          </h1>
          <p className="mt-3 max-w-xl font-sans text-sm text-te-light-gray">
            配置听写、模型端点与应用行为。改动即时生效，无需保存。
          </p>
        </motion.div>

        {/* Accent line */}
        <div className="mt-8 h-px bg-gradient-to-r from-te-accent to-transparent" />

        {/* 共享两列布局（/settings 路由下给一个固定高度容器，让左固定右滚动生效） */}
        <div className="mt-10 h-[70vh] min-h-[500px] border border-te-gray/30">
          <SettingsContent />
        </div>
      </div>
    </section>
  );
}
