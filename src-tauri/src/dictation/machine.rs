// 听写会话状态机（纯逻辑，不碰 AppHandle / 线程 / IO）。
//
// 所有输入（快捷键、ESC、悬浮条按钮、采集结果、前端 worker 上报）都变成 `Input`，
// `Machine::handle` 同步算出新状态 + 要执行的副作用 `Effect`，由 runtime 在锁外执行。
// 副作用执行完产生的后续结果（采集就绪 / 失败、落盘结果）再作为新的 `Input` 回灌。
//
// 会话隔离：每次开录生成新的 session_id，前端 worker 的所有上报都带 id，
// id 不等于当前会话的输入一律丢弃——旧会话残留的 refine delta / tail paste
// 永远打不进新会话，这是「文字输出两遍」一类问题的根治点。

use serde::{Deserialize, Serialize};

use crate::hotkey::BindingId;

/// 录音净时长低于该值视为误触：直接丢弃，不转写、不写历史。
pub const TOO_SHORT_MS: u64 = 1300;
/// 听写录音短于该值时跳过 AI 整理、直接输出转写原文：句子太短，整理前后几乎一样，
/// 白等一次 LLM 往返。翻译会话不受影响（短句也要翻）。
pub const SKIP_REFINE_BELOW_MS: u64 = 5000;
/// 翻译键在部分平台会被 OS / WebView 注入一次「按下-松开-按下」，<100ms 的二连发不可能是真人。
pub const OS_DUPLICATE_PRESS_MS: u64 = 100;
/// Failed 态停留时长，到点自动回 Idle。
pub const FAILED_DISMISS_MS: u64 = 2500;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum SegmentMode {
    Realtime,
    Utterance,
}

/// 开录瞬间冻结的会话配置；整个会话期间不再读实时设置，
/// 避免「开始时 REALTIME、结束时 UTTERANCE」这类中途变更导致的双重输出。
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionConfig {
    pub segment_mode: SegmentMode,
    pub refine_enabled: bool,
    pub streaming_inject: bool,
    pub clipboard_copy: bool,
}

