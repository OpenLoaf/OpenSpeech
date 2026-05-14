// 应用层事件 — 与 sdk/src/protocol/Events.h 对应
// 桌面端用此枚举往 Tauri 前端 emit，前端订阅展示

use serde::{Deserialize, Serialize};

use super::error_codes::ErrorCode;
use super::protocol::{
    AsrStage, BatteryTier, ButtonGestureKind, ChannelType, DegradedKind, DeliveryMode, DeviceId,
    NetworkChangeKind, OnboardingScreen, OtaOutcome, ProfileId, ProvisioningStage,
    QuarantineReason, ServiceUnavailableKind, SessionId, UnpairReason, UpgradeTarget,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelStatusEvent {
    pub ble_up: bool,
    pub wifi_up: bool,
    pub ble_rtt_ms: u16,
    pub wifi_rtt_ms: u16,
    pub wifi_rssi: i8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChannelUnstableInfo {
    pub channel: ChannelType,
    pub flap_count: u8,
    pub window_ms: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VersionMismatchInfo {
    pub local_protocol: String,
    pub peer_protocol: String,
    pub upgrade_target: UpgradeTarget,
    pub required_app_version: String,
    pub required_firmware_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OtaOfferInfo {
    pub offer_id: String,
    pub target_version: String,
    pub size_bytes: u32,
    pub changelog_url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextResultInfo {
    pub session_id: SessionId,
    pub text: String,
    pub delivery_mode: DeliveryMode,
    pub target_app: String,
    pub language_detected: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PeerStatusInfo {
    pub app_running: bool,
    pub signed_in: bool,
    pub cloud_reachable: bool,
    pub internet_reachable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProvisionInfo {
    pub ssid: String,
    pub server_host: String,
    pub bound_user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct QuarantineInfo {
    pub reason: QuarantineReason,
    pub required_app_version: String,
    pub required_firmware_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceTelemetry {
    pub battery_pct: u8,
    pub charging: bool,
    pub wifi_rssi: i8,
    pub ble_rtt_ms: u16,
    pub fw_version: String,
    pub protocol_version: String,
    pub total_sessions: u32,
    pub total_credits_consumed: u32,
    pub free_heap: u32,
    pub psram_free: u32,
    pub last_active_wallclock_ms: u64,
}

// ============================================================================
// 顶层事件枚举 — 直接 emit 到前端；wire enum 用 t/payload tag
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
pub enum DeviceEvent {
    // 配网 / 所有权
    Provisioned { device_id: DeviceId, info: ProvisionInfo },
    Unpaired { device_id: DeviceId, reason: UnpairReason },
    PairingChallengePresented { device_id: DeviceId, pin: String },
    PairingThrottled { device_id: DeviceId, retry_after_ms: u32 },
    LabelCollisionResolved { device_id: DeviceId, old_label: String, new_label: String },
    OnboardingScreenRequest { device_id: DeviceId, screen: OnboardingScreen },
    ReAuthRequested { device_id: DeviceId },
    ReAuthSucceeded { device_id: DeviceId },
    OwnerMismatch { device_id: DeviceId, bound_user: String, current_user: String },
    WifiProfileSwitched { device_id: DeviceId, profile_id: ProfileId, ssid: String },

    // 通道
    ChannelChange { device_id: DeviceId, status: ChannelStatusEvent },
    ChannelUnstable { device_id: DeviceId, info: ChannelUnstableInfo },
    HeartbeatLost { device_id: DeviceId, channel: ChannelType, last_seen_ms_ago: u32 },
    HeartbeatRestored { device_id: DeviceId, channel: ChannelType },
    NetworkChange { device_id: DeviceId, kind: NetworkChangeKind },
    ServerEndpointUpdated { device_id: DeviceId, host: String, port: u16 },
    ServerIdentityMismatch { device_id: DeviceId, expected_sha256: String, observed_sha256: String },
    MdnsFailed { device_id: DeviceId, fallback_used: bool },
    SignalWeak { device_id: DeviceId, wifi_rssi: i8, ble_rtt_ms: u16 },
    SignalRestored { device_id: DeviceId },
    PeerGone { device_id: DeviceId, since_ms: u32 },
    PeerReconnected { device_id: DeviceId },
    PeerStatus { device_id: DeviceId, info: PeerStatusInfo },
    PreemptedByPeer { device_id: DeviceId, peer_app_instance: String },
    ConcurrentLockDenied { device_id: DeviceId, active_device_label: String },

    // 录音 / 转写
    RecordingStateChange { device_id: DeviceId, recording: bool, session_id: SessionId },
    AudioLevel { device_id: DeviceId, rms_db: f32, clipping: bool, silent_so_far: bool },
    Gesture { device_id: DeviceId, gesture: ButtonGestureKind },
    BusyRejectedKey { device_id: DeviceId },
    PendingSessionsResumed { device_id: DeviceId, count: u8 },
    AsrProgress { device_id: DeviceId, stage: AsrStage, elapsed_ms: u32, phase_label: String },
    TextResult { device_id: DeviceId, info: TextResultInfo },
    LanguageMismatchSuggested { device_id: DeviceId, detected: String, configured: String },
    FocusTargetChanged { device_id: DeviceId, target_app: String },

    // 版本 / OTA
    PeerVersionMismatch { device_id: DeviceId, info: VersionMismatchInfo },
    Quarantined { device_id: DeviceId, info: QuarantineInfo },
    QuarantineLifted { device_id: DeviceId },
    OtaAvailable { device_id: DeviceId, info: OtaOfferInfo },
    OtaProgress { device_id: DeviceId, percent: u8, estimated_remaining_ms: u32 },
    OtaResult { device_id: DeviceId, outcome: OtaOutcome, err_if_any: Option<ErrorCode> },

    // 资源 / 硬件
    BatteryLevelChanged { device_id: DeviceId, pct: u8, tier: BatteryTier },
    ThermalWarn { device_id: DeviceId, celsius: f32 },
    ThermalCritical { device_id: DeviceId, celsius: f32 },
    LowMemory { device_id: DeviceId, free_heap: u32, psram_free: u32 },
    SelfRebootImminent { device_id: DeviceId, reason: String },
    MemoryDegraded { device_id: DeviceId, kind: DegradedKind },
    NvsWriteBudgetExceeded { device_id: DeviceId, key: String, count: u16 },
    WakeFromSleep { device_id: DeviceId, duration_slept_ms: u64 },

    // 诊断
    TelemetryTick { device_id: DeviceId, telemetry: DeviceTelemetry },

    // 业务异常
    ServiceUnavailable { device_id: DeviceId, kind: ServiceUnavailableKind, action_url: String },
    ProvisioningFailed { device_id: DeviceId, stage: ProvisioningStage, detail: String },
    Error { device_id: DeviceId, code: ErrorCode, detail: String },

    // 兜底
    UnknownEvent { device_id: DeviceId, wire_tag: String, json_payload: String },
}
