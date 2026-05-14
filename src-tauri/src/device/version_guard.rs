// SemVer 比对 + Quarantine 状态机骨架
// major 不同 → Quarantine（互拒业务，提示升级）；minor / patch 兼容

use serde::{Deserialize, Serialize};

use super::protocol::QuarantineReason;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct SemVer {
    pub major: u16,
    pub minor: u16,
    pub patch: u16,
}

impl SemVer {
    // 解析 "1.2.3"；非法格式返回 None
    pub fn parse(_s: &str) -> Option<SemVer> {
        todo!("split '.', 三段 u16，非法即 None")
    }

    pub fn to_wire(&self) -> String {
        format!("{}.{}.{}", self.major, self.minor, self.patch)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Compat {
    Equal,
    MinorAhead,
    MinorBehind,
    PatchOnly,
    MajorMismatch,
}

// 桌面端本机协议版本 vs 设备上报版本
pub fn compare(local: SemVer, peer: SemVer) -> Compat {
    if local.major != peer.major {
        return Compat::MajorMismatch;
    }
    if local.minor > peer.minor {
        return Compat::MinorAhead;
    }
    if local.minor < peer.minor {
        return Compat::MinorBehind;
    }
    if local.patch == peer.patch {
        Compat::Equal
    } else {
        Compat::PatchOnly
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineState {
    None,
    Quarantined,
    Lifted,
}

#[derive(Debug, Clone)]
pub struct QuarantineCtx {
    pub state: QuarantineState,
    pub reason: Option<QuarantineReason>,
    pub required_app_version: Option<String>,
    pub required_firmware_version: Option<String>,
}

impl QuarantineCtx {
    pub fn new() -> Self {
        Self {
            state: QuarantineState::None,
            reason: None,
            required_app_version: None,
            required_firmware_version: None,
        }
    }

    // 进入 quarantine — 进入后业务面 API 全拒
    pub fn enter(&mut self, _reason: QuarantineReason, _required_app: &str, _required_fw: &str) {
        todo!("写 state=Quarantined + 持久化到设备 registry")
    }

    // 升级成功后解除
    pub fn lift(&mut self) {
        todo!("state=Lifted + 广播 QuarantineLifted")
    }

    pub fn is_blocked(&self) -> bool {
        matches!(self.state, QuarantineState::Quarantined)
    }
}

impl Default for QuarantineCtx {
    fn default() -> Self {
        Self::new()
    }
}
