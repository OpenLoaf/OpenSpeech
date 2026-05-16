import { motion } from "framer-motion";
import { Apple, KeyRound, Lock, Package, Terminal } from "lucide-react";
import { useSectionInView } from "../lib/useSectionInView";

// 三平台下载入口；href 暂占位，发版后替换为真实 release 链接
const downloads = [
  {
    id: "macos",
    icon: Apple,
    name: "macOS",
    formats: "DMG · Apple Silicon + Intel",
    href: "#",
  },
  {
    id: "windows",
    icon: WindowsGlyph,
    name: "Windows",
    formats: "MSI · EXE · 10/11",
    href: "#",
  },
  {
    id: "linux",
    icon: Terminal,
    name: "Linux",
    formats: "AppImage · deb · rpm",
    href: "#",
  },
] as const;

const trustChips = [
  {
    icon: Lock,
    title: "录音只在你电脑上",
    body: "不上传一帧音频，麦克风权限可随时撤销。",
  },
  {
    icon: KeyRound,
    title: "API key 在系统钥匙串",
    body: "存在 macOS Keychain / Windows 凭据管理器，我们看不到。",
  },
  {
    icon: Package,
    title: "PolyForm Noncommercial 开源",
    body: "完整源码托管 GitHub，编译产物可逐行审计。",
  },
] as const;

export default function CTASection() {
  const { ref, active } = useSectionInView<HTMLDivElement>(0.15, {
    sticky: true,
  });

  return (
    <section
      id="download"
      className="landing-section relative flex min-h-screen items-center justify-center overflow-hidden py-24"
    >
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute left-1/2 top-1/3 h-[600px] w-[600px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-te-accent/12 blur-[160px]" />
        <div className="absolute right-[-160px] bottom-[10%] h-[420px] w-[420px] rounded-full bg-te-accent/8 blur-[120px]" />
      </div>

        <div
          ref={ref}
          className="relative mx-auto flex w-full max-w-6xl flex-col gap-10 px-6 lg:px-12"
        >
        {/* ============== 下载板块 ============== */}
        <div className="flex flex-col items-center gap-10">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: 0.55, delay: 0.2 }}
            className="flex flex-col items-center gap-4 text-center"
          >
            <span className="te-eyebrow">04 · Get OpenSpeech</span>
            <h2 className="font-mono text-[clamp(2.2rem,5.2vw,4.2rem)] font-bold leading-[1.02] tracking-tighter text-te-fg">
              <span className="bg-gradient-to-b from-te-fg to-te-fg/70 bg-clip-text text-transparent">
                按下快捷键，
              </span>
              <br />
              <span className="bg-gradient-to-r from-te-accent to-te-accent/80 bg-clip-text text-transparent">
                开口即文字。
              </span>
            </h2>
            <p className="max-w-xl text-balance text-base text-te-light-gray md:text-lg">
              macOS · Windows · Linux 全平台支持，免费下载即用。
            </p>
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 8 }}
            transition={{ duration: 0.6, delay: 0.28 }}
            className="grid w-full grid-cols-1 gap-4 md:grid-cols-3"
          >
            {downloads.map((d) => {
              const Icon = d.icon;
              return (
                <a
                  key={d.id}
                  href={d.href}
                  className="group flex items-center justify-between border border-te-gray/50 bg-te-surface/30 px-5 py-5 transition-colors hover:border-te-accent hover:bg-te-accent/8"
                >
                  <div className="flex items-center gap-4">
                    <Icon className="h-7 w-7 text-te-fg transition-colors group-hover:text-te-accent" strokeWidth={1.5} />
                    <div className="flex flex-col items-start gap-1">
                      <span className="font-mono text-sm font-bold uppercase tracking-[0.14em] text-te-fg">
                        {d.name}
                      </span>
                      <span className="text-[11px] text-te-light-gray">
                        {d.formats}
                      </span>
                    </div>
                  </div>
                  <span className="font-mono text-xs uppercase tracking-[0.18em] text-te-light-gray transition-colors group-hover:text-te-accent">
                    下载 →
                  </span>
                </a>
              );
            })}
          </motion.div>

          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={active ? { opacity: 1, y: 0 } : { opacity: 0, y: 6 }}
            transition={{ duration: 0.55, delay: 0.34 }}
            className="flex flex-col items-center gap-3 text-center"
          >
            <p className="max-w-2xl text-sm text-te-light-gray">
              想用自己的 OpenAI / 腾讯云 / 阿里云 key？设置里填 endpoint 即可，全程走你自己的账号。
            </p>
            <a
              href="#"
              className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.22em] text-te-light-gray transition-colors hover:text-te-accent"
            >
              在 GitHub 查看源码 →
            </a>
          </motion.div>
        </div>
      </div>
    </section>
  );
}

/**
 * 数据流向图：用 SVG 画三节点 + 黄色 accent 线
 * 桌面横向、移动端竖向；OpenSpeech 自家服务器节点用虚线划掉以强调"不在链路里"
 */
