// Wire 协议类型镜像 — 与 sdk/src/protocol/{Messages,Types,Constants}.h 保持同步
// 任何 wire-level 变更必须同时改 C++ header + JSON schema + 本文件

use serde::{Deserialize, Serialize};

// ============================================================================
// 协议版本常量 — 与 sdk/src/protocol/Constants.h 一一对应
// ============================================================================

pub const PROTOCOL_VERSION: &str = "1.0.0";
pub const PROTOCOL_VERSION_MAJOR: u16 = 1;
pub const PROTOCOL_VERSION_MINOR: u16 = 0;
pub const PROTOCOL_VERSION_PATCH: u16 = 0;

// 心跳默认 — 与 sdk Heartbeat:: 同步
pub mod heartbeat_defaults {
    pub const WIFI_INTERVAL_MS: u32 = 10_000;
    pub const BLE_INTERVAL_MS: u32 = 15_000;
    pub const STALE_TIMEOUT_MS: u32 = 30_000;
    pub const FLAP_DEBOUNCE_MS: u32 = 5_000;
    pub const FLAP_ALERT_PER_MINUTE: u8 = 3;
    pub const SIGNAL_WEAK_RSSI_DBM: i8 = -78;
    pub const SIGNAL_WEAK_RTT_MS: u16 = 800;
}

// 协议硬限 — 与 sdk Limits:: 同步
pub mod limits {
    pub const MAX_DEVICE_LABEL_BYTES: usize = 64;
    pub const MAX_RECORD_SECONDS: u16 = 60;
    pub const MAX_AUDIO_CHUNK_BYTES: usize = 4 * 1024;
    pub const MAX_OTA_CHUNK_BYTES: usize = 16 * 1024;
    pub const MAX_PENDING_RESUME: u8 = 8;
    pub const MAX_WIFI_PROFILES: u8 = 4;
    /// 数字比对方案：设备生成 6 位数字 code，notify 到桌面，用户对眼后按 ✓/✗。
    /// v1.0.0 PIN-base32 方案已弃用；此常量留作 wire 限额引用。
    pub const PAIRING_CODE_DIGIT_LEN: u8 = 6;
    pub const MAX_TEXT_BYTES: usize = 64 * 1024;
    pub const MAX_DIAG_LOG_RECORDS: usize = 4096;
    pub const BATTERY_LOW_PCT: u8 = 20;
    pub const BATTERY_CRITICAL_PCT: u8 = 10;
    pub const BATTERY_NO_RECORD_PCT: u8 = 5;
    pub const BATTERY_DEEP_SLEEP_PCT: u8 = 3;
    pub const OTA_MIN_BATTERY_PCT: u8 = 50;
    pub const NVS_DAILY_WRITE_BUDGET: u16 = 50;
}

// BLE GATT UUID — 与 sdk Ble:: 同步，命名以设备端为准。
// 3001 HELLO     READ + NOTIFY  设备 → 桌面：hello / hello_ack
// 3002 PAIRING   WRITE + NOTIFY 双向：数字比对方案 — 设备 notify pairing_challenge，桌面 write pairing_confirm；设备再 notify pairing_result（CONTROL 3004）
// 3003 PROVISION WRITE          桌面 → 设备：provision payload
// 3004 CONTROL   WRITE + NOTIFY 通用 control + 设备主动事件（provision_ack / provisioning_failed 也走这里）
pub mod ble {
    pub const SERVICE_UUID: &str = "6F707370-6363-686D-6963-300000003000";
    pub const CHAR_HELLO_UUID: &str = "6F707370-6363-686D-6963-300000003001";
    pub const CHAR_PAIRING_UUID: &str = "6F707370-6363-686D-6963-300000003002";
    pub const CHAR_PROVISION_UUID: &str = "6F707370-6363-686D-6963-300000003003";
    pub const CHAR_CONTROL_UUID: &str = "6F707370-6363-686D-6963-300000003004";
    pub const ADV_NAME_PREFIX: &str = "OpenSpeech-Mic-";
    pub const MDNS_SERVICE_TYPE: &str = "_openspeech-mic._tcp.local.";
}

