import { useEffect, useReducer, useRef } from "react";
import type { BindingId } from "@/lib/hotkey";
import type { RecordingState } from "@/stores/recording";

// 悬浮条 UI 状态机：单一 reducer + 集中 timer，所有副作用集中在 useOverlayMachine 内。
// 输入 main 字段来自全局广播 `openspeech://recording-phase`（主窗 FSM 每次状态变化
// 时 emit），overlay 不依赖任何"被点对点投递"的 mirror 事件——同一个广播 main /
// overlay / 未来的 Live 面板都能消费。toast / escArmed 子状态由 reducer 自治。

export type ToastKind = "error" | "warning" | "info";
export type ToastActionKey =
  | "open_login"
  | "open_no_internet"
  | "open_settings_byo"
  | "switch_to_saas";

export interface ToastPayload {
  kind: ToastKind;
  title: string;
  description?: string;
  action?: { label: string; key: ToastActionKey };
  /** 0 = 不自动消失（用户必须显式关闭或点动作）。默认 2000ms。 */
  durationMs?: number;
  /** ESC arm 提示这种「与 escArmed 状态强绑定」的 toast：disarm 时一并消失，
   *  避免用户激活快捷键 toggle 结束录音后，提示条还残留在悬浮条上方。 */
  dismissOnDisarm?: boolean;
}

export interface ToastState extends ToastPayload {
  id: number;
}

/** DEV-only DEBUG 模拟态：主窗用录音文件回放走整条 dictation pipeline 时广播。
 *  active=true 期间在 pill 上方挂一条 "DEBUG · 倒数 Xs" 提示条；ESC 双击可取消。 */
export interface DebugState {
  active: boolean;
  /** Date.now() 基准的截止时刻；overlay 自己 setInterval 算 remainingMs */
  endAtUnixMs: number | null;
  totalMs: number;
}

/** 翻译听写激活态：activeId=translate 进入 preparing 时主窗推一条 active=true 上来，
 *  录音流程结束（recording → transcribing/idle/error）时推 active=false。仅做"模式
 *  指示"用——在 pill 上方挂一个独立轻量 indicator（语种 + Languages 图标），与
 *  toast 警告语义解耦。lang 是当前界面语言下的目标语言全称（"英文" / "English" 等）。 */
export interface TranslateState {
  active: boolean;
  lang: string;
}

/** 录音中跨模式切换提示：UTTERANCE 模式下按另一种激活键，pill 中心 wave 临时
 *  替换为"切换到 X 模式"文字 ~2s。kind=null 表示无 hint；非 null 时 reducer
 *  会在 setModeSwitchHint 启动 timer 自动回退。 */
export type ModeSwitchKind = "translate" | "dictation";

/** 注入降级到"剪贴板兜底"时由主窗推过来的转录结果。目标 app 已切走 / 不可写
 *  / 用户关掉了自动注入时弹出。pill 已 idle，结果面板独立挂在底部 shell，让
 *  用户能看到内容并一键复制。 */
export interface TranscriptResultState {
  text: string;
}

export interface OverlayState {
  /** 镜像主窗 RecordingState；overlay 不参与副作用，仅渲染。 */
  main: RecordingState;
  /** 当前激活的快捷键 binding；翻译听写时为 "translate"，让悬浮条切到翻译标识。 */
  activeId: BindingId | null;
  errorMessage: string | null;
  liveTranscript: string;
  toast: ToastState | null;
  escArmed: boolean;
  /** 注入末尾段 main 窗主动让 pill 提前 exit，比"全部敲完"快一拍。 */
  pillEarlyHide: boolean;
  debug: DebugState;
  translate: TranslateState;
  modeSwitchHint: ModeSwitchKind | null;
  /** 注入失败兜底：展示最终转录文本 + 复制 / 关闭按钮。null = 不显示。 */
  transcriptResult: TranscriptResultState | null;
  /** 主窗当前是否处于前台激活态——用户直接看主窗时不需要悬浮条遮挡视线；
   *  录音流程例外（在 visible 计算时显式短路）。默认 false：boot 期还没收到
   *  主窗 focus 广播之前保守按"未激活"处理，避免遗漏关键提示。 */
  mainFocused: boolean;
}

const INITIAL: OverlayState = {
  main: "idle",
  activeId: null,
  errorMessage: null,
  liveTranscript: "",
  toast: null,
  escArmed: false,
  pillEarlyHide: false,
  debug: { active: false, endAtUnixMs: null, totalMs: 0 },
  translate: { active: false, lang: "" },
  modeSwitchHint: null,
  transcriptResult: null,
  mainFocused: false,
};

type Action =
  | {
      type: "fsm";
      state: RecordingState;
      activeId: BindingId | null;
      errorMessage: string | null;
      liveTranscript: string;
      pillEarlyHide: boolean;
    }
  | { type: "toast-show"; payload: ToastPayload; id: number }
  | { type: "toast-dismiss"; id?: number }
  | { type: "esc-armed" }
  | { type: "esc-disarmed" }
  | { type: "debug"; debug: DebugState }
  | { type: "translate"; translate: TranslateState }
  | { type: "mode-switch-show"; kind: ModeSwitchKind }
  | { type: "mode-switch-clear" }
  | { type: "result-show"; text: string }
  | { type: "result-dismiss" }
  | { type: "main-focus"; focused: boolean };

