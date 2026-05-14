// 握手状态机骨架 — hello / hello_ack / protocol_incompatible
// 与 sdk 端 Handshake 模块对端镜像；major 不一致即拒绝业务

use serde::{Deserialize, Serialize};

use super::protocol::{
    DeviceId, HelloAckPayload, HelloPayload, ProtocolIncompatiblePayload, QuarantineReason,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HandshakeState {
    Idle,
    HelloReceived,
    Accepted,
    Rejected,
}

#[derive(Debug, Clone)]
pub struct HandshakeContext {
    pub state: HandshakeState,
    pub peer_device_id: Option<DeviceId>,
    pub peer_protocol_version: Option<String>,
    pub peer_firmware_semver: Option<String>,
    pub token_seq: u32,
}

impl HandshakeContext {
    pub fn new() -> Self {
        Self {
            state: HandshakeState::Idle,
            peer_device_id: None,
            peer_protocol_version: None,
            peer_firmware_semver: None,
            token_seq: 0,
        }
    }

    // 收到 device → desktop 的 hello，决定 accept / quarantine
    pub fn on_hello(&mut self, _hello: &HelloPayload) -> HandshakeOutcome {
        todo!("major 比对 + token_seq 校验 + bound_user_id 校验")
    }

    // 主动发起 hello_ack
    pub fn build_hello_ack(&self) -> HelloAckPayload {
        todo!("填本机 app_version + server_protocol + server_time_ms")
    }

    // major 不匹配时回 protocol_incompatible
    pub fn build_protocol_incompatible(
        &self,
        _reason: QuarantineReason,
    ) -> ProtocolIncompatiblePayload {
        todo!("填 required_app_version / required_firmware_version")
    }
}

impl Default for HandshakeContext {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone)]
pub enum HandshakeOutcome {
    Accept(HelloAckPayload),
    Quarantine(ProtocolIncompatiblePayload),
    Reject { reason: QuarantineReason },
}
