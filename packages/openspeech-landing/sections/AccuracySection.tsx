import { AnimatePresence, motion, useScroll, useTransform } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { Mail, MessageCircle, Languages, FileText } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { useSectionInView } from "../lib/useSectionInView";

type SegKind = "keep" | "filler" | "correction";
interface RawSeg {
  text: string;
  kind: SegKind;
}

interface Scene {
  id: string;
  label: string;
  icon: LucideIcon;
  badge: string;
  raw: RawSeg[];
  refined: string;
  refinedKind: "paragraph" | "list";
  refinedList?: string[];
  refinedHeader?: string;
}

const SCENES: Scene[] = [
  {
    id: "email",
    label: "邮件",
    icon: Mail,
    badge: "Email · 正式 · 中文",
    raw: [
      { text: "嗨，", kind: "filler" },
      { text: "那个", kind: "filler" },
      { text: "我看了你昨天发的方案，", kind: "keep" },
      { text: "嗯，", kind: "filler" },
      { text: "整体没啥大问题，", kind: "keep" },
      { text: "就是", kind: "filler" },
      { text: "表格里第三列那个数据，", kind: "keep" },
      { text: "能不能", kind: "filler" },
      { text: "再核对一下，", kind: "keep" },
      { text: "然后", kind: "filler" },
      { text: "周五前给我一份新的，谢谢啦。", kind: "keep" },
    ],
    refinedKind: "paragraph",
    refined:
      "你好，方案我看过了，整体没问题。麻烦再核对一下表格第三列的数据，周五前发我一份更新版即可。谢谢。",
  },
  {
    id: "chat",
    label: "微信",
    icon: MessageCircle,
    badge: "Chat · 口语 · 自然",
    raw: [
      { text: "啊", kind: "filler" },
      { text: "对了，", kind: "keep" },
      { text: "那个", kind: "filler" },
      { text: "周末聚餐的事，", kind: "keep" },
      { text: "嗯", kind: "filler" },
      { text: "我看大家定的是海底捞，", kind: "keep" },
      { text: "几点啊", kind: "keep" },
      { text: "，我可能要", kind: "keep" },
      { text: "晚一点到", kind: "keep" },
      { text: "，大概", kind: "filler" },
      { text: "七点半左右。", kind: "keep" },
    ],
    refinedKind: "paragraph",
    refined:
      "对了周末聚餐定海底捞了吗？几点开始？我可能晚一点，大约 7:30 到。",
  },
  {
    id: "translate",
    label: "翻译",
    icon: Languages,
    badge: "ZH → EN · 商务",
    raw: [
      { text: "我们", kind: "filler" },
      { text: "下周三下午三点", kind: "keep" },
      { text: "开个会，", kind: "keep" },
      { text: "把", kind: "filler" },
      { text: "这个季度的 KPI 复盘一下，", kind: "keep" },
      { text: "顺便", kind: "filler" },
      { text: "聊一下下个季度的目标。", kind: "keep" },
    ],
    refinedKind: "paragraph",
    refined:
      "Let's set up a meeting next Wednesday at 3pm to review this quarter's KPIs and align on next quarter's goals.",
  },
  {
    id: "doc",
    label: "文档",
    icon: FileText,
    badge: "Doc · 结构化 · 列表",
    raw: [
      { text: "嗯，", kind: "filler" },
      { text: "我们这周要做三件事", kind: "keep" },
      { text: "啊", kind: "filler" },
      { text: "。第一个，", kind: "keep" },
      { text: "呃，", kind: "filler" },
      { text: "把", kind: "keep" },
      { text: "那个", kind: "filler" },
      { text: "登录页面…不对不对，是", kind: "correction" },
      { text: "注册页面修一下", kind: "keep" },
      { text: "。然后", kind: "keep" },
      { text: "呢", kind: "filler" },
      { text: "，把数据库迁移搞完", kind: "keep" },
      { text: "。最后，把测试覆盖率提到 80% 以上。", kind: "keep" },
    ],
    refinedKind: "list",
    refinedHeader: "本周任务 · 共 3 项",
    refinedList: [
      "修改注册页面",
      "完成数据库迁移",
      "测试覆盖率提升至 80% 以上",
    ],
    refined: "",
  },
];

const AUTO_INTERVAL = 5500;

