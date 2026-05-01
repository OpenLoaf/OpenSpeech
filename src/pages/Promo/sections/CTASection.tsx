import { motion } from "framer-motion";
import { Apple, ArrowDownToLine, Monitor, Terminal } from "lucide-react";
import { useMemo } from "react";
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
  primary: Variant;
  others: Variant[];
};

const PLATFORMS: Platform[] = [
  {
    os: "macOS",
    icon: Apple,
    tagline: "11 Big Sur 及以上",
    primary: {
      label: "Apple Silicon",
      arch: "arm64",
      ext: "DMG",
      href: asset(`OpenSpeech-${VERSION}-macOS-arm64.dmg`),
    },
    others: [
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
    icon: Monitor,
    tagline: "10 / 11",
    primary: {
      label: "x64 安装包",
      arch: "x86_64",
      ext: "EXE",
      href: asset(`OpenSpeech-${VERSION}-Windows-x86_64-setup.exe`),
    },
    others: [
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
    icon: Terminal,
    tagline: "Ubuntu / Fedora / Arch",
    primary: {
      label: "AppImage",
      arch: "x86_64",
      ext: "APPIMAGE",
      href: asset(`OpenSpeech-${VERSION}-Linux-x86_64.AppImage`),
    },
    others: [
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

function GithubIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
    >
      <path d="M12 0.296c-6.627 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.6.111.793-.261.793-.577v-2.234c-3.338.726-4.043-1.61-4.043-1.61-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.84 1.236 1.84 1.236 1.07 1.835 2.807 1.305 3.492.998.108-.776.418-1.305.762-1.605-2.665-.305-5.467-1.334-5.467-5.931 0-1.31.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.984-.399 3.003-.404 1.019.005 2.046.138 3.005.404 2.292-1.552 3.299-1.23 3.299-1.23.653 1.652.242 2.873.118 3.176.769.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.371.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.085 8.199-11.385 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}

function detectPlatform(): Platform["os"] | null {
  if (typeof navigator === "undefined") return null;
  const ua = navigator.userAgent.toLowerCase();
  const platform = (navigator.platform ?? "").toLowerCase();
  if (/mac|iphone|ipad|ipod/.test(ua) || /mac/.test(platform)) return "macOS";
  if (/win/.test(ua) || /win/.test(platform)) return "Windows";
  if (/linux|x11/.test(ua) || /linux/.test(platform)) return "Linux";
  return null;
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
          className="mb-12 flex flex-col items-center gap-3 text-center md:mb-16"
          initial={{ opacity: 0, y: 16 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <div className="font-mono text-xs uppercase tracking-[0.3em] text-te-light-gray/50">
            [04] · DOWNLOAD
          </div>
          <h2 className="font-mono text-[clamp(1.8rem,5.5vw,4rem)] font-bold leading-[1.05] tracking-tighter text-te-fg">
            停止打字，开始说话。
          </h2>
          <p className="max-w-md text-balance text-sm text-te-light-gray/60">
            点击你的系统直接下载 · 当前版本{" "}
            <span className="font-mono text-te-fg/80">v{VERSION}</span>
          </p>
        </motion.div>

        <div className="grid grid-cols-1 gap-5 md:grid-cols-3">
          {PLATFORMS.map((p, idx) => {
            const isDetected = detected === p.os;
            return (
              <motion.div
                key={p.os}
                initial={{ opacity: 0, y: 18 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.55, delay: 0.1 + idx * 0.08 }}
                className={`relative flex flex-col border bg-te-bg/40 backdrop-blur-sm transition-colors ${
                  isDetected
                    ? "border-te-accent/60 shadow-[0_0_60px_-20px_rgba(255,204,0,0.35)]"
                    : "border-te-gray/40 hover:border-te-light-gray/40"
                }`}
              >
                {isDetected && (
                  <div className="absolute -top-px left-0 right-0 flex justify-center">
                    <span className="-translate-y-1/2 border border-te-accent/60 bg-te-bg px-3 py-0.5 font-mono text-[10px] uppercase tracking-[0.25em] text-te-accent">
                      为你推荐
                    </span>
                  </div>
                )}

                <div className="flex flex-col gap-1 px-7 pt-8 pb-6">
                  <p.icon
                    className={`size-9 ${
                      isDetected ? "text-te-accent" : "text-te-fg/85"
                    }`}
                  />
                  <div className="mt-3 font-mono text-3xl font-bold tracking-tighter text-te-fg">
                    {p.os}
                  </div>
                  <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray/50">
                    {p.tagline}
                  </div>
                </div>

                <div className="mt-auto flex flex-col gap-3 px-7 pb-7">
                  <a
                    href={p.primary.href}
                    download
                    className={`group inline-flex items-center justify-between gap-3 border px-4 py-3.5 font-mono text-sm font-bold tracking-tight transition-all ${
                      isDetected
                        ? "border-te-accent bg-te-accent text-te-bg hover:bg-te-accent/90"
                        : "border-te-fg/80 text-te-fg hover:border-te-accent hover:bg-te-accent hover:text-te-bg"
                    }`}
                  >
                    <span className="flex flex-col items-start leading-tight">
                      <span className="text-base">下载 · {p.primary.label}</span>
                      <span
                        className={`mt-0.5 text-[10px] font-normal uppercase tracking-[0.2em] ${
                          isDetected
                            ? "text-te-bg/60"
                            : "text-te-light-gray/60 group-hover:text-te-bg/60"
                        }`}
                      >
                        {p.primary.ext} · {p.primary.arch}
                      </span>
                    </span>
                    <ArrowDownToLine className="size-5 shrink-0 transition-transform group-hover:translate-y-0.5" />
                  </a>

                  {p.others.length > 0 && (
                    <div className="flex flex-wrap items-center gap-2 pt-1">
                      <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/40">
                        其他
                      </span>
                      {p.others.map((v) => (
                        <a
                          key={v.label}
                          href={v.href}
                          download
                          className="inline-flex items-center gap-1.5 border border-te-gray/40 px-2.5 py-1 font-mono text-[11px] tracking-tight text-te-light-gray/70 transition-colors hover:border-te-accent hover:text-te-accent"
                        >
                          {v.label}
                          <span className="text-te-light-gray/40">
                            · {v.ext}
                          </span>
                        </a>
                      ))}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}
        </div>

        <motion.div
          className="mt-12 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4"
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.5 }}
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
            <GithubIcon className="size-4" />
            查看源码
          </a>
        </motion.div>

        <motion.div
          className="mt-10 text-center font-mono text-[11px] uppercase tracking-[0.2em] text-te-light-gray/40"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.6 }}
        >
          开源 · MIT License · 永久免费
        </motion.div>
      </div>
    </section>
  );
}
