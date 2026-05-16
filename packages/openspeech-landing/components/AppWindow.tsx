import type { ReactNode } from "react";
import { cn } from "../lib/cn";

interface AppWindowProps {
  title?: string;
  subtitle?: string;
  className?: string;
  bodyClassName?: string;
  children: ReactNode;
}

/** macOS 风窗口外壳，仅做演示用，不依赖任何 Tauri runtime */
export default function AppWindow({
  title = "OpenSpeech",
  subtitle,
  className,
  bodyClassName,
  children,
}: AppWindowProps) {
  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-2xl border border-te-gray/40 bg-te-surface te-window-shadow",
        className,
      )}
    >
      <div className="flex items-center gap-2 border-b border-te-gray/30 bg-te-surface-hover px-4 py-3">
        <div className="flex gap-1.5">
          <span className="size-3 rounded-full bg-[#ff5f57]" />
          <span className="size-3 rounded-full bg-[#febc2e]" />
          <span className="size-3 rounded-full bg-[#28c840]" />
        </div>
        <div className="ml-3 flex flex-col leading-tight">
          <span className="font-mono text-[11px] uppercase tracking-[0.2em] text-te-fg">
            {title}
          </span>
          {subtitle && (
            <span className="font-mono text-[10px] tracking-wider text-te-light-gray">
              {subtitle}
            </span>
          )}
        </div>
        <div className="ml-auto h-2 w-24 rounded-full bg-te-gray/60" />
      </div>
      <div className={cn("relative", bodyClassName)}>{children}</div>
    </div>
  );
}
