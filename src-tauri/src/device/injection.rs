// 焦点感知 + 安全注入 + 撤回骨架
// 设备端 text_result 到达后由本模块决定：注入 / 复制 / 仅显示

use serde::{Deserialize, Serialize};

use super::protocol::{DeliveryMode, SessionId};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InjectionDecision {
    pub session_id: SessionId,
    pub delivery_mode: DeliveryMode,
    pub target_app: String,
    pub injected_text: String,
}

#[derive(Debug, Clone)]
pub struct FocusSnapshot {
    pub app_bundle_id: String,
    pub window_title: String,
    pub is_password_field: bool,
    pub is_secure_text_input: bool,
}

pub trait FocusProbe: Send + Sync {
    fn snapshot(&self) -> Option<FocusSnapshot>;
}

// 注入策略：密码框 / SecureInput / 黑名单都降级为 Copied
pub fn pick_delivery_mode(snapshot: Option<&FocusSnapshot>) -> DeliveryMode {
    match snapshot {
        Some(s) if s.is_password_field || s.is_secure_text_input => DeliveryMode::Copied,
        Some(_) => DeliveryMode::Injected,
        None => DeliveryMode::DisplayOnly,
    }
}

#[derive(Debug, Clone)]
pub struct InjectionHistoryEntry {
    pub session_id: SessionId,
    pub text: String,
    pub delivery_mode: DeliveryMode,
    pub target_app: String,
    pub injected_at_ms: u64,
}

pub trait Injector: Send + Sync {
    fn inject(&self, decision: &InjectionDecision) -> Result<(), InjectError>;
    // 撤回：双击手势触发；只能撤上一条
    fn undo_last(&self) -> Result<(), InjectError>;
}

#[derive(Debug, Clone)]
pub enum InjectError {
    NoFocusTarget,
    Blocked(String),
    UndoNotPossible,
    Backend(String),
}

pub struct DesktopInjector;

impl DesktopInjector {
    pub fn new() -> Self {
        Self
    }
}

impl Default for DesktopInjector {
    fn default() -> Self {
        Self::new()
    }
}

impl Injector for DesktopInjector {
    fn inject(&self, _decision: &InjectionDecision) -> Result<(), InjectError> {
        todo!("复用 src-tauri/src/inject 已有 enigo / windows IME guard 链路")
    }
    fn undo_last(&self) -> Result<(), InjectError> {
        todo!("送 backspace×len 或回滚 selection；与现有 undo 逻辑对齐")
    }
}