export default function AccuracySection() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const { ref: viewRef, active } = useSectionInView<HTMLDivElement>(0.35);
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);

  // 进入视口后自动轮播；用户手动选场景后暂停 8s 再恢复
  useEffect(() => {
    if (!active || paused) return;
    const t = setInterval(
      () => setIdx((i) => (i + 1) % SCENES.length),
      AUTO_INTERVAL,
    );
    return () => clearInterval(t);
  }, [active, paused]);

  useEffect(() => {
    if (!paused) return;
    const t = setTimeout(() => setPaused(false), 8000);
    return () => clearTimeout(t);
  }, [paused]);

  const handlePick = (i: number) => {
    setIdx(i);
    setPaused(true);
  };

  const scene = SCENES[idx];

  const { scrollYProgress } = useScroll({
    target: sectionRef,
    offset: ["start end", "end start"],
  });
  const bgY = useTransform(scrollYProgress, [0, 1], ["-10%", "10%"]);

  return (
    <section
      ref={sectionRef}
      id="accuracy"
      className="landing-section relative flex min-h-screen items-center overflow-hidden py-24"
    >
      <motion.div
        aria-hidden
        style={{ y: bgY }}
        className="pointer-events-none absolute inset-0 -z-10"
      >
        <div className="absolute left-[-200px] top-1/4 h-[500px] w-[500px] rounded-full bg-te-accent/8 blur-[140px]" />
        <div className="absolute right-[-150px] bottom-1/4 h-[400px] w-[400px] rounded-full bg-te-accent/6 blur-[120px]" />
      </motion.div>

      <div
        ref={viewRef}
        className="relative mx-auto flex w-full max-w-7xl flex-col items-center gap-12 px-6 lg:px-12"
      >
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
          transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
          className="flex flex-col items-center gap-4 text-center"
        >
          <span className="te-eyebrow">02 · From Voice to Polished Text</span>
          <h2 className="font-mono text-[clamp(2rem,4.6vw,3.6rem)] font-bold leading-[1.05] tracking-tighter text-te-fg">
            <span>口语化的话，</span>
            <span className="bg-gradient-to-r from-te-accent to-te-accent/80 bg-clip-text text-transparent">
              按场景给你重写
            </span>
          </h2>
          <p className="max-w-2xl text-balance text-base leading-relaxed text-te-light-gray md:text-lg">
            邮件、微信、翻译、文档 — 同一段口述，AI 按你想要的格式重排，去掉嗯啊呃。
          </p>
        </motion.div>

        {/* 场景切换 chips */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
          transition={{ duration: 0.7, delay: 0.15 }}
          className="flex flex-wrap items-center justify-center gap-2"
        >
          {SCENES.map((s, i) => {
            const Icon = s.icon;
            const isActive = i === idx;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => handlePick(i)}
                className={cn(
                  "inline-flex items-center gap-2 border px-4 py-2 font-mono text-[11px] uppercase tracking-[0.2em] transition-colors",
                  isActive
                    ? "border-te-accent bg-te-accent text-te-bg"
                    : "border-te-gray/60 bg-te-bg text-te-light-gray hover:border-te-accent hover:text-te-accent",
                )}
              >
                <Icon className="size-3.5" />
                {s.label}
              </button>
            );
          })}
        </motion.div>

        {/* 左右分栏：左 raw / 右 refined */}
        <motion.div
          initial={{ opacity: 0, y: 40 }}
          animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 40 }}
          transition={{ duration: 1.0, delay: 0.3, ease: [0.22, 1, 0.36, 1] }}
          className="grid w-full max-w-6xl grid-cols-1 gap-px border border-te-gray/40 bg-te-gray/40 lg:grid-cols-2"
        >
          {/* 左：原始口述 */}
          <div className="flex min-h-[420px] flex-col bg-te-surface">
            <div className="flex items-center justify-between gap-3 border-b border-te-gray/30 px-5 py-3">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-te-light-gray/70">
                <span className="text-te-accent">▍</span>
                <span>raw transcript</span>
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray/50">
                // 你说的原话
              </span>
            </div>
            <div className="flex flex-1 items-start px-8 py-8 md:px-10 md:py-10">
              <AnimatePresence mode="wait">
                <motion.p
                  key={`raw-${scene.id}`}
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.45 }}
                  className="text-lg leading-relaxed text-te-fg md:text-xl"
                >
                  {scene.raw.map((seg, i) => {
                    if (seg.kind === "filler") {
                      return (
                        <span
                          key={i}
                          className="text-te-light-gray/55 line-through decoration-te-light-gray/40"
                        >
                          {seg.text}
                        </span>
                      );
                    }
                    if (seg.kind === "correction") {
                      return (
                        <span
                          key={i}
                          className="text-te-accent/70 line-through decoration-te-accent/40"
                        >
                          {seg.text}
                        </span>
                      );
                    }
                    return <span key={i}>{seg.text}</span>;
                  })}
                </motion.p>
              </AnimatePresence>
            </div>
          </div>

          {/* 右：场景化重写 */}
          <div className="flex min-h-[420px] flex-col bg-te-surface">
            <div className="flex items-center justify-between gap-3 border-b border-te-gray/30 px-5 py-3">
              <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.25em] text-te-accent">
                <span>▍</span>
                <span>refined output</span>
              </div>
              <AnimatePresence mode="wait">
                <motion.span
                  key={`badge-${scene.id}`}
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 4 }}
                  transition={{ duration: 0.25 }}
                  className="border border-te-accent/40 bg-te-accent/10 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-accent"
                >
                  {scene.badge}
                </motion.span>
              </AnimatePresence>
            </div>
            <div className="flex flex-1 items-start px-8 py-8 md:px-10 md:py-10">
              <AnimatePresence mode="wait">
                {scene.refinedKind === "paragraph" ? (
                  <motion.p
                    key={`refined-${scene.id}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                    className="text-lg leading-relaxed text-te-fg md:text-xl"
                  >
                    {scene.refined}
                  </motion.p>
                ) : (
                  <motion.div
                    key={`refined-${scene.id}`}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.5, delay: 0.1 }}
                    className="flex flex-col gap-3 text-lg leading-relaxed text-te-fg md:text-xl"
                  >
                    <div className="font-mono text-base text-te-accent md:text-lg">
                      {scene.refinedHeader}
                    </div>
                    <ol className="flex flex-col gap-2">
                      {scene.refinedList?.map((item, i) => (
                        <motion.li
                          key={item}
                          className="flex items-baseline gap-3"
                          initial={{ opacity: 0, x: -6 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ duration: 0.35, delay: 0.2 + i * 0.08 }}
                        >
                          <span className="font-mono text-base text-te-accent md:text-lg">
                            {i + 1}.
                          </span>
                          <span>{item}</span>
                        </motion.li>
                      ))}
                    </ol>
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>
        </motion.div>

        <p className="font-mono text-[10px] uppercase tracking-[0.3em] text-te-light-gray/50">
          {paused
            ? "// 已暂停轮播 · 8s 后自动继续"
            : `// ${idx + 1} / ${SCENES.length} · 自动轮播中`}
        </p>
      </div>
    </section>
  );
}
