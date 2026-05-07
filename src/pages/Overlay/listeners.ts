import { useEffect, useRef } from "react";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { info as logInfo } from "@tauri-apps/plugin-log";
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

interface TranslatePayload {
  active: boolean;
  /** 当前界面语言下的目标语言全称，如 "英文" / "English"。active=false 时无意义。 */
  lang?: string;
}

interface ModeSwitchHintPayload {
  kind: "translate" | "dictation";
}

interface TranscriptResultPayload {
  text: string;
}

export interface OverlayHandlers {
  onFsm: (p: FsmPayload) => void;
  onToast: (p: ToastPayload) => void;
  /** 任意非 repeat 的 Esc 按下：用于关 toast。录音内的双击/中止仍走主窗 FSM。 */
  onEscPressed: () => void;
  onEscArmed: () => void;
  onEscDisarmed: () => void;
  onDebug: (p: DebugPayload) => void;
  /** 翻译听写激活态变化——用于在 pill 上方挂"翻译为<目标语言>"独立 indicator。 */
  onTranslate: (p: TranslatePayload) => void;
  /** 录音中跨模式切换提示——overlay pill 中心临时显示"切换到 X 模式" ~2s。 */
  onModeSwitchHint: (p: ModeSwitchHintPayload) => void;
  /** 注入兜底：目标 app 已切走 / 不可写时挂结果面板让用户手动复制。 */
  onTranscriptResult: (p: TranscriptResultPayload) => void;
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

    pending.push(
      listen<TranslatePayload>("openspeech://translate-active", (e) => {
        if (alive) handlersRef.current.onTranslate(e.payload);
      }),
    );

    pending.push(
      listen<ModeSwitchHintPayload>("openspeech://mode-switch-hint", (e) => {
        if (alive) handlersRef.current.onModeSwitchHint(e.payload);
      }),
    );

    pending.push(
      listen<TranscriptResultPayload>(
        "openspeech://overlay-show-result",
        (e) => {
          void logInfo(
            `[overlay] received show-result text.len=${e.payload?.text?.length ?? 0} alive=${alive}`,
          );
          if (alive) handlersRef.current.onTranscriptResult(e.payload);
        },
      ),
    );

    void logInfo("[overlay] listeners mounted, emitting overlay-ready");
    void emit("openspeech://overlay-ready");

    return () => {
      alive = false;
      void Promise.all(pending).then((unlisten) => {
        unlisten.forEach((u) => u());
      });
    };
  }, []);
}
