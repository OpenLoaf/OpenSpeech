import type { ReactNode } from "react";
import { cn } from "../lib/cn";

/** 与 src/components/HotkeyPreview.tsx Kbd 完全一致的样式 */
export function Kbd({
  children,
  highlight,
  error,
  size = "md",
}: {
  children: ReactNode;
  highlight?: boolean;
  error?: boolean;
  size?: "md" | "lg";
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-sm border bg-te-bg font-mono transition-colors",
        size === "lg"
          ? "px-[clamp(0.75rem,2.5cqw,1.5rem)] py-[clamp(0.4rem,1.6cqw,1rem)] text-[clamp(0.875rem,3cqw,1.75rem)]"
          : "px-3 py-1.5 text-sm",
        error
          ? "border-red-700/70 text-red-500/80 shadow-[inset_0_-2px_0_0_#b91c1c]"
          : highlight
            ? "border-te-accent text-te-accent shadow-[inset_0_-2px_0_0_var(--te-accent)]"
            : "border-te-gray text-te-fg shadow-[inset_0_-2px_0_0_var(--te-gray)]",
      )}
    >
      {children}
    </span>
  );
}
