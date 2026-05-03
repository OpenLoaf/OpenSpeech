import { useEffect, useRef } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { BindingId } from "@/lib/hotkey";
import type { RecordingState } from "@/stores/recording";
import type { ToastPayload } from "./state";

interface FsmPayload {
  state: RecordingState;
  activeId: BindingId | null;
  errorMessage: string | null;
  recordingId: string | null;
  liveTranscript: string;
  /** main 在注入末尾段广播 true，让 pill 早于"全部敲完"开始 exit。可选字段：
   *  老版本主窗发的 payload 没有这个字段，缺省 false。 */
  pillEarlyHide?: boolean;
}

interface KeyPreviewPayload {
  code: string;
  phase: "pressed" | "released";
  isRepeat?: boolean;
}

interface DebugPayload {
  active: boolean;
  totalMs?: number;
  endAtUnixMs?: number;
}

export interface OverlayHandlers {
  onFsm: (p: FsmPayload) => void;
  onToast: (p: ToastPayload) => void;
  /** 任意非 repeat 的 Esc 按下：用于关 toast。录音内的双击/中止仍走主窗 FSM。 */
  onEscPressed: () => void;
  onEscArmed: () => void;
  onEscDisarmed: () => void;
  onDebug: (p: DebugPayload) => void;
}

/**
 * 集中订阅悬浮条所需的全部 Tauri 事件，并保证 cleanup 时异步 unlisten 全部完成。
 *
 * 关键点：
 * 1. handlers 用 ref 存最新引用，effect 只在 mount/unmount 时跑——避免每次父组件
 *    re-render 都重挂 5 个 listener。
 * 2. unlisten 是 Promise<void>，cleanup 同步 return 不能 await；用 Promise.all
 *    收齐 UnlistenFn 后再调用，避免 Tauri 内部 listener 表残留。
 * 3. mount 时立即 emit "overlay-ready"——主窗收到会重发当前 FSM 快照，解决
 *    overlay 监听器晚于主窗状态变化的 boot race。
 */
export function useOverlayListeners(handlers: OverlayHandlers) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    let alive = true;
    const pending: Promise<UnlistenFn>[] = [];

    pending.push(
      listen<FsmPayload>("openspeech://recording-phase", (e) => {
        if (alive) handlersRef.current.onFsm(e.payload);
      }),
    );

    pending.push(
      listen<ToastPayload>("openspeech://overlay-toast", (e) => {
        if (alive) handlersRef.current.onToast(e.payload);
      }),
    );

    pending.push(
      listen<KeyPreviewPayload>("openspeech://key-preview", (e) => {
        if (!alive) return;
        if (e.payload.phase !== "pressed") return;
        if (e.payload.code !== "Escape") return;
        if (e.payload.isRepeat) return;
        handlersRef.current.onEscPressed();
      }),
    );

    pending.push(
      listen("openspeech://esc-armed", () => {
        if (alive) handlersRef.current.onEscArmed();
      }),
    );

    pending.push(
      listen("openspeech://esc-disarmed", () => {
        if (alive) handlersRef.current.onEscDisarmed();
      }),
    );

    pending.push(
      listen<DebugPayload>("openspeech://debug-recording", (e) => {
        if (alive) handlersRef.current.onDebug(e.payload);
      }),
    );

    void emit("openspeech://overlay-ready");

    return () => {
      alive = false;
      void Promise.all(pending).then((unlisten) => {
        unlisten.forEach((u) => u());
      });
    };
  }, []);
}
