import { useState, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Minus, Square, X, Copy } from "lucide-react";
import { detectPlatform } from "@/lib/platform";

const appWindow = getCurrentWindow();

export function WindowControls() {
  const platform = detectPlatform();
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const unlisten = appWindow.onResized(async () => {
      if (cancelled) return;
      try {
        setMaximized(await appWindow.isMaximized());
      } catch {}
    });
    appWindow.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    });
    return () => {
      cancelled = true;
      unlisten.then((u) => u());
    };
  }, []);

  if (platform === "macos") return null;

  return (
    <div className="flex shrink-0" onPointerDown={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => void appWindow.minimize()}
        className="inline-flex h-8 w-11 items-center justify-center text-te-light-gray transition-colors hover:bg-te-surface-hover hover:text-te-fg"
      >
        <Minus className="size-3.5" strokeWidth={1.5} />
      </button>
      <button
        type="button"
        onClick={() => void appWindow.toggleMaximize()}
        className="inline-flex h-8 w-11 items-center justify-center text-te-light-gray transition-colors hover:bg-te-surface-hover hover:text-te-fg"
      >
        {maximized ? (
          <Copy className="size-3.5" strokeWidth={1.5} />
        ) : (
          <Square className="size-3" strokeWidth={1.5} />
        )}
      </button>
      <button
        type="button"
        onClick={() => void appWindow.close()}
        className="inline-flex h-8 w-11 items-center justify-center text-te-light-gray transition-colors hover:bg-red-600 hover:text-white"
      >
        <X className="size-4" strokeWidth={1.5} />
      </button>
    </div>
  );
}
