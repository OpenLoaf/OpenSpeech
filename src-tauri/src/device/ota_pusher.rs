// OTA 推送骨架 — 从 R2 拉固件 + 通过 WS 推设备 + 签名校验
// 业务侧策略（最低电量 / 反降级 / 设备 ack 进度）由上层调度，本模块仅提供执行器

use async_trait::async_trait;

use super::error_codes::ErrorCode;
use super::protocol::{DeviceId, OfferId, OtaOutcome};

#[derive(Debug, Clone)]
pub struct FirmwareManifest {
    pub target_version: String,
    pub size_bytes: u32,
    pub sha256: String,
    // 签名公钥固化在设备端；本侧只负责传递 signature
    pub signature_ed25519: String,
    pub changelog_url: String,
    pub r2_url: String,
}

#[derive(Debug, Clone)]
pub struct OtaSession {
    pub offer_id: OfferId,
    pub device_id: DeviceId,
    pub manifest: FirmwareManifest,
    pub bytes_sent: u32,
    pub last_progress_pct: u8,
}

#[async_trait]
pub trait OtaPusher: Send + Sync {
    // 给已绑定设备下发 OtaOffer；返回 offer_id 供后续追踪
    async fn offer(
        &self,
        device_id: &DeviceId,
        manifest: FirmwareManifest,
    ) -> Result<OfferId, OtaError>;

    // 设备 accept 后开始按 MAX_OTA_CHUNK_BYTES 分片传输
    async fn start_transfer(&self, offer_id: &OfferId) -> Result<(), OtaError>;

    // 设备上报最终结果（ok / failed / interrupted_rolled_back）
    async fn finalize(
        &self,
        offer_id: &OfferId,
        outcome: OtaOutcome,
        err_if_any: Option<ErrorCode>,
    ) -> Result<(), OtaError>;
}

#[derive(Debug, Clone)]
pub enum OtaError {
    R2Fetch(String),
    SignatureInvalid,
    HashMismatch,
    DeviceRejected(ErrorCode),
    Transport(String),
    BatteryTooLow,
    DowngradeBlocked,
}

pub struct OtaPusherImpl;

impl OtaPusherImpl {
    pub fn new() -> Self {
        Self
    }

    // 从 R2 拉 manifest + bin；本地验签 + 哈希后才允许进入 offer 阶段
    pub async fn fetch_and_verify(&self, _url: &str) -> Result<FirmwareManifest, OtaError> {
        todo!("reqwest get + sha256 + ed25519 verify")
    }
}

impl Default for OtaPusherImpl {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl OtaPusher for OtaPusherImpl {
    async fn offer(
        &self,
        _device_id: &DeviceId,
        _manifest: FirmwareManifest,
    ) -> Result<OfferId, OtaError> {
        todo!("分配 offer_id + 发 OtaOffer 消息")
    }
    async fn start_transfer(&self, _offer_id: &OfferId) -> Result<(), OtaError> {
        todo!("按 MAX_OTA_CHUNK_BYTES 切片 + 序号 + 收 ack")
    }
    async fn finalize(
        &self,
        _offer_id: &OfferId,
        _outcome: OtaOutcome,
        _err_if_any: Option<ErrorCode>,
    ) -> Result<(), OtaError> {
        todo!("清理 session + 上报埋点")
    }
}
