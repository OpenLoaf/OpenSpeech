const NAV_LINKS = [
  { label: "特性", href: "#features" },
  { label: "常见问题", href: "#faq" },
  { label: "下载", href: "#download" },
];

export default function Navigation() {
  return (
    <header className="fixed top-0 z-50 w-full border-b border-te-gray/30 bg-te-bg/80 backdrop-blur-sm">
      <div className="mx-auto flex h-14 max-w-7xl items-center justify-between px-[4vw]">
        <a
          href="#top"
          className="flex items-center gap-2 font-mono text-sm font-bold tracking-tighter text-te-fg transition-colors hover:text-te-accent"
        >
          <img src="/logo-write.png" alt="OpenSpeech" className="h-5 w-auto" />
          <span>OpenSpeech</span>
        </a>

        <nav className="hidden items-center gap-6 md:flex">
          {NAV_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="font-mono text-xs uppercase tracking-[0.1em] text-te-light-gray transition-colors hover:text-te-accent"
            >
              {link.label}
            </a>
          ))}
        </nav>

        <a
          href="https://github.com/OpenLoaf/OpenSpeech"
          target="_blank"
          rel="noreferrer"
          className="border border-te-gray/40 px-4 py-1.5 font-mono text-xs uppercase tracking-[0.1em] text-te-fg transition-colors hover:border-te-accent hover:text-te-accent"
        >
          GitHub
        </a>
      </div>
    </header>
  );
}
