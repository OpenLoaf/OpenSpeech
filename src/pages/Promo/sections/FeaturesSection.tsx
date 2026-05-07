import { motion } from "framer-motion";
import {
  Cpu,
  Globe2,
  KeyRound,
  Lock,
  Sparkles,
  Wand2,
  type LucideIcon,
} from "lucide-react";

type Feature = {
  icon: LucideIcon;
  meta: string;
  title: string;
  body: string;
  span: string;
  accent?: boolean;
};

const FEATURES: Feature[] = [
  {
    icon: Wand2,
    meta: "AI · Polish",
    title: "AI 自动清洗口误",
    body:
      "「嗯…那个…」「啊…对…」自我纠错全部抹平，再按你想要的风格——结构化清单、邮件、技术文档——重排输出。",
    span: "md:col-span-3 md:row-span-2",
    accent: true,
  },
  {
    icon: Lock,
    meta: "Privacy",
    title: "本地优先 · 零追踪",
    body: "音频帧只发到你配置的 ASR endpoint，OpenSpeech 不存任何录音、不做任何埋点。",
    span: "md:col-span-3 md:row-span-1",
  },
  {
    icon: KeyRound,
    meta: "Hotkey",
    title: "全局快捷键",
    body: "Fn+Ctrl / Alt+Win / Ctrl+Super 默认绑定，可改任意单键 PTT 或修饰键双击。",
    span: "md:col-span-3 md:row-span-1",
  },
  {
    icon: Cpu,
    meta: "ASR",
    title: "任意 ASR 后端",
    body:
      "OpenAI Whisper、Deepgram、火山引擎、阿里云 NLS、自部署 whisper.cpp / sherpa-onnx——只要给个 endpoint。",
    span: "md:col-span-2 md:row-span-1",
  },
  {
    icon: Globe2,
    meta: "Cross-Platform",
    title: "全平台",
    body: "macOS · Windows · Linux 同一份 Tauri bundle，原生体感。",
    span: "md:col-span-2 md:row-span-1",
  },
  {
    icon: Sparkles,
    meta: "History",
    title: "可撤销历史",
    body: "最近 N 条注入历史，一键撤销 / 复制 / 重新转写。",
    span: "md:col-span-2 md:row-span-1",
  },
];

export default function FeaturesSection() {
  return (
    <section
      id="features"
      data-promo-section
      className="relative bg-te-bg px-[4vw] py-[clamp(5rem,11vw,9rem)]"
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-[0.4]"
        style={{
          backgroundImage:
            "linear-gradient(rgba(255,255,255,0.04) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "80px 80px",
          maskImage:
            "radial-gradient(ellipse 80% 60% at 50% 50%, #000 30%, transparent 90%)",
          WebkitMaskImage:
            "radial-gradient(ellipse 80% 60% at 50% 50%, #000 30%, transparent 90%)",
        }}
      />

      <div className="relative mx-auto max-w-6xl">
        <motion.div
          className="mb-14 flex flex-col gap-6 border-b border-te-gray/30 pb-8 md:mb-20 md:flex-row md:items-end md:justify-between"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="flex flex-col gap-3">
            <span className="font-mono text-xs uppercase tracking-[0.3em] text-te-light-gray/50">
              [03] · Features
            </span>
            <h2 className="max-w-2xl font-mono text-3xl font-bold leading-[1.05] tracking-tighter text-te-fg md:text-5xl">
              不是又一个语音工具，
              <br />
              <span className="text-te-accent">是把说话变成生产力。</span>
            </h2>
          </div>
          <p className="max-w-sm text-sm leading-relaxed text-te-light-gray/60 md:text-right">
            围绕真实工作流设计——开会、写代码、写文档、记灵感——让说出来的话直接落到光标里成为可用的文本。
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-3 md:auto-rows-[minmax(140px,auto)] md:grid-cols-6">
          {FEATURES.map((f, i) => (
            <FeatureCard key={f.title} feature={f} index={i} />
          ))}
        </div>
      </div>
    </section>
  );
}

function FeatureCard({ feature, index }: { feature: Feature; index: number }) {
  const Icon = feature.icon;
  return (
    <motion.article
      initial={{ opacity: 0, y: 18 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-10% 0px" }}
      transition={{ duration: 0.5, delay: index * 0.07 }}
      className={
        "group relative flex flex-col justify-between gap-6 overflow-hidden border border-te-gray/30 bg-te-surface/40 p-6 transition-colors hover:border-te-accent/50 md:p-8 " +
        feature.span
      }
    >
      {feature.accent && (
        <div
          className="pointer-events-none absolute inset-0 opacity-60"
          style={{
            background:
              "radial-gradient(ellipse 80% 60% at 100% 0%, rgba(255,204,0,0.10), transparent 70%)",
          }}
        />
      )}

      <div className="absolute right-5 top-5 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray/40">
        <span className="size-1 rounded-full bg-te-light-gray/50" />
        {feature.meta}
      </div>

      <div className="relative flex size-12 items-center justify-center border border-te-gray/40 bg-te-bg/60 text-te-accent transition-colors group-hover:border-te-accent/60">
        <Icon className="size-5" strokeWidth={1.6} />
        <span className="absolute -inset-px -z-10 bg-te-accent/0 blur-xl transition-colors group-hover:bg-te-accent/10" />
      </div>

      <div className="relative flex flex-col gap-2">
        <h3 className="font-mono text-xl font-bold tracking-tight text-te-fg md:text-2xl">
          {feature.title}
        </h3>
        <p className="text-sm leading-relaxed text-te-light-gray/65">
          {feature.body}
        </p>
      </div>

      <div className="absolute bottom-0 left-0 h-px w-0 bg-te-accent transition-all duration-500 group-hover:w-full" />
    </motion.article>
  );
}