impl Default for SessionConfig {
    fn default() -> Self {
        Self {
            segment_mode: SegmentMode::Utterance,
            refine_enabled: false,
            streaming_inject: true,
            clipboard_copy: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Idle,
    Recording,
    Transcribing,
    Refining,
    Translating,
    Outputting,
    Failed,
}

impl Phase {
    pub fn is_processing(self) -> bool {
        matches!(
            self,
            Phase::Transcribing | Phase::Refining | Phase::Translating | Phase::Outputting
        )
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ErrorInfo {
    /// 稳定错误码，前端按码取 i18n 文案（silent / save_failed / mic_interrupted / ...）。
    pub code: String,
    /// 已本地化的具体描述；为空时前端按 code 兜底。
    pub message: Option<String>,
}

impl ErrorInfo {
    pub fn code(code: &str) -> Self {
        Self {
            code: code.to_string(),
            message: None,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Session {
    pub id: String,
    pub binding: BindingId,
    pub config: SessionConfig,
    pub started_at_ms: u64,
    pub capture_ready: bool,
    pub output_chars: u32,
}

impl Session {
    pub fn is_translate(&self) -> bool {
        self.binding == BindingId::Translate
    }

    /// 本会话结束后是否会跑 AI（整理或翻译）。悬浮条据此决定「AI 优化中」文案与跳过按钮。
    pub fn uses_ai(&self) -> bool {
        self.is_translate()
            || (self.config.segment_mode == SegmentMode::Utterance && self.config.refine_enabled)
    }
}

/// 开录前的鉴权判定结果，由 runtime 在调用 `handle` 前读取。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Gate {
    /// 已登录 SaaS 或自定义听写供应商已配置。
    Open,
    /// 内存里没有有效登录态，但可能能从 keychain 恢复——需要异步检查。
    NeedsCheck,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Intent {
    /// 录音中 = 结束并转写；Failed = 关掉提示。
    Finish,
    /// 取消：录音中保存音频不转写；处理中丢弃结果。
    Cancel,
    /// 处理中取消但保留已拿到的原文与音频（悬浮条 X 在转写阶段的语义）。
    CancelKeep,
    /// 跳过 AI 优化，直接用原文。
    SkipRefine,
}

#[derive(Debug)]
pub enum Input {
    Press {
        binding: BindingId,
        at_ms: u64,
        gate: Gate,
        config: SessionConfig,
        new_session_id: String,
    },
    /// 异步鉴权检查结果；通过时按原按键重新开录。
    GateChecked {
        binding: BindingId,
        at_ms: u64,
        ok: bool,
        config: SessionConfig,
        new_session_id: String,
    },
    CaptureReady { session_id: String },
    CaptureFailed { session_id: String },
    /// 录音已落盘：voiced=false 表示整段无人声。
    Stopped { session_id: String, voiced: bool },
    StopFailed { session_id: String, message: String },
    Esc,
    Intent { intent: Intent, at_ms: u64 },
    Stage { session_id: String, phase: Phase },
    Output { session_id: String, chars: u32 },
    Done { session_id: String },
    Fail { session_id: String, error: ErrorInfo },
    /// 采集运行时致命错误（设备拔出 / 被独占）。
    StreamError { error: ErrorInfo },
    /// 登录态失效（任何 SaaS 调用 refresh 失败）。
    AuthLost,
    DismissTimer { token: u64 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CueKind {
    Start,
    Stop,
    Cancel,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum EndKind {
    /// 录音中取消：音频保存到历史，不转写。
    Aborted,
    /// 录音中登录失效：音频保存到历史并标记失败。
    AuthLost,
    /// 处理中取消：丢弃结果。
    Cancelled,
    /// 处理中取消但保留原文。
    CancelKeep,
    /// 误触 / 过短：什么都不留。
    Discarded,
    /// 采集打不开。
    StartFailed,
    /// 采集运行中断。
    Interrupted,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    CheckGate {
        binding: BindingId,
        at_ms: u64,
        config: SessionConfig,
        new_session_id: String,
    },
    /// 未登录：通知前端弹登录 / 提示，不开麦克风。
    Blocked { binding: BindingId },
    OpenCapture { session_id: String },
    /// 停止采集并落盘，随后把录音交给前端 worker 处理。
    StopCaptureForProcessing { session_id: String },
    /// 停止采集并落盘，但不转写（取消 / 登录失效）。
    StopCaptureAndEnd {
        session_id: String,
        binding: BindingId,
        kind: EndKind,
    },
    /// 停止采集并丢弃样本。
    DiscardCapture {
        session_id: String,
        binding: BindingId,
        kind: EndKind,
    },
    /// 通知前端 worker 结束本会话的后台工作（refine 流 / 实时 ASR）。
    EndWork {
        session_id: String,
        binding: BindingId,
        kind: EndKind,
    },
    SkipRefine { session_id: String },
    ModeSwitched { session_id: String, binding: BindingId },
    Cue(CueKind),
    ScheduleDismiss { token: u64 },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub seq: u64,
    pub session_id: Option<String>,
    pub phase: Phase,
    pub binding: Option<BindingId>,
    pub started_at_ms: Option<u64>,
    pub phase_entered_at_ms: u64,
    pub uses_ai: bool,
    pub segment_mode: Option<SegmentMode>,
    pub output_chars: u32,
    pub error: Option<ErrorInfo>,
}

#[derive(Debug)]
pub struct Machine {
    phase: Phase,
    phase_entered_at_ms: u64,
    session: Option<Session>,
    error: Option<ErrorInfo>,
    seq: u64,
    /// 鉴权检查进行中：期间的按键丢弃，避免重复开录。
    gate_pending: bool,
    dismiss_token: u64,
}

impl Default for Machine {
    fn default() -> Self {
        Self::new()
    }
}

impl Machine {
    pub fn new() -> Self {
        Self {
            phase: Phase::Idle,
            phase_entered_at_ms: 0,
            session: None,
            error: None,
            seq: 0,
            gate_pending: false,
            dismiss_token: 0,
        }
    }

    pub fn phase(&self) -> Phase {
        self.phase
    }

    pub fn session(&self) -> Option<&Session> {
        self.session.as_ref()
    }

    pub fn snapshot(&self) -> Snapshot {
        let s = self.session.as_ref();
        Snapshot {
            seq: self.seq,
            session_id: s.map(|s| s.id.clone()),
            phase: self.phase,
            binding: s.map(|s| s.binding),
            started_at_ms: s.map(|s| s.started_at_ms),
            phase_entered_at_ms: self.phase_entered_at_ms,
            uses_ai: s.is_some_and(Session::uses_ai),
            segment_mode: s.map(|s| s.config.segment_mode),
            output_chars: s.map_or(0, |s| s.output_chars),
            error: self.error.clone(),
        }
    }

    fn is_current(&self, session_id: &str) -> bool {
        self.session.as_ref().is_some_and(|s| s.id == session_id)
    }

    fn set_phase(&mut self, phase: Phase, now_ms: u64) {
        if self.phase != phase {
            self.phase = phase;
            self.phase_entered_at_ms = now_ms;
        }
        self.seq += 1;
    }

    fn enter_idle(&mut self, now_ms: u64) {
        self.session = None;
        self.error = None;
        self.set_phase(Phase::Idle, now_ms);
    }

    fn enter_failed(&mut self, error: ErrorInfo, now_ms: u64, fx: &mut Vec<Effect>) {
        self.session = None;
        self.error = Some(error);
        self.set_phase(Phase::Failed, now_ms);
        self.dismiss_token += 1;
        fx.push(Effect::ScheduleDismiss {
            token: self.dismiss_token,
        });
    }

    fn start_session(
        &mut self,
        binding: BindingId,
        at_ms: u64,
        config: SessionConfig,
        id: String,
        now_ms: u64,
        fx: &mut Vec<Effect>,
    ) {
        self.error = None;
        self.session = Some(Session {
            id: id.clone(),
            binding,
            config,
            started_at_ms: at_ms,
            capture_ready: false,
            output_chars: 0,
        });
        self.set_phase(Phase::Recording, now_ms);
        fx.push(Effect::Cue(CueKind::Start));
        fx.push(Effect::OpenCapture { session_id: id });
    }

    /// 结束录音：过短丢弃，否则进入转写。
    fn finish_recording(&mut self, at_ms: u64, now_ms: u64, fx: &mut Vec<Effect>) {
        let Some(s) = self.session.as_ref() else {
            return;
        };
        let id = s.id.clone();
        let binding = s.binding;
        let duration = at_ms.saturating_sub(s.started_at_ms);
        if duration < TOO_SHORT_MS {
            fx.push(Effect::DiscardCapture {
                session_id: id,
                binding,
                kind: EndKind::Discarded,
            });
            fx.push(Effect::Cue(CueKind::Cancel));
            self.enter_idle(now_ms);
            return;
        }
        if duration < SKIP_REFINE_BELOW_MS
            && !s.is_translate()
            && let Some(s) = self.session.as_mut()
        {
            // 在进入转写前关掉整理：前端管线与悬浮条（uses_ai）都读这份会话配置。
            s.config.refine_enabled = false;
        }
        fx.push(Effect::Cue(CueKind::Stop));
        fx.push(Effect::StopCaptureForProcessing { session_id: id });
        self.set_phase(Phase::Transcribing, now_ms);
    }

    fn cancel(&mut self, keep: bool, now_ms: u64, fx: &mut Vec<Effect>) {
        match self.phase {
            Phase::Recording => {
                if let Some(s) = self.session.as_ref() {
                    fx.push(Effect::StopCaptureAndEnd {
                        session_id: s.id.clone(),
                        binding: s.binding,
                        kind: EndKind::Aborted,
                    });
                }
                fx.push(Effect::Cue(CueKind::Cancel));
                self.enter_idle(now_ms);
            }
            p if p.is_processing() => {
                if let Some(s) = self.session.as_ref() {
                    fx.push(Effect::EndWork {
                        session_id: s.id.clone(),
                        binding: s.binding,
                        kind: if keep {
                            EndKind::CancelKeep
                        } else {
                            EndKind::Cancelled
                        },
                    });
                }
                self.enter_idle(now_ms);
            }
            Phase::Failed => self.enter_idle(now_ms),
            _ => {}
        }
    }

    pub fn handle(&mut self, input: Input, now_ms: u64) -> Vec<Effect> {
        let mut fx = Vec::new();
        match input {
            Input::Press {
                binding,
                at_ms,
                gate,
                config,
                new_session_id,
            } => self.on_press(binding, at_ms, gate, config, new_session_id, now_ms, &mut fx),
            Input::GateChecked {
                binding,
                at_ms,
                ok,
                config,
                new_session_id,
            } => {
                self.gate_pending = false;
                if !matches!(self.phase, Phase::Idle | Phase::Failed) {
                    return fx;
                }
                if ok {
                    self.start_session(binding, at_ms, config, new_session_id, now_ms, &mut fx);
                } else {
                    fx.push(Effect::Blocked { binding });
                }
            }
            Input::CaptureReady { session_id } => {
                if let Some(s) = self.session.as_mut().filter(|s| s.id == session_id) {
                    s.capture_ready = true;
                }
            }
            Input::CaptureFailed { session_id } => {
                if self.phase == Phase::Recording
                    && let Some(s) = self.session.as_ref().filter(|s| s.id == session_id)
                {
                    // 具体原因由 audio::start 的 mic-start-failed 事件单独提示，这里只回 Idle，
                    // 不再叠一个 Failed pill 重复报错。
                    fx.push(Effect::EndWork {
                        session_id,
                        binding: s.binding,
                        kind: EndKind::StartFailed,
                    });
                    self.enter_idle(now_ms);
                }
            }
            Input::Stopped { session_id, voiced } => {
                if self.is_current(&session_id) && self.phase == Phase::Transcribing && !voiced {
                    self.enter_failed(ErrorInfo::code("silent"), now_ms, &mut fx);
                }
            }
            Input::StopFailed {
                session_id,
                message,
            } => {
                if self.is_current(&session_id) && self.phase.is_processing() {
                    self.enter_failed(
                        ErrorInfo {
                            code: "save_failed".into(),
                            message: Some(message),
                        },
                        now_ms,
                        &mut fx,
                    );
                }
            }
            Input::Esc => self.cancel(false, now_ms, &mut fx),
            Input::Intent { intent, at_ms } => match intent {
                Intent::Finish => match self.phase {
                    Phase::Recording => self.finish_recording(at_ms, now_ms, &mut fx),
                    Phase::Failed => self.enter_idle(now_ms),
                    _ => {}
                },
                Intent::Cancel => self.cancel(false, now_ms, &mut fx),
                Intent::CancelKeep => self.cancel(true, now_ms, &mut fx),
                Intent::SkipRefine => {
                    if matches!(self.phase, Phase::Transcribing | Phase::Refining)
                        && let Some(s) = self.session.as_ref().filter(|s| s.uses_ai())
                    {
                        fx.push(Effect::SkipRefine {
                            session_id: s.id.clone(),
                        });
                    }
                }
            },
            Input::Stage { session_id, phase } => {
                if self.is_current(&session_id)
                    && self.phase.is_processing()
                    && matches!(
                        phase,
                        Phase::Transcribing | Phase::Refining | Phase::Translating
                    )
                {
                    self.set_phase(phase, now_ms);
                }
            }
            Input::Output { session_id, chars } => {
                if !self.is_current(&session_id) {
                    return fx;
                }
                if let Some(s) = self.session.as_mut() {
                    s.output_chars = chars;
                }
                // 录音中的输出（REALTIME 边说边出字）不改变阶段，只刷新计数。
                if self.phase.is_processing() {
                    self.set_phase(Phase::Outputting, now_ms);
                } else {
                    self.seq += 1;
                }
            }
            Input::Done { session_id } => {
                if self.is_current(&session_id) && self.phase.is_processing() {
                    self.enter_idle(now_ms);
                }
            }
            Input::Fail { session_id, error } => {
                let Some(binding) = self
                    .session
                    .as_ref()
                    .filter(|s| s.id == session_id)
                    .map(|s| s.binding)
                else {
                    return fx;
                };
                match self.phase {
                    Phase::Recording => {
                        // 录音中后台工作失败（余额不足 / 实时 ASR worker 挂掉）：丢弃采集。
                        fx.push(Effect::DiscardCapture {
                            session_id,
                            binding,
                            kind: EndKind::Interrupted,
                        });
                        self.enter_failed(error, now_ms, &mut fx);
                    }
                    p if p.is_processing() => self.enter_failed(error, now_ms, &mut fx),
                    _ => {}
                }
            }
            Input::StreamError { error } => {
                if self.phase == Phase::Recording
                    && let Some(s) = self.session.as_ref()
                {
                    fx.push(Effect::DiscardCapture {
                        session_id: s.id.clone(),
                        binding: s.binding,
                        kind: EndKind::Interrupted,
                    });
                    self.enter_failed(error, now_ms, &mut fx);
                }
            }
            Input::AuthLost => {
                // 录音中登录失效：立刻停录并保存音频（不丢用户说的话），不再「一边弹登录一边录」。
                // 处理阶段不打断，前端 worker 会按接口返回的 401 自行写失败历史。
                if self.phase == Phase::Recording
                    && let Some(s) = self.session.as_ref()
                {
                    fx.push(Effect::StopCaptureAndEnd {
                        session_id: s.id.clone(),
                        binding: s.binding,
                        kind: EndKind::AuthLost,
                    });
                    fx.push(Effect::Cue(CueKind::Cancel));
                    self.enter_failed(ErrorInfo::code("auth_lost"), now_ms, &mut fx);
                }
            }
            Input::DismissTimer { token } => {
                if self.phase == Phase::Failed && token == self.dismiss_token {
                    self.enter_idle(now_ms);
                }
            }
        }
        fx
    }

    #[allow(clippy::too_many_arguments)]
    fn on_press(
        &mut self,
        binding: BindingId,
        at_ms: u64,
        gate: Gate,
        config: SessionConfig,
        new_session_id: String,
        now_ms: u64,
        fx: &mut Vec<Effect>,
    ) {
        match self.phase {
            Phase::Idle | Phase::Failed => {
                if self.gate_pending {
                    return;
                }
                match gate {
                    Gate::Open => {
                        self.start_session(binding, at_ms, config, new_session_id, now_ms, fx)
                    }
                    Gate::NeedsCheck => {
                        self.gate_pending = true;
                        if self.phase == Phase::Failed {
                            self.enter_idle(now_ms);
                        }
                        fx.push(Effect::CheckGate {
                            binding,
                            at_ms,
                            config,
                            new_session_id,
                        });
                    }
                }
            }
            Phase::Recording => {
                let Some(s) = self.session.as_ref() else {
                    return;
                };
                if s.binding == binding {
                    let elapsed = at_ms.saturating_sub(s.started_at_ms);
                    if binding == BindingId::Translate && elapsed < OS_DUPLICATE_PRESS_MS {
                        return;
                    }
                    self.finish_recording(at_ms, now_ms, fx);
                    return;
                }
                // 听写 ↔ 翻译互切：仅整句模式（录音中纯采集，结束时才决定走哪条路径）。
                // 边说边出字模式已把听写文字注入光标，半路切翻译会拼出乱码。
                let switchable = |b: BindingId| {
                    matches!(
                        b,
                        BindingId::DictatePtt | BindingId::DictateToggle | BindingId::Translate
                    )
                };
                if switchable(s.binding)
                    && switchable(binding)
                    && s.config.segment_mode == SegmentMode::Utterance
                {
                    let id = s.id.clone();
                    if let Some(s) = self.session.as_mut() {
                        s.binding = binding;
                    }
                    self.seq += 1;
                    fx.push(Effect::ModeSwitched {
                        session_id: id,
                        binding,
                    });
                    fx.push(Effect::Cue(CueKind::Start));
                }
            }
            // 处理中按键一律忽略，且不开采集（旧实现会预开一路麦克风后泄漏）。
            _ => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn press(m: &mut Machine, binding: BindingId, at_ms: u64, id: &str) -> Vec<Effect> {
        m.handle(
            Input::Press {
                binding,
                at_ms,
                gate: Gate::Open,
                config: SessionConfig::default(),
                new_session_id: id.into(),
            },
            at_ms,
        )
    }

    fn recording(m: &mut Machine, id: &str) {
        press(m, BindingId::DictateToggle, 1_000, id);
        m.handle(
            Input::CaptureReady {
                session_id: id.into(),
            },
            1_050,
        );
    }

    #[test]
    fn press_opens_capture_and_enters_recording() {
        let mut m = Machine::new();
        let fx = press(&mut m, BindingId::DictateToggle, 1_000, "s1");
        assert_eq!(m.phase(), Phase::Recording);
        assert!(fx.contains(&Effect::OpenCapture {
            session_id: "s1".into()
        }));
        assert!(fx.contains(&Effect::Cue(CueKind::Start)));
    }

    // 未登录时绝不能开麦克风：先异步检查，失败只通知前端，状态留在 Idle。
    #[test]
    fn closed_gate_never_opens_capture() {
        let mut m = Machine::new();
        let fx = m.handle(
            Input::Press {
                binding: BindingId::DictateToggle,
                at_ms: 1_000,
                gate: Gate::NeedsCheck,
                config: SessionConfig::default(),
                new_session_id: "s1".into(),
            },
            1_000,
        );
        assert_eq!(m.phase(), Phase::Idle);
        assert!(matches!(fx.as_slice(), [Effect::CheckGate { .. }]));
        let fx = m.handle(
            Input::GateChecked {
                binding: BindingId::DictateToggle,
                at_ms: 1_000,
                ok: false,
                config: SessionConfig::default(),
                new_session_id: "s1".into(),
            },
            1_200,
        );
        assert_eq!(m.phase(), Phase::Idle);
        assert_eq!(
            fx,
            vec![Effect::Blocked {
                binding: BindingId::DictateToggle
            }]
        );
    }

    #[test]
    fn second_press_of_same_binding_stops_for_processing() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        let fx = press(&mut m, BindingId::DictateToggle, 5_000, "s2");
        assert_eq!(m.phase(), Phase::Transcribing);
        assert!(fx.contains(&Effect::StopCaptureForProcessing {
            session_id: "s1".into()
        }));
    }

    #[test]
    fn too_short_recording_is_discarded() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        let fx = press(&mut m, BindingId::DictateToggle, 1_500, "s2");
        assert_eq!(m.phase(), Phase::Idle);
        assert!(fx.contains(&Effect::DiscardCapture {
            session_id: "s1".into(),
            binding: BindingId::DictateToggle,
            kind: EndKind::Discarded
        }));
    }

    // 处理中再按快捷键：什么都不做，尤其不能开新采集（旧实现的麦克风泄漏）。
    #[test]
    fn press_while_processing_is_ignored() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        press(&mut m, BindingId::DictateToggle, 5_000, "s2");
        let fx = press(&mut m, BindingId::DictateToggle, 6_000, "s3");
        assert!(fx.is_empty());
        assert_eq!(m.phase(), Phase::Transcribing);
        assert_eq!(m.session().map(|s| s.id.as_str()), Some("s1"));
    }

    // 旧会话的上报（迟到的 refine 输出 / 完成）不能影响新会话。
    #[test]
    fn stale_session_reports_are_dropped() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        press(&mut m, BindingId::DictateToggle, 5_000, "x");
        m.handle(Input::Esc, 5_100);
        recording(&mut m, "s2");
        m.handle(
            Input::Output {
                session_id: "s1".into(),
                chars: 10,
            },
            6_000,
        );
        m.handle(
            Input::Done {
                session_id: "s1".into(),
            },
            6_000,
        );
        assert_eq!(m.phase(), Phase::Recording);
        assert_eq!(m.session().map(|s| s.output_chars), Some(0));
    }

    #[test]
    fn output_moves_processing_to_outputting_and_done_returns_idle() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        press(&mut m, BindingId::DictateToggle, 5_000, "x");
        m.handle(
            Input::Output {
                session_id: "s1".into(),
                chars: 3,
            },
            5_500,
        );
        assert_eq!(m.phase(), Phase::Outputting);
        m.handle(
            Input::Done {
                session_id: "s1".into(),
            },
            5_600,
        );
        assert_eq!(m.phase(), Phase::Idle);
    }

    #[test]
    fn esc_while_recording_saves_audio() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        let fx = m.handle(Input::Esc, 3_000);
        assert_eq!(m.phase(), Phase::Idle);
        assert!(fx.contains(&Effect::StopCaptureAndEnd {
            session_id: "s1".into(),
            binding: BindingId::DictateToggle,
            kind: EndKind::Aborted
        }));
    }

    // 登录失效时正在录音：停录保存，进入 Failed，不再继续录。
    #[test]
    fn auth_lost_while_recording_stops_capture() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        let fx = m.handle(Input::AuthLost, 3_000);
        assert_eq!(m.phase(), Phase::Failed);
        assert!(fx.contains(&Effect::StopCaptureAndEnd {
            session_id: "s1".into(),
            binding: BindingId::DictateToggle,
            kind: EndKind::AuthLost
        }));
    }

    #[test]
    fn silent_recording_fails_and_auto_dismisses() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        press(&mut m, BindingId::DictateToggle, 5_000, "x");
        let fx = m.handle(
            Input::Stopped {
                session_id: "s1".into(),
                voiced: false,
            },
            5_100,
        );
        assert_eq!(m.phase(), Phase::Failed);
        let Some(Effect::ScheduleDismiss { token }) = fx.first() else {
            panic!("expected dismiss timer");
        };
        m.handle(Input::DismissTimer { token: *token }, 8_000);
        assert_eq!(m.phase(), Phase::Idle);
    }

    #[test]
    fn mode_switch_only_in_utterance_mode() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        let fx = press(&mut m, BindingId::Translate, 2_000, "x");
        assert!(fx.contains(&Effect::ModeSwitched {
            session_id: "s1".into(),
            binding: BindingId::Translate
        }));
        assert_eq!(m.session().map(|s| s.binding), Some(BindingId::Translate));

        let mut m = Machine::new();
        m.handle(
            Input::Press {
                binding: BindingId::DictateToggle,
                at_ms: 1_000,
                gate: Gate::Open,
                config: SessionConfig {
                    segment_mode: SegmentMode::Realtime,
                    ..SessionConfig::default()
                },
                new_session_id: "s1".into(),
            },
            1_000,
        );
        let fx = press(&mut m, BindingId::Translate, 2_000, "x");
        assert!(fx.is_empty());
    }

    fn recording_with_refine(m: &mut Machine, binding: BindingId, id: &str) {
        m.handle(
            Input::Press {
                binding,
                at_ms: 1_000,
                gate: Gate::Open,
                config: SessionConfig {
                    refine_enabled: true,
                    ..SessionConfig::default()
                },
                new_session_id: id.into(),
            },
            1_000,
        );
        m.handle(
            Input::CaptureReady {
                session_id: id.into(),
            },
            1_050,
        );
    }

    // 不到 5 秒的听写直接输出原文：整理几乎不改短句，省一次 LLM 往返。
    #[test]
    fn short_dictation_skips_refine() {
        let mut m = Machine::new();
        recording_with_refine(&mut m, BindingId::DictateToggle, "s1");
        press(
            &mut m,
            BindingId::DictateToggle,
            1_000 + SKIP_REFINE_BELOW_MS - 1,
            "x",
        );
        assert_eq!(m.phase(), Phase::Transcribing);
        assert!(!m.session().unwrap().config.refine_enabled);
        assert!(!m.snapshot().uses_ai);
    }

    #[test]
    fn long_dictation_keeps_refine() {
        let mut m = Machine::new();
        recording_with_refine(&mut m, BindingId::DictateToggle, "s1");
        press(
            &mut m,
            BindingId::DictateToggle,
            1_000 + SKIP_REFINE_BELOW_MS,
            "x",
        );
        assert!(m.session().unwrap().config.refine_enabled);
        assert!(m.snapshot().uses_ai);
    }

    // 翻译不受短句阈值影响：短句也必须翻译。
    #[test]
    fn short_translation_still_uses_ai() {
        let mut m = Machine::new();
        recording_with_refine(&mut m, BindingId::Translate, "s1");
        press(&mut m, BindingId::Translate, 3_000, "x");
        assert_eq!(m.phase(), Phase::Transcribing);
        assert!(m.snapshot().uses_ai);
    }

    #[test]
    fn skip_refine_only_when_ai_runs() {
        let mut m = Machine::new();
        recording(&mut m, "s1");
        press(&mut m, BindingId::DictateToggle, 5_000, "x");
        let fx = m.handle(
            Input::Intent {
                intent: Intent::SkipRefine,
                at_ms: 5_100,
            },
            5_100,
        );
        assert!(fx.is_empty(), "refine disabled → skip is a no-op");
    }
}
