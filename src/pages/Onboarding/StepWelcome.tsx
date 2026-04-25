import { motion } from "framer-motion";
import { ArrowRight } from "lucide-react";
import { HotkeyPreview } from "@/components/HotkeyPreview";

// Step 1：用首页 HOTKEY CARD 同款组件让用户实际按一下快捷键，立刻看到高亮反馈。
// 不要求按对——只要按了就过；下一步按钮始终启用。
// 布局与 Step 2/3 对齐：pt-16 pb-6 + max-w-2xl，顶部标题，中部 flex-1 居中，底部按钮。

export function StepWelcome({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex h-full w-full flex-col overflow-hidden px-8 pt-24 pb-24">
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="mx-auto flex h-full w-full max-w-2xl flex-col"
      >
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.3em]">
            <span className="text-te-light-gray">// welcome to</span>
            <span className="size-1.5 bg-te-accent" aria-hidden />
            <span className="font-bold tracking-[0.25em]">
              <span className="text-te-fg">OPEN</span>
              <span className="text-te-accent">SPEECH</span>
            </span>
          </div>
          <h1 className="font-mono text-[clamp(2.5rem,6vw,4.5rem)] font-bold leading-[0.95] tracking-tighter text-te-fg">
            说出来。
            <span className="text-te-accent">就成文。</span>
          </h1>
          <p className="mt-2 max-w-xl font-sans text-xs leading-relaxed text-te-light-gray md:text-sm">
            按住一个快捷键开口说话，松开后文字立即出现在你正在使用的任何 App 里。
            不绑定编辑器，不订阅，不上传录音。
          </p>
        </div>

        <div className="flex flex-1 items-center justify-center">
          <motion.div
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.4, delay: 0.15 }}
            className="w-full border border-te-gray/60 bg-te-surface px-5 py-8"
          >
            <HotkeyPreview index="试一下" hint="按一下试试 / 看到高亮就对了" />
          </motion.div>
        </div>

        <motion.button
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.4, delay: 0.3 }}
          type="button"
          onClick={onNext}
          className="group mt-6 inline-flex items-center gap-3 self-center border border-te-accent bg-te-accent px-6 py-2.5 font-mono text-sm font-bold uppercase tracking-[0.2em] text-te-accent-fg transition-colors hover:bg-te-accent/90"
        >
          <span>开始使用</span>
          <ArrowRight className="size-4 transition-transform group-hover:translate-x-1" />
        </motion.button>
      </motion.div>
    </div>
  );
}
