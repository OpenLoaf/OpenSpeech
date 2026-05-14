// WSS 服务骨架 — 不接 axum/tokio-tungstenite；先抽象 trait + struct
// 后续接入时实际绑 mDNS 广告 + TLS（self-signed pinning）+ 升级头校验

use async_trait::async_trait;

use super::protocol::{ChannelType, DeviceId, EnvelopeHeader};

#[derive(Debug, Clone)]
pub struct WsServerConfig {
    pub bind_host: String,
    pub bind_port: u16,
    pub mdns_instance_name: String,
    // TOFU 证书指纹（首次配对时下发给设备记忆）
    pub cert_sha256: String,
    // server cert PEM 路径或内存指针；P0 先用 self-signed
    pub cert_pem: Vec<u8>,
    pub key_pem: Vec<u8>,
}

#[async_trait]
pub trait WsServer: Send + Sync {
    async fn start(&self) -> Result<(), WsServerError>;
    async fn stop(&self) -> Result<(), WsServerError>;
    // 向已连接的设备发送 envelope；payload 由上层 flatten 进 json
    async fn send(
        &self,
        device_id: &DeviceId,
        header: EnvelopeHeader,
        payload: serde_json::Value,
    ) -> Result<(), WsServerError>;
}

#[derive(Debug, Clone)]
pub enum WsServerError {
    BindFailed(String),
    TlsConfigInvalid(String),
    PeerNotConnected(DeviceId),
    SendFailed(String),
    Stopped,
}

// 桌面端落地实现占位 — 真接入时替换为 axum/tokio-tungstenite
pub struct WsServerImpl {
    pub config: WsServerConfig,
}

impl WsServerImpl {
    pub fn new(config: WsServerConfig) -> Self {
        Self { config }
    }
}

#[async_trait]
impl WsServer for WsServerImpl {
    async fn start(&self) -> Result<(), WsServerError> {
        todo!("启动 TLS listener + mDNS 注册 + accept loop")
    }
    async fn stop(&self) -> Result<(), WsServerError> {
        todo!("撤销 mDNS + 关闭 listener + drain 现有连接")
    }
    async fn send(
        &self,
        _device_id: &DeviceId,
        _header: EnvelopeHeader,
        _payload: serde_json::Value,
    ) -> Result<(), WsServerError> {
        todo!("查找连接 + 序列化 envelope + write_message")
    }
}

// 入站事件抽象 — 上层 hub 订阅，转给 handshake / heartbeat / 业务模块
#[derive(Debug, Clone)]
pub enum WsInbound {
    Connected {
        device_id: DeviceId,
        channel: ChannelType,
    },
    Disconnected {
        device_id: DeviceId,
        channel: ChannelType,
    },
    Message {
        device_id: DeviceId,
        channel: ChannelType,
        header: EnvelopeHeader,
        payload: serde_json::Value,
    },
}