// HTTP 升级头 / BLE hello TLV key — 与 sdk HttpHeaders:: 同步
pub mod http_headers {
    pub const PROTOCOL: &str = "X-OpenSpeech-Protocol";
    pub const FIRMWARE: &str = "X-OpenSpeech-Firmware";
    pub const DEVICE_ID: &str = "X-OpenSpeech-Device-Id";
    pub const DEVICE_TOKEN: &str = "X-OpenSpeech-Device-Token";
    pub const TOKEN_SEQ: &str = "X-OpenSpeech-Token-Seq";
    pub const BOUND_USER: &str = "X-OpenSpeech-Bound-User";
}

// ============================================================================
// 字符串别名 — 与 sdk Types.h 对应
// ============================================================================

pub type DeviceId = String;
pub type SessionId = String;
pub type OfferId = String;
pub type MessageId = String;
pub type Timestamp = u64;
pub type ProfileId = u8;

// ============================================================================
// 枚举镜像 — Types.h
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChannelType {
    Ble,
    Wifi,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Transport {
    Auto,
    BleOnly,
    WifiOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Locale {
    ZhCn,
    EnUs,
    JaJp,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PrivacyMode {
    ShowFull,
    ShowSummary,
    StatusOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryMode {
    Injected,
    Copied,
    DisplayOnly,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UnpairReason {
    UserInitiated,
    OwnerMismatch,
    FactoryReset,
    TokenRevoked,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AudioCodec {
    Pcm16Le16k,
    Opus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AsrStage {
    Uploading,
    Transcribing,
    PostProcessing,
    Done,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BatteryTier {
    Healthy,
    Low,
    Critical,
    Empty,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpgradeTarget {
    Firmware,
    App,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QuarantineReason {
    MajorProtocolDifference,
    AppTooOld,
    FirmwareTooOld,
    OwnerMismatch,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OtaOutcome {
    Ok,
    Failed,
    InterruptedRolledBack,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NetworkChangeKind {
    Roamed,
    IpChanged,
    Disconnected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DegradedKind {
    Psram,
    Nvs,
    Flash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServiceUnavailableKind {
    Saas,
    Internet,
    Auth,
    Credits,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum OnboardingScreen {
    QrCode,
    Instruction,
    Pin,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonGestureKind {
    Tap,
    PressHold,
    ShortRelease,
    DoubleClick,
    LongAbort,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RecordingAllowance {
    Allowed,
    DeniedBatteryCritical,
    DeniedOtaInProgress,
    DeniedConcurrentLock,
    DeniedQuarantined,
    DeniedPeerUnavailable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BusyState {
    Idle,
    Recording,
    Transcribing,
    OtaInProgress,
    Quarantined,
    LockedByOtherDevice,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProvisioningStage {
    WifiAuth,
    WifiAssoc,
    EnterpriseAuth,
    DhcpTimeout,
    DnsLookup,
    GatewayUnreachable,
    MdnsTimeout,
    WsHandshakeFail,
    TokenRejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
}

// ============================================================================
// 路由方向 — directionOf 镜像
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    DeviceToDesktop,
    DesktopToDevice,
    Bidirectional,
}

// ============================================================================
// MsgKind — wire tag 强类型映射；wire 表示用 snake_case 字符串作 tag
// ============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MsgKind {
    // handshake
    Hello,
    HelloAck,
    ProtocolIncompatible,
    Quarantined,
    QuarantineLifted,
    // pairing / provisioning（数字比对方案：challenge + confirm + result）
    PairingChallenge,
    PairingConfirm,
    PairingResult,
    PairingThrottled,
    Provision,
    ProvisionAck,
    ProvisioningFailed,
    Unbind,
    // session
    SessionClaim,
    SessionYielded,
    LockDenied,
    // recording
    StartRecordRequestPrompt,
    RecordingState,
    AudioChunkMeta,
    AudioChunkAck,
    StopRecord,
    AbortRecord,
    CancelLastSession,
    AudioLevel,
    BusyRejectedKey,
    // transcript
    TextResult,
    AsrProgress,
    LanguageMismatchSuggested,
    FocusTargetChanged,
    // heartbeat & channel
    Ping,
    Pong,
    ChannelStatus,
    SignalWeak,
    SignalRestored,
    PeerStatus,
    // network
    ServerEndpointUpdate,
    ServerEndpointChanged,
    NetDiag,
    MdnsFailed,
    ServerIdentityMismatch,
    // OTA
    OtaOffer,
    OtaAccept,
    OtaReject,
    OtaProgress,
    OtaResult,
    // audio resume
    AudioResumeOffer,
    AudioResumeAck,
    AudioResumeDone,
    // re-auth
    ReAuthChallenge,
    ReAuthResponse,
    OwnerMismatch,
    // telemetry
    Battery,
    Thermal,
    LowMemory,
    SelfRebootImminent,
    NvsWriteBudgetExceeded,
    WakeFromSleep,
    TelemetryTick,
    // wifi profiles
    AddWifi,
    ListWifiProfiles,
    ListWifiProfilesResult,
    RemoveWifiProfile,
    WifiProfileSwitched,
    // diag
    PullLogs,
    LogBatch,
    EnterDiag,
    LeaveDiag,
    AuthorizeDiag,
    SnapshotDiagnosticsRequest,
    SnapshotDiagnosticsResult,
    FactoryReset,
    // generic
    Error,
    Ack,
    Unknown,
}

impl MsgKind {
    // 与 sdk msgKindTag 一致
    pub fn wire_tag(self) -> &'static str {
        match self {
            MsgKind::Hello => "hello",
            MsgKind::HelloAck => "hello_ack",
            MsgKind::ProtocolIncompatible => "protocol_incompatible",
            MsgKind::Quarantined => "quarantined",
            MsgKind::QuarantineLifted => "quarantine_lifted",
            MsgKind::PairingChallenge => "pairing_challenge",
            MsgKind::PairingConfirm => "pairing_confirm",
            MsgKind::PairingResult => "pairing_result",
            MsgKind::PairingThrottled => "pairing_throttled",
            MsgKind::Provision => "provision",
            MsgKind::ProvisionAck => "provision_ack",
            MsgKind::ProvisioningFailed => "provisioning_failed",
            MsgKind::Unbind => "unbind",
            MsgKind::SessionClaim => "session_claim",
            MsgKind::SessionYielded => "session_yielded",
            MsgKind::LockDenied => "lock_denied",
            MsgKind::StartRecordRequestPrompt => "start_record_request_prompt",
            MsgKind::RecordingState => "recording_state",
            MsgKind::AudioChunkMeta => "audio_chunk_meta",
            MsgKind::AudioChunkAck => "audio_chunk_ack",
            MsgKind::StopRecord => "stop_record",
            MsgKind::AbortRecord => "abort_record",
            MsgKind::CancelLastSession => "cancel_last_session",
            MsgKind::AudioLevel => "audio_level",
            MsgKind::BusyRejectedKey => "busy_rejected_key",
            MsgKind::TextResult => "text_result",
            MsgKind::AsrProgress => "asr_progress",
            MsgKind::LanguageMismatchSuggested => "language_mismatch_suggested",
            MsgKind::FocusTargetChanged => "focus_target_changed",
            MsgKind::Ping => "ping",
            MsgKind::Pong => "pong",
            MsgKind::ChannelStatus => "channel_status",
            MsgKind::SignalWeak => "signal_weak",
            MsgKind::SignalRestored => "signal_restored",
            MsgKind::PeerStatus => "peer_status",
            MsgKind::ServerEndpointUpdate => "server_endpoint_update",
            MsgKind::ServerEndpointChanged => "server_endpoint_changed",
            MsgKind::NetDiag => "net_diag",
            MsgKind::MdnsFailed => "mdns_failed",
            MsgKind::ServerIdentityMismatch => "server_identity_mismatch",
            MsgKind::OtaOffer => "ota_offer",
            MsgKind::OtaAccept => "ota_accept",
            MsgKind::OtaReject => "ota_reject",
            MsgKind::OtaProgress => "ota_progress",
            MsgKind::OtaResult => "ota_result",
            MsgKind::AudioResumeOffer => "audio_resume_offer",
            MsgKind::AudioResumeAck => "audio_resume_ack",
            MsgKind::AudioResumeDone => "audio_resume_done",
            MsgKind::ReAuthChallenge => "re_auth_challenge",
            MsgKind::ReAuthResponse => "re_auth_response",
            MsgKind::OwnerMismatch => "owner_mismatch",
            MsgKind::Battery => "battery",
            MsgKind::Thermal => "thermal",
            MsgKind::LowMemory => "low_memory",
            MsgKind::SelfRebootImminent => "self_reboot_imminent",
            MsgKind::NvsWriteBudgetExceeded => "nvs_write_budget_exceeded",
            MsgKind::WakeFromSleep => "wake_from_sleep",
            MsgKind::TelemetryTick => "telemetry_tick",
            MsgKind::AddWifi => "add_wifi",
            MsgKind::ListWifiProfiles => "list_wifi_profiles",
            MsgKind::ListWifiProfilesResult => "list_wifi_profiles_result",
            MsgKind::RemoveWifiProfile => "remove_wifi_profile",
            MsgKind::WifiProfileSwitched => "wifi_profile_switched",
            MsgKind::PullLogs => "pull_logs",
            MsgKind::LogBatch => "log_batch",
            MsgKind::EnterDiag => "enter_diag",
            MsgKind::LeaveDiag => "leave_diag",
            MsgKind::AuthorizeDiag => "authorize_diag",
            MsgKind::SnapshotDiagnosticsRequest => "snapshot_diagnostics_request",
            MsgKind::SnapshotDiagnosticsResult => "snapshot_diagnostics_result",
            MsgKind::FactoryReset => "factory_reset",
            MsgKind::Error => "error",
            MsgKind::Ack => "ack",
            MsgKind::Unknown => "unknown",
        }
    }

    // 未知 tag 返回 Unknown，保持 minor 兼容
    pub fn from_wire_tag(tag: &str) -> MsgKind {
        match tag {
            "hello" => MsgKind::Hello,
            "hello_ack" => MsgKind::HelloAck,
            "protocol_incompatible" => MsgKind::ProtocolIncompatible,
            "quarantined" => MsgKind::Quarantined,
            "quarantine_lifted" => MsgKind::QuarantineLifted,
            "pairing_challenge" => MsgKind::PairingChallenge,
            "pairing_confirm" => MsgKind::PairingConfirm,
            "pairing_result" => MsgKind::PairingResult,
            "pairing_throttled" => MsgKind::PairingThrottled,
            "provision" => MsgKind::Provision,
            "provision_ack" => MsgKind::ProvisionAck,
            "provisioning_failed" => MsgKind::ProvisioningFailed,
            "unbind" => MsgKind::Unbind,
            "session_claim" => MsgKind::SessionClaim,
            "session_yielded" => MsgKind::SessionYielded,
            "lock_denied" => MsgKind::LockDenied,
            "start_record_request_prompt" => MsgKind::StartRecordRequestPrompt,
            "recording_state" => MsgKind::RecordingState,
            "audio_chunk_meta" => MsgKind::AudioChunkMeta,
            "audio_chunk_ack" => MsgKind::AudioChunkAck,
            "stop_record" => MsgKind::StopRecord,
            "abort_record" => MsgKind::AbortRecord,
            "cancel_last_session" => MsgKind::CancelLastSession,
            "audio_level" => MsgKind::AudioLevel,
            "busy_rejected_key" => MsgKind::BusyRejectedKey,
            "text_result" => MsgKind::TextResult,
            "asr_progress" => MsgKind::AsrProgress,
            "language_mismatch_suggested" => MsgKind::LanguageMismatchSuggested,
            "focus_target_changed" => MsgKind::FocusTargetChanged,
            "ping" => MsgKind::Ping,
            "pong" => MsgKind::Pong,
            "channel_status" => MsgKind::ChannelStatus,
            "signal_weak" => MsgKind::SignalWeak,
            "signal_restored" => MsgKind::SignalRestored,
            "peer_status" => MsgKind::PeerStatus,
            "server_endpoint_update" => MsgKind::ServerEndpointUpdate,
            "server_endpoint_changed" => MsgKind::ServerEndpointChanged,
            "net_diag" => MsgKind::NetDiag,
            "mdns_failed" => MsgKind::MdnsFailed,
            "server_identity_mismatch" => MsgKind::ServerIdentityMismatch,
            "ota_offer" => MsgKind::OtaOffer,
            "ota_accept" => MsgKind::OtaAccept,
            "ota_reject" => MsgKind::OtaReject,
            "ota_progress" => MsgKind::OtaProgress,
            "ota_result" => MsgKind::OtaResult,
            "audio_resume_offer" => MsgKind::AudioResumeOffer,
            "audio_resume_ack" => MsgKind::AudioResumeAck,
            "audio_resume_done" => MsgKind::AudioResumeDone,
            "re_auth_challenge" => MsgKind::ReAuthChallenge,
            "re_auth_response" => MsgKind::ReAuthResponse,
            "owner_mismatch" => MsgKind::OwnerMismatch,
            "battery" => MsgKind::Battery,
            "thermal" => MsgKind::Thermal,
            "low_memory" => MsgKind::LowMemory,
            "self_reboot_imminent" => MsgKind::SelfRebootImminent,
            "nvs_write_budget_exceeded" => MsgKind::NvsWriteBudgetExceeded,
            "wake_from_sleep" => MsgKind::WakeFromSleep,
            "telemetry_tick" => MsgKind::TelemetryTick,
            "add_wifi" => MsgKind::AddWifi,
            "list_wifi_profiles" => MsgKind::ListWifiProfiles,
            "list_wifi_profiles_result" => MsgKind::ListWifiProfilesResult,
            "remove_wifi_profile" => MsgKind::RemoveWifiProfile,
            "wifi_profile_switched" => MsgKind::WifiProfileSwitched,
            "pull_logs" => MsgKind::PullLogs,
            "log_batch" => MsgKind::LogBatch,
            "enter_diag" => MsgKind::EnterDiag,
            "leave_diag" => MsgKind::LeaveDiag,
            "authorize_diag" => MsgKind::AuthorizeDiag,
            "snapshot_diagnostics_request" => MsgKind::SnapshotDiagnosticsRequest,
            "snapshot_diagnostics_result" => MsgKind::SnapshotDiagnosticsResult,
            "factory_reset" => MsgKind::FactoryReset,
            "error" => MsgKind::Error,
            "ack" => MsgKind::Ack,
            _ => MsgKind::Unknown,
        }
    }

    pub fn direction(self) -> Direction {
        match self {
            MsgKind::Hello
            | MsgKind::PairingChallenge
            | MsgKind::ProvisionAck
            | MsgKind::ProvisioningFailed
            | MsgKind::SessionYielded
            | MsgKind::RecordingState
            | MsgKind::AudioChunkMeta
            | MsgKind::AudioLevel
            | MsgKind::BusyRejectedKey
            | MsgKind::CancelLastSession
            | MsgKind::Battery
            | MsgKind::Thermal
            | MsgKind::LowMemory
            | MsgKind::SelfRebootImminent
            | MsgKind::NvsWriteBudgetExceeded
            | MsgKind::WakeFromSleep
            | MsgKind::TelemetryTick
            | MsgKind::AudioResumeOffer
            | MsgKind::AudioResumeDone
            | MsgKind::ReAuthResponse
            | MsgKind::OtaAccept
            | MsgKind::OtaReject
            | MsgKind::OtaProgress
            | MsgKind::OtaResult
            | MsgKind::LogBatch
            | MsgKind::ListWifiProfilesResult
            | MsgKind::WifiProfileSwitched
            | MsgKind::NetDiag
            | MsgKind::MdnsFailed
            | MsgKind::ServerIdentityMismatch
            | MsgKind::SnapshotDiagnosticsResult => Direction::DeviceToDesktop,

            MsgKind::HelloAck
            | MsgKind::ProtocolIncompatible
            | MsgKind::PairingConfirm
            | MsgKind::PairingResult
            | MsgKind::PairingThrottled
            | MsgKind::Provision
            | MsgKind::Unbind
            | MsgKind::SessionClaim
            | MsgKind::LockDenied
            | MsgKind::StartRecordRequestPrompt
            | MsgKind::AudioChunkAck
            | MsgKind::StopRecord
            | MsgKind::AbortRecord
            | MsgKind::TextResult
            | MsgKind::LanguageMismatchSuggested
            | MsgKind::FocusTargetChanged
            | MsgKind::PeerStatus
            | MsgKind::ServerEndpointUpdate
            | MsgKind::ServerEndpointChanged
            | MsgKind::OtaOffer
            | MsgKind::AudioResumeAck
            | MsgKind::ReAuthChallenge
            | MsgKind::OwnerMismatch
            | MsgKind::AddWifi
            | MsgKind::ListWifiProfiles
            | MsgKind::RemoveWifiProfile
            | MsgKind::PullLogs
            | MsgKind::EnterDiag
            | MsgKind::LeaveDiag
            | MsgKind::AuthorizeDiag
            | MsgKind::SnapshotDiagnosticsRequest
            | MsgKind::FactoryReset => Direction::DesktopToDevice,

            _ => Direction::Bidirectional,
        }
    }
}

// ============================================================================
// Envelope — wire JSON 公共 header
// 实际 payload 字段 flatten 在同层；上层按 kind 解析 payload
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnvelopeHeader {
    pub msg_id: MessageId,
    pub ts_ms: Timestamp,
    #[serde(rename = "t")]
    pub kind: MsgKind,
}

// ============================================================================
// Payload 强类型镜像 — 与 sdk Messages.h 的 *View struct 对应
// 仅含桌面端会主动收/发的部分；其余 payload 在后续 commit 补
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloPayload {
    pub protocol_version: String,
    pub firmware_semver: String,
    pub firmware_build: String,
    pub device_id: DeviceId,
    pub token_seq: u32,
    pub bound_user_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HelloAckPayload {
    pub app_version: String,
    pub server_protocol: String,
    pub server_time_ms: u64,
    pub token_seq: u32,
    pub min_supported_firmware: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProtocolIncompatiblePayload {
    pub reason: QuarantineReason,
    pub required_app_version: String,
    pub required_firmware_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PingPayload {
    pub nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PongPayload {
    pub echo_ts_ms: Timestamp,
    pub echo_nonce: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TextResultPayload {
    pub session_id: SessionId,
    pub text: String,
    pub delivery_mode: DeliveryMode,
    pub target_app: String,
    pub language_detected: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioChunkAckPayload {
    pub session_id: SessionId,
    pub seq: u32,
}

// ============================================================================
// 装包 / 拆包 helper（骨架）— 真正的 serde flatten 实现待 wire schema 落地后补
// ============================================================================

pub fn encode_envelope_header(_header: &EnvelopeHeader) -> serde_json::Value {
    todo!("拼装 {{msg_id, ts_ms, t}} 顶层 object")
}

pub fn decode_envelope_header(_value: &serde_json::Value) -> Option<EnvelopeHeader> {
    todo!("从 JSON 顶层抽 msg_id / ts_ms / t")
}
