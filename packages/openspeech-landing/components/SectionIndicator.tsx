import { useEffect, useState } from "react";
import { cn } from "../lib/cn";

interface SectionIndicatorProps {
  sections: Array<{ id: string; label: string }>;
}

export default function SectionIndicator({ sections }: SectionIndicatorProps) {
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? "");

  useEffect(() => {
    const observers: IntersectionObserver[] = [];
    const map = new Map<string, number>();

    sections.forEach((s) => {
      const el = document.getElementById(s.id);
      if (!el) return;
      const io = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            map.set(s.id, e.intersectionRatio);
          }
          let bestId = activeId;
          let bestRatio = -1;
          for (const [id, r] of map) {
            if (r > bestRatio) {
              bestRatio = r;
              bestId = id;
            }
          }
          if (bestRatio > 0.2) setActiveId(bestId);
        },
        { threshold: [0, 0.25, 0.5, 0.75, 1] },
      );
      io.observe(el);
      observers.push(io);
    });

    return () => observers.forEach((o) => o.disconnect());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections]);

  return (
    <nav
      aria-label="Sections"
      className="pointer-events-auto fixed right-6 top-1/2 z-50 hidden -translate-y-1/2 flex-col gap-3 md:flex"
    >
      {sections.map((s) => {
        const active = s.id === activeId;
        return (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="group relative flex items-center justify-end gap-3"
          >
            <span
              className={cn(
                "text-[12px] tracking-normal transition-all duration-300",
                active
                  ? "translate-x-0 text-te-accent opacity-100"
                  : "translate-x-2 text-te-light-gray opacity-0 group-hover:translate-x-0 group-hover:opacity-80",
              )}
            >
              {s.label}
            </span>
            <span
              className={cn(
                "block size-2 rounded-full border transition-all duration-300",
                active
                  ? "scale-125 border-te-accent bg-te-accent te-dot-glow"
                  : "border-te-gray bg-transparent group-hover:border-te-light-gray",
              )}
            />
          </a>
        );
      })}
    </nav>
  );
}
