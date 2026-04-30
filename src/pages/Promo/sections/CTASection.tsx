import { motion } from "framer-motion";
import { Apple, Download, Monitor, Terminal } from "lucide-react";
import pkg from "../../../../package.json";

const RELEASES_URL = "https://github.com/OpenLoaf/OpenSpeech/releases";
const REPO_URL = "https://github.com/OpenLoaf/OpenSpeech";
const VERSION = pkg.version;

const asset = (name: string) =>
  `${RELEASES_URL}/download/v${VERSION}/${name}`;

type Variant = { label: string; arch: string; ext: string; href: string };
type Platform = {
  os: string;
  icon: React.ComponentType<{ className?: string }>;
  variants: Variant[];
};

const PLATFORMS: Platform[] = [
  {
    os: "macOS",
    icon: Apple,
    variants: [
      {
        label: "Apple Silicon",
        arch: "arm64",
        ext: ".dmg",
        href: asset(`OpenSpeech-${VERSION}-macOS-arm64.dmg`),
      },
      {
        label: "Intel",
        arch: "x86_64",
        ext: ".dmg",
        href: asset(`OpenSpeech-${VERSION}-macOS-intel.dmg`),
      },
    ],
  },
  {
    os: "Windows",
    icon: Monitor,
    variants: [
      {
        label: "x64",
        arch: "x86_64",
        ext: ".exe",
        href: asset(`OpenSpeech-${VERSION}-Windows-x86_64-setup.exe`),
      },
      {
        label: "ARM64",
        arch: "arm64",
        ext: ".exe",
        href: asset(`OpenSpeech-${VERSION}-Windows-arm64-setup.exe`),
      },
    ],
  },
  {
    os: "Linux",
    icon: Terminal,
    variants: [
      {
        label: "AppImage",
        arch: "x86_64",
        ext: ".AppImage",
        href: asset(`OpenSpeech-${VERSION}-Linux-x86_64.AppImage`),
      },
      {
        label: "Debian",
        arch: "x86_64",
        ext: ".deb",
        href: asset(`OpenSpeech-${VERSION}-Linux-x86_64.deb`),
      },
      {
        label: "Red Hat",
        arch: "x86_64",
        ext: ".rpm",
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

export default function CTASection() {
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

      <div className="relative mx-auto max-w-5xl">
        <motion.div
          className="text-center"
          initial={{ opacity: 0, y: 12 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          <img
            src="/logo-write.png"
            alt="OpenSpeech"
            className="mx-auto h-12 w-12 opacity-90"
          />
        </motion.div>

        <motion.h2
          className="mt-8 text-center font-mono text-[clamp(1.8rem,5.5vw,4rem)] font-bold tracking-tighter text-te-fg"
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
        >
          停止打字，开始说话。
        </motion.h2>

        <motion.p
          className="mt-4 text-center text-sm text-te-light-gray/70"
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6, delay: 0.2 }}
        >
          选择对应平台直接下载 · 当前版本 v{VERSION}
        </motion.p>

        <div className="mt-12 grid grid-cols-1 gap-px border border-te-gray/30 md:grid-cols-3">
          {PLATFORMS.map((p, idx) => (
            <motion.div
              key={p.os}
              className="bg-te-bg p-6"
              initial={{ opacity: 0, y: 12 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.25 + idx * 0.08 }}
            >
              <div className="flex items-center gap-3 border-b border-te-gray/30 pb-4">
                <p.icon className="size-5 text-te-accent" />
                <span className="font-mono text-base font-bold tracking-tighter text-te-fg">
                  {p.os}
                </span>
              </div>

              <ul className="mt-4 flex flex-col">
                {p.variants.map((v) => (
                  <li key={v.label}>
                    <a
                      href={v.href}
                      download
                      className="group flex items-center justify-between gap-3 border-b border-te-gray/20 py-3 transition-colors last:border-b-0 hover:border-te-accent/40"
                    >
                      <div className="min-w-0 flex-1">
                        <div className="font-mono text-sm font-bold tracking-tight text-te-fg transition-colors group-hover:text-te-accent">
                          {v.label}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.2em] text-te-light-gray/50">
                          {v.arch} · {v.ext}
                        </div>
                      </div>
                      <Download className="size-4 shrink-0 text-te-light-gray/40 transition-colors group-hover:text-te-accent" />
                    </a>
                  </li>
                ))}
              </ul>
            </motion.div>
          ))}
        </div>

        <motion.div
          className="mt-10 flex flex-col items-center justify-center gap-3 sm:flex-row sm:gap-4"
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
