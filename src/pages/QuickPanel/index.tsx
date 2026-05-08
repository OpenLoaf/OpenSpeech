import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import EditLastRecordView from "./modes/EditLastRecord";

// 与 Rust quick_panel::QUICK_PANEL_MODE_EVENT 对齐。Rust 在 show 之前先 emit_to 推 mode，
// 前端 listener 写到 state，再渲染对应视图——避免窗口先 visible 一帧空白再切。
const MODE_EVENT = "openspeech://quick-panel-mode";

export type QuickPanelMode = "edit-last-record";

export default function QuickPanelPage() {
  const [mode, setMode] = useState<QuickPanelMode | null>(null);

  useEffect(() => {
    const unlistenPromise = listen<string>(MODE_EVENT, (evt) => {
      const next = String(evt.payload ?? "") as QuickPanelMode;
      if (next === "edit-last-record") {
        setMode(next);
      } else {
        console.warn("[quick-panel] unknown mode:", next);
      }
    });
    return () => {
      void unlistenPromise.then((fn) => fn());
    };
  }, []);

  // ESC 关闭面板。capture 阶段拦下，避免编辑框正在合成中文输入时被 textarea 自己消化。
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.isComposing) {
        e.preventDefault();
        void invoke("quick_panel_hide").catch((err) =>
          console.warn("[quick-panel] hide failed:", err),
        );
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);

  return (
    // p-10 = 40 px 透明边距，与 Rust 端 webview 尺寸（视觉 panel + 80）配合，
    // 给 shadow-2xl 留出渲染空间。webview 本身 transparent，外面是真透明。
    <div className="flex h-screen w-screen items-center justify-center bg-transparent p-10">
      <div className="flex h-full w-full flex-col overflow-hidden rounded-2xl border border-te-dialog-border bg-te-dialog-bg shadow-2xl">
        {mode === "edit-last-record" ? (
          <EditLastRecordView key={mode} />
        ) : (
          <div className="flex flex-1 items-center justify-center font-mono text-[12px] uppercase tracking-[0.15em] text-te-light-gray">
            …
          </div>
        )}
      </div>
    </div>
  );
}
