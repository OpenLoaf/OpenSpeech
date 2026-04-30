import { useEffect, useReducer, useRef } from "react";
import type { RecordingState } from "@/stores/recording";

// 悬浮条 UI 状态机：单一 reducer + 集中 timer，所有副作用集中在 useOverlayMachine 内。
// 输入 main 字段来自全局广播 `openspeech://recording-phase`（主窗 FSM 每次状态变化
// 时 emit），overlay 不依赖任何"被点对点投递"的 mirror 事件——同一个广播 main /
// overlay / 未来的 Live 面板都能消费。toast / escArmed 子状态由 reducer 自治。

export type ToastKind = "error" | "warning" | "info";
export type ToastActionKey =
  | "open_login"
  | "open_no_internet"
  | "open_settings_byo";

export interface ToastPayload {
  kind: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; key: ToastActionKey };
  /** 0 = 不自动消失（用户必须显式关闭或点动作）。默认 2000ms。 */
  durationMs?: number;
}

export interface ToastState extends ToastPayload {
  id: number;
}

export interface OverlayState {
  /** 镜像主窗 RecordingState；overlay 不参与副作用，仅渲染。 */
  main: RecordingState;
  errorMessage: string | null;
  liveTranscript: string;
  toast: ToastState | null;
  escArmed: boolean;
}

const INITIAL: OverlayState = {
  main: "idle",
  errorMessage: null,
  liveTranscript: "",
  toast: null,
  escArmed: false,
};

type Action =
  | {
      type: "fsm";
      state: RecordingState;
      errorMessage: string | null;
      liveTranscript: string;
    }
  | { type: "toast-show"; payload: ToastPayload; id: number }
  | { type: "toast-dismiss"; id?: number }
  | { type: "esc-armed" }
  | { type: "esc-disarmed" };

function reduce(s: OverlayState, a: Action): OverlayState {
  switch (a.type) {
    case "fsm":
      // error → 非 error 切换时一起清 toast：用户按激活快捷键 / ESC 主动放弃
      // 失败提示时，pill 立即变 idle，伴生的失败 toast 不该再多停 0.x 秒。
      // 自然超时（ERROR_AUTO_DISMISS_MS）回 idle 也走这条路径，体感更整齐。
      return {
        ...s,
        main: a.state,
        errorMessage: a.errorMessage,
        liveTranscript: a.liveTranscript,
        toast: s.main === "error" && a.state !== "error" ? null : s.toast,
      };
    case "toast-show":
      return { ...s, toast: { ...a.payload, id: a.id } };
    case "toast-dismiss":
      if (a.id !== undefined && s.toast?.id !== a.id) return s;
      return { ...s, toast: null };
    case "esc-armed":
      return { ...s, escArmed: true };
    case "esc-disarmed":
      return { ...s, escArmed: false };
  }
}

export interface OverlayMachine {
  state: OverlayState;
  showToast: (payload: ToastPayload) => void;
  dismissToast: (id?: number) => void;
  setEscArmed: (armed: boolean) => void;
  applyFsm: (
    state: RecordingState,
    errorMessage: string | null,
    liveTranscript: string,
  ) => void;
}

const DEFAULT_TOAST_AUTO_DISMISS_MS = 2000;

/** Reducer + 集中 timer。toast 的 auto-dismiss timer 在 show 时启动、dismiss 时清除。 */
export function useOverlayMachine(): OverlayMachine {
  const [state, dispatch] = useReducer(reduce, INITIAL);
  const toastTimerRef = useRef<number | null>(null);
  const nextToastIdRef = useRef(1);

  const clearToastTimer = () => {
    if (toastTimerRef.current !== null) {
      window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
  };

  const showToast = (payload: ToastPayload) => {
    clearToastTimer();
    const id = nextToastIdRef.current++;
    dispatch({ type: "toast-show", payload, id });
    const dur = payload.durationMs ?? DEFAULT_TOAST_AUTO_DISMISS_MS;
    if (dur > 0) {
      toastTimerRef.current = window.setTimeout(() => {
        toastTimerRef.current = null;
        dispatch({ type: "toast-dismiss", id });
      }, dur);
    }
  };

  const dismissToast = (id?: number) => {
    clearToastTimer();
    dispatch({ type: "toast-dismiss", id });
  };

  const setEscArmed = (armed: boolean) => {
    dispatch({ type: armed ? "esc-armed" : "esc-disarmed" });
  };

  const applyFsm = (
    s: RecordingState,
    errorMessage: string | null,
    liveTranscript: string,
  ) => {
    dispatch({ type: "fsm", state: s, errorMessage, liveTranscript });
  };

  // 卸载时清掉所有 timer，防止 setTimeout 在组件销毁后还派发 dispatch（dev StrictMode
  // 会报"useReducer dispatch called after unmount"，prod 会触发 stale state warning）。
  useEffect(() => {
    return () => {
      clearToastTimer();
    };
  }, []);

  return { state, showToast, dismissToast, setEscArmed, applyFsm };
}