function DataFlowDiagram() {
  return (
    <div className="relative w-full border border-te-gray/40 bg-te-surface/30 p-6 md:p-8">
      <span className="absolute -top-3 left-6 bg-te-bg px-2 font-mono text-[10px] uppercase tracking-[0.22em] text-te-light-gray">
        Data flow
      </span>

      {/* 桌面横向布局 */}
      <div className="hidden md:grid md:grid-cols-[1fr_auto_1.2fr_auto_1fr] md:items-center md:gap-4">
        <FlowNode
          icon="mic"
          title="你的麦克风"
          subtitle="本机硬件"
        />
        <FlowArrow label="原始音频" />
        <FlowNode
          icon="app"
          title="OpenSpeech App"
          subtitle="录音 · 字典 · 历史 都在本机"
          highlighted
        />
        <FlowArrow label="HTTPS 直连" />
        <FlowNode
          icon="cloud"
          title="你配置的 ASR 服务"
          subtitle="OpenAI · 腾讯云 · 阿里云 · 自建 兼容"
        />
      </div>

      {/* 移动端竖向布局 */}
      <div className="flex flex-col gap-3 md:hidden">
        <FlowNode icon="mic" title="你的麦克风" subtitle="本机硬件" />
        <FlowArrow label="原始音频" vertical />
        <FlowNode
          icon="app"
          title="OpenSpeech App"
          subtitle="录音 · 字典 · 历史 都在本机"
          highlighted
        />
        <FlowArrow label="HTTPS 直连" vertical />
        <FlowNode
          icon="cloud"
          title="你配置的 ASR 服务"
          subtitle="OpenAI · 腾讯云 · 阿里云 · 自建"
        />
      </div>

      {/* 被划掉的「OpenSpeech 自家服务器」 —— 视觉上强调它不在链路里 */}
      <div className="mt-6 flex flex-col items-center gap-2 border-t border-dashed border-te-gray/40 pt-5">
        <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-te-light-gray/70">
          不在链路中
        </span>
        <div className="relative inline-flex items-center gap-3 border border-dashed border-te-gray/50 px-4 py-2 text-te-light-gray/60">
          <ServerGlyph />
          <span className="font-mono text-xs uppercase tracking-[0.14em] line-through decoration-te-light-gray/70">
            OpenSpeech 自家服务器
          </span>
          <span
            aria-hidden
            className="absolute inset-0 flex items-center justify-center"
          >
            <span className="block h-px w-[110%] -rotate-6 bg-te-light-gray/40" />
          </span>
        </div>
      </div>
    </div>
  );
}

type FlowNodeProps = {
  icon: "mic" | "app" | "cloud";
  title: string;
  subtitle: string;
  highlighted?: boolean;
};

function FlowNode({ icon, title, subtitle, highlighted }: FlowNodeProps) {
  return (
    <div
      className={[
        "flex flex-col items-center gap-2 border px-4 py-4 text-center",
        highlighted
          ? "border-te-accent/60 bg-te-accent/8"
          : "border-te-gray/50 bg-te-bg/40",
      ].join(" ")}
    >
      <span
        className={[
          "flex h-10 w-10 items-center justify-center border",
          highlighted
            ? "border-te-accent/70 text-te-accent"
            : "border-te-gray/60 text-te-fg",
        ].join(" ")}
      >
        <NodeGlyph kind={icon} />
      </span>
      <span
        className={[
          "font-mono text-[12px] font-bold uppercase tracking-[0.1em]",
          highlighted ? "text-te-fg" : "text-te-fg",
        ].join(" ")}
      >
        {title}
      </span>
      <span className="text-[11px] leading-snug text-te-light-gray">
        {subtitle}
      </span>
    </div>
  );
}

function FlowArrow({
  label,
  vertical,
}: {
  label: string;
  vertical?: boolean;
}) {
  if (vertical) {
    return (
      <div className="flex flex-col items-center gap-1 py-1">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-accent">
          {label}
        </span>
        <svg width="16" height="28" viewBox="0 0 16 28" aria-hidden>
          <line
            x1="8"
            y1="0"
            x2="8"
            y2="22"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-te-accent"
          />
          <polyline
            points="3,20 8,27 13,20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-te-accent"
          />
        </svg>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center gap-1 px-1">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-te-accent">
        {label}
      </span>
      <svg width="64" height="16" viewBox="0 0 64 16" aria-hidden>
        <line
          x1="0"
          y1="8"
          x2="58"
          y2="8"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-te-accent"
        />
        <polyline
          points="52,3 62,8 52,13"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className="text-te-accent"
        />
      </svg>
    </div>
  );
}

function NodeGlyph({ kind }: { kind: "mic" | "app" | "cloud" }) {
  if (kind === "mic") {
    return (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="square"
        aria-hidden
      >
        <rect x="9" y="3" width="6" height="12" rx="3" />
        <path d="M5 11a7 7 0 0 0 14 0" />
        <line x1="12" y1="18" x2="12" y2="22" />
      </svg>
    );
  }
  if (kind === "app") {
    return (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="square"
        aria-hidden
      >
        <rect x="3" y="4" width="18" height="14" rx="1" />
        <line x1="3" y1="8" x2="21" y2="8" />
        <circle cx="6" cy="6" r="0.6" fill="currentColor" />
        <circle cx="8.4" cy="6" r="0.6" fill="currentColor" />
      </svg>
    );
  }
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="square"
      aria-hidden
    >
      <path d="M7 18a5 5 0 0 1-1-9.9 6 6 0 0 1 11.6 1.4A4 4 0 0 1 17 18Z" />
    </svg>
  );
}

function ServerGlyph() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="square"
      aria-hidden
    >
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
      <line x1="7" y1="7" x2="7" y2="7" />
      <line x1="7" y1="17" x2="7" y2="17" />
    </svg>
  );
}

// lucide-react 没有官方 Windows 图标，自己画一个简洁四格 logo
function WindowsGlyph({
  className,
  strokeWidth: _strokeWidth,
}: {
  className?: string;
  strokeWidth?: number;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <rect x="3" y="3" width="8.5" height="8.5" />
      <rect x="12.5" y="3" width="8.5" height="8.5" />
      <rect x="3" y="12.5" width="8.5" height="8.5" />
      <rect x="12.5" y="12.5" width="8.5" height="8.5" />
    </svg>
  );
}
