import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

export default function TopNav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 32);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-40 flex items-center justify-between px-6 py-4 transition-all duration-300 lg:px-12",
        scrolled
          ? "border-b border-te-gray/30 bg-te-bg/80 backdrop-blur-xl"
          : "border-b border-transparent bg-transparent",
      )}
    >
      <a href="#hero" className="flex items-center gap-2.5">
        <img
          src="/logo-no-bg.png"
          alt="OpenSpeech"
          className="h-7 w-7 select-none"
          draggable={false}
        />
        <span className="font-mono text-[14px] font-bold tracking-[-0.01em] text-te-fg">
          OpenSpeech
        </span>
      </a>
      <nav className="hidden items-center gap-8 md:flex">
        {[
          { id: "accuracy", label: "润色" },
          { id: "dictionary", label: "词典" },
          { id: "meeting", label: "会议" },
        ].map((l) => (
          <a
            key={l.id}
            href={`#${l.id}`}
            className="text-[13px] tracking-normal text-te-light-gray transition-colors hover:text-te-accent"
          >
            {l.label}
          </a>
        ))}
      </nav>
      <a
        href="#download"
        className="border border-te-accent/40 bg-te-accent/10 px-4 py-1.5 text-[13px] text-te-accent transition-all hover:bg-te-accent hover:text-te-accent-fg"
      >
        下载
      </a>
    </header>
  );
}
