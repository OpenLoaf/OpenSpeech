import { motion } from "framer-motion";

export default function Footer() {
  return (
    <footer className="border-t border-te-gray/30 bg-te-bg px-[4vw] py-8">
      <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-4 md:flex-row">
        <div className="flex items-center gap-3 font-mono text-xs text-te-light-gray/60">
          <img
            src="/logo-write.png"
            alt="OpenSpeech"
            className="h-5 w-5 opacity-70"
          />
          <span>© 2026 OpenSpeech · 开源软件</span>
        </div>

        <nav className="flex items-center gap-6 font-mono text-xs uppercase tracking-[0.15em] text-te-light-gray/60">
          <a
            className="transition-colors hover:text-te-accent"
            href="https://github.com/OpenLoaf/OpenSpeech"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a
            className="transition-colors hover:text-te-accent"
            href="https://github.com/OpenLoaf/OpenSpeech/releases"
            target="_blank"
            rel="noreferrer"
          >
            版本
          </a>
          <a className="transition-colors hover:text-te-accent" href="#faq">
            常见问题
          </a>
          <a
            className="transition-colors hover:text-te-accent"
            href="https://github.com/OpenLoaf/OpenSpeech/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer"
          >
            License
          </a>
        </nav>

        <div className="flex items-center gap-2 font-mono text-xs text-te-light-gray/60">
          <motion.span
            className="size-1.5 rounded-full bg-te-accent"
            animate={{ opacity: [1, 0.3, 1] }}
            transition={{ duration: 2, repeat: Infinity }}
          />
          <span className="uppercase tracking-[0.15em]">v0.2.24</span>
        </div>
      </div>
    </footer>
  );
}