function reduce(s: OverlayState, a: Action): OverlayState {
  switch (a.type) {
    case "fsm":
      // error → 非 error 切换时一起清 toast：用户按激活快捷键 / ESC 主动放弃
      // 失败提示时，pill 立即变 idle，伴生的失败 toast 不该再多停 0.x 秒。
      // 自然超时（ERROR_AUTO_DISMISS_MS）回 idle 也走这条路径，体感更整齐。
      // 进入 preparing/recording 视为新一轮听写，把上一次残留的兜底结果面板清掉。
      return {
        ...s,
        main: a.state,
        activeId: a.activeId,
        errorMessage: a.errorMessage,
        liveTranscript: a.liveTranscript,
        pillEarlyHide: a.pillEarlyHide,
        toast: s.main === "error" && a.state !== "error" ? null : s.toast,
        transcriptResult:
          a.state === "preparing" || a.state === "recording"
            ? null
            : s.transcriptResult,
      };
    case "toast-show":
      return { ...s, toast: { ...a.payload, id: a.id } };
    case "toast-dismiss":
      if (a.id !== undefined && s.toast?.id !== a.id) return s;
      return { ...s, toast: null };
    case "esc-armed":
      return { ...s, escArmed: true };
    case "esc-disarmed":
      return {
        ...s,
        escArmed: false,
        toast: s.toast?.dismissOnDisarm ? null : s.toast,
      };
    case "debug":
      return { ...s, debug: a.debug };
    case "translate":
      return { ...s, translate: a.translate };
    case "mode-switch-show":
      return { ...s, modeSwitchHint: a.kind };
    case "mode-switch-clear":
      return { ...s, modeSwitchHint: null };
    case "result-show":
      return { ...s, transcriptResult: { text: a.text } };
    case "result-dismiss":
      return { ...s, transcriptResult: null };
    case "main-focus":
      return { ...s, mainFocused: a.focused };
  }
}

export interface OverlayMachine {
  state: OverlayState;
  showToast: (payload: ToastPayload) => void;
  dismissToast: (id?: number) => void;
  setEscArmed: (armed: boolean) => void;
  applyFsm: (
    state: RecordingState,
    activeId: BindingId | null,
    errorMessage: string | null,
    liveTranscript: string,
    pillEarlyHide: boolean,
  ) => void;
  setDebug: (debug: DebugState) => void;
  setTranslate: (translate: TranslateState) => void;
  showModeSwitchHint: (kind: ModeSwitchKind) => void;
  showTranscriptResult: (text: string) => void;
  dismissTranscriptResult: () => void;
  setMainFocused: (focused: boolean) => void;
}

const DEFAULT_TOAST_AUTO_DISMISS_MS = 2000;
const MODE_SWITCH_HINT_MS = 1800;

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
    // disarm 路径会顺带清掉 dismissOnDisarm 的 toast——必须同时清掉它的 auto-dismiss
    // timer，否则等 timer 回调到了再 dispatch toast-dismiss(旧 id)，下一条 toast
    // 已经占用 state.toast，会被这个迟来的 dismiss 误关。
    if (!armed) clearToastTimer();
    dispatch({ type: armed ? "esc-armed" : "esc-disarmed" });
  };

  const applyFsm = (
    s: RecordingState,
    activeId: BindingId | null,
    errorMessage: string | null,
    liveTranscript: string,
    pillEarlyHide: boolean,
  ) => {
    dispatch({
      type: "fsm",
      state: s,
      activeId,
      errorMessage,
      liveTranscript,
      pillEarlyHide,
    });
  };

  const setDebug = (debug: DebugState) => {
    dispatch({ type: "debug", debug });
  };

  const setTranslate = (translate: TranslateState) => {
    dispatch({ type: "translate", translate });
  };

  const modeSwitchTimerRef = useRef<number | null>(null);
  const showModeSwitchHint = (kind: ModeSwitchKind) => {
    if (modeSwitchTimerRef.current !== null) {
      window.clearTimeout(modeSwitchTimerRef.current);
    }
    dispatch({ type: "mode-switch-show", kind });
    modeSwitchTimerRef.current = window.setTimeout(() => {
      modeSwitchTimerRef.current = null;
      dispatch({ type: "mode-switch-clear" });
    }, MODE_SWITCH_HINT_MS);
  };

  // 卸载时清掉所有 timer，防止 setTimeout 在组件销毁后还派发 dispatch（dev StrictMode
  // 会报"useReducer dispatch called after unmount"，prod 会触发 stale state warning）。
  useEffect(() => {
    return () => {
      clearToastTimer();
      if (modeSwitchTimerRef.current !== null) {
        window.clearTimeout(modeSwitchTimerRef.current);
        modeSwitchTimerRef.current = null;
      }
    };
  }, []);

  const showTranscriptResult = (text: string) => {
    dispatch({ type: "result-show", text });
  };

  const dismissTranscriptResult = () => {
    dispatch({ type: "result-dismiss" });
  };

  const setMainFocused = (focused: boolean) => {
    dispatch({ type: "main-focus", focused });
  };

  return {
    state,
    showToast,
    dismissToast,
    setEscArmed,
    applyFsm,
    setDebug,
    setTranslate,
    showModeSwitchHint,
    showTranscriptResult,
    dismissTranscriptResult,
    setMainFocused,
  };
}
