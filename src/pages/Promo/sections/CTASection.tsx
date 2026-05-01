import { motion } from "framer-motion";
import { ArrowDownToLine } from "lucide-react";
import { useMemo, useState } from "react";
import { FaApple, FaLinux, FaWindows } from "react-icons/fa6";
import { SiGithub } from "react-icons/si";
import pkg from "../../../../package.json";

const RELEASES_URL = "https://github.com/OpenLoaf/OpenSpeech/releases";
const REPO_URL = "https://github.com/OpenLoaf/OpenSpeech";
const VERSION = pkg.version;

const asset = (name: string) =>
  `${RELEASES_URL}/download/v${VERSION}/${name}`;

type Variant = {
  label: string;
  arch: string;
  ext: string;
  href: string;
};
type Platform = {
  os: "macOS" | "Windows" | "Linux";
  icon: React.ComponentType<{ className?: string }>;
  tagline: string;
  variants: Variant[];
};

const PLATFORMS: Platform[] = [
  {
    os: "macOS",
    icon: FaApple,
    tagline: "11 Big Sur+",
    variants: [
      {
        label: "Apple Silicon",
        arch: "arm64",
        ext: "DMG",
        href: asset(`OpenSpeech-${VERSION}-macOS-arm64.dmg`),
      },
      {
        label: "Intel",
        arch: "x86_64",
        ext: "DMG",
        href: asset(`OpenSpeech-${VERSION}-macOS-intel.dmg`),
      },
    ],
  },
  {
    os: "Windows",
    icon: FaWindows,
    tagline: "10 / 11",
    variants: [
      {
        label: "x64",
        arch: "x86_64",
        ext: "EXE",
        href: asset(`OpenSpeech-${VERSION}-Windows-x86_64-setup.exe`),
      },
      {
        label: "ARM64",
        arch: "arm64",
        ext: "EXE",
        href: asset(`OpenSpeech-${VERSION}-Windows-arm64-setup.exe`),
      },
    ],
  },
  {
    os: "Linux",
    icon: FaLinux,
    tagline: "Ubuntu / Fedora / Arch",
    variants: [
      {
        label: "AppImage",
        arch: "x86_64",
        ext: "APPIMAGE",
        href: asset(`OpenSpeech-${VERSION}-Linux-x86_64.AppImage`),
      },
      {
        label: "Debian",
        arch: "x86_64",
        ext: "DEB",
        href: asset(`OpenSpeech-${VERSION}-Linux-x86_64.deb`),
      },
      {
        label: "Red Hat",
        arch: "x86_64",
        ext: "RPM",
        href: asset(`OpenSpeech-${VERSION}-Linux-x86_64.rpm`),
      },
    ],
  },
];

function detectPlatform(): Platform["os"] | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent.toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(ua)) return "macOS";
  if (/win/.test(ua)) return "Windows";
  if (/linux|x11|cros/.test(ua)) return "Linux";
  return null;
}

function PlatformCard({
  platform,
  isDetected,
}: {
  platform: Platform;
  isDetected: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const Icon = platform.icon;
  const open = hovered || isDetected;
  const primary = platform.variants[0];

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setHovered(true)}
      onBlur={() => setHovered(false)}
      className={`group relative flex flex-col overflow-hidden border bg-te-surface/30 backdrop-blur-sm transition-[border-color,box-shadow] duration-300 ${
        isDetected
          ? "border-te-accent/70 shadow-[0_0_60px_-20px_rgba(255,204,0,0.4)]"
          : hovered
            ? "border-te-accent/40"
            : "border-te-gray/40"
      }`}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 -z-0 h-48 transition-opacity duration-500"
        style={{
          opacity: open ? 1 : 0.3,
          background: isDetected
            ? "radial-gradient(ellipse 90% 70% at 50% 0%, rgba(255,204,0,0.22) 0%, transparent 70%)"
            : "radial-gradient(ellipse 90% 70% at 50% 0%, rgba(255,204,0,0.12) 0%, transparent 70%)",
        }}
      />

      {isDetected && (
        <div className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 border border-te-accent/60 bg-te-bg/80 px-2 py-0.5 font-mono text-[9px] uppercase tracking-[0.25em] text-te-accent backdrop-blur">
          <span className="size-1 rounded-full bg-te-accent" />
          当前系统
        </div>
      )}

      <div className="relative z-10 flex items-center gap-4 px-6 pt-7 pb-5">
        <Icon
          className={`size-10 shrink-0 transition-colors duration-300 ${
            isDetected || hovered ? "text-te-accent" : "text-te-fg/85"
          }`}
        />
        <div className="flex flex-col leading-tight">
          <div className="font-mono text-xl font-bold tracking-tighter text-te-fg">
            {platform.os}
          </div>
          <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-te-light-gray/50">
            {platform.tagline}
          </div>
        </div>
        <div className="ml-auto font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/40">
          {platform.variants.length} 版本
        </div>
      </div>

      <div className="relative z-10 px-5 pb-5">
        <a
          href={primary.href}
          download
          className={`flex items-center justify-between gap-3 border px-4 py-3 font-mono text-sm font-bold tracking-tight transition-colors duration-200 ${
            isDetected
              ? "border-te-accent bg-te-accent text-te-bg hover:bg-te-accent/90"
              : "border-te-fg/50 text-te-fg hover:border-te-accent hover:bg-te-accent hover:text-te-bg"
          }`}
        >
          <span className="flex flex-col items-start leading-tight">
            <span>下载 · {primary.label}</span>
            <span
              className={`mt-0.5 text-[9px] font-normal uppercase tracking-[0.2em] ${
                isDetected ? "text-te-bg/60" : "text-te-light-gray/55"
              }`}
            >
              {primary.arch} · {primary.ext}
            </span>
          </span>
          <ArrowDownToLine className="size-4 shrink-0" />
        </a>

        {platform.variants.length > 1 && (
          <div
            className="grid transition-[grid-template-rows,opacity] duration-300 ease-out"
            style={{
              gridTemplateRows: open ? "1fr" : "0fr",
              opacity: open ? 1 : 0,
            }}
          >
            <div className="overflow-hidden">
              <div className="flex flex-col gap-1.5 pt-2.5">
                {platform.variants.slice(1).map((v) => (
                  <a
                    key={v.label}
                    href={v.href}
                    download
                    className="flex items-center justify-between gap-3 border border-te-gray/40 px-3 py-2 font-mono text-xs tracking-tight text-te-light-gray/80 transition-colors hover:border-te-accent hover:text-te-accent"
                  >
                    <span>{v.label}</span>
                    <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-te-light-gray/40">
                      {v.ext}
                    </span>
                  </a>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default function CTASection() {
  const detected = useMemo(detectPlatform, []);

  return (
    <section
      id="download"
      className="relative px-[4vw] py-[clamp(6rem,12vw,10rem)]"
    >
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: `
            linear-gradient(var(--te-fg) 1px, transparent 1px),
            linear-gradient(90deg, var(--te-fg) 1px, transparent 1px),
            radial-gradient(circle at center, transparent 30%, var(--te-bg) 100%)
          `,
          backgroundSize: "80px 80px, 80px 80px, 100% 100%",
          opacity: 0.03,
        }}
      />

      <div className="relative mx-auto max-w-6xl">
        <motion.div
          className="mb-14 flex flex-col items-center gap-3 text-center md:mb-20"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="font-mono text-xs uppercase tracking-[0.3em] text-te-light-gray/50">
            [04] · DOWNLOAD
          </div>
          <h2 className="font-mono text-[clamp(2rem,5.5vw,4rem)] font-bold leading-[1.05] tracking-tighter text-te-fg">
            停止打字，开始说话。
          </h2>
          <p className="max-w-md text-balance text-sm text-te-light-gray/60">
            选你的系统直接下载 · 当前版本{" "}
            <span className="font-mono text-te-fg/85">v{VERSION}</span>
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {PLATFORMS.map((p) => (
            <PlatformCard
              key={p.os}
              platform={p}
              isDetected={detected === p.os}
            />
          ))}
        </div>

        <motion.div
          className="mt-14 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4"
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.4 }}
        >
          <a
            href={RELEASES_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 border border-te-gray/40 px-6 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          >
            历史版本
          </a>
          <a
            href={REPO_URL}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-2 border border-te-gray/40 px-6 py-2.5 font-mono text-xs uppercase tracking-[0.15em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
          >
            <SiGithub className="size-4" />
            查看源码
          </a>
        </motion.div>

        <motion.div
          className="mt-10 text-center font-mono text-[11px] uppercase tracking-[0.25em] text-te-light-gray/40"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.5 }}
        >
          开源 · MIT License · 永久免费
        </motion.div>
      </div>
    </section>
  );
}
