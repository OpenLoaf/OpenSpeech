// 错误码 1xxx–7xxx 镜像 — 与 sdk/src/protocol/ErrorCodes.h 一一对应
// code 是跨端稳定标识，新增 = minor 升；renumber = major 升

use serde::{Deserialize, Serialize};

use super::protocol::Locale;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(into = "u16", try_from = "u16")]
pub enum ErrorCode {
    // 1xxx 协议 Warn
    AckTimeout,
    MsgDrop,
    DupMsgId,
    NonceMismatch,
    // 2xxx 硬件 Fatal
    MicInitFail,
    NvsCorrupt,
    PsramFault,
    FlashEncDisabled,
    // 3xxx 网络
    WifiAuthFail,
    WsHandshakeFail,
    MdnsTimeout,
    DhcpTimeout,
    CertMismatch,
    // 4xxx BLE
    BleDisconnect,
    GattWriteFail,
    PairingThrottled,
    // 5xxx 业务
    SessionExpired,
    SaasTimeout,
    Saas5xx,
    NoCredits,
    AuthExpired,
    AsrEmptyTooQuiet,
    AsrEmptyNoSpeech,
    AsrLangMismatch,
    // 6xxx 版本 / OTA
    ProtocolIncompatible,
    OtaVerifyFail,
    OtaDowngradeBlocked,
    OtaBatteryLow,
    OtaInterruptedRolledBack,
    // 7xxx 安全
    PairingMitmSuspected,
    ServerIdentityMismatch,
    OwnerMismatch,
    TokenRevoked,
    // 兜底
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCategory {
    ProtocolWarn,
    HardwareFatal,
    Network,
    Ble,
    Business,
    VersionAndOta,
    Security,
}

impl ErrorCode {
    pub fn numeric(self) -> u16 {
        match self {
            ErrorCode::AckTimeout => 1001,
            ErrorCode::MsgDrop => 1002,
            ErrorCode::DupMsgId => 1003,
            ErrorCode::NonceMismatch => 1004,
            ErrorCode::MicInitFail => 2001,
            ErrorCode::NvsCorrupt => 2002,
            ErrorCode::PsramFault => 2003,
            ErrorCode::FlashEncDisabled => 2004,
            ErrorCode::WifiAuthFail => 3001,
            ErrorCode::WsHandshakeFail => 3002,
            ErrorCode::MdnsTimeout => 3003,
            ErrorCode::DhcpTimeout => 3004,
            ErrorCode::CertMismatch => 3005,
            ErrorCode::BleDisconnect => 4001,
            ErrorCode::GattWriteFail => 4002,
            ErrorCode::PairingThrottled => 4003,
            ErrorCode::SessionExpired => 5001,
            ErrorCode::SaasTimeout => 5002,
            ErrorCode::Saas5xx => 5003,
            ErrorCode::NoCredits => 5010,
            ErrorCode::AuthExpired => 5011,
            ErrorCode::AsrEmptyTooQuiet => 5020,
            ErrorCode::AsrEmptyNoSpeech => 5021,
            ErrorCode::AsrLangMismatch => 5022,
            ErrorCode::ProtocolIncompatible => 6001,
            ErrorCode::OtaVerifyFail => 6002,
            ErrorCode::OtaDowngradeBlocked => 6003,
            ErrorCode::OtaBatteryLow => 6004,
            ErrorCode::OtaInterruptedRolledBack => 6005,
            ErrorCode::PairingMitmSuspected => 7001,
            ErrorCode::ServerIdentityMismatch => 7002,
            ErrorCode::OwnerMismatch => 7003,
            ErrorCode::TokenRevoked => 7004,
            ErrorCode::Unknown => 0xFFFF,
        }
    }

    pub fn from_numeric(n: u16) -> ErrorCode {
        match n {
            1001 => ErrorCode::AckTimeout,
            1002 => ErrorCode::MsgDrop,
            1003 => ErrorCode::DupMsgId,
            1004 => ErrorCode::NonceMismatch,
            2001 => ErrorCode::MicInitFail,
            2002 => ErrorCode::NvsCorrupt,
            2003 => ErrorCode::PsramFault,
            2004 => ErrorCode::FlashEncDisabled,
            3001 => ErrorCode::WifiAuthFail,
            3002 => ErrorCode::WsHandshakeFail,
            3003 => ErrorCode::MdnsTimeout,
            3004 => ErrorCode::DhcpTimeout,
            3005 => ErrorCode::CertMismatch,
            4001 => ErrorCode::BleDisconnect,
            4002 => ErrorCode::GattWriteFail,
            4003 => ErrorCode::PairingThrottled,
            5001 => ErrorCode::SessionExpired,
            5002 => ErrorCode::SaasTimeout,
            5003 => ErrorCode::Saas5xx,
            5010 => ErrorCode::NoCredits,
            5011 => ErrorCode::AuthExpired,
            5020 => ErrorCode::AsrEmptyTooQuiet,
            5021 => ErrorCode::AsrEmptyNoSpeech,
            5022 => ErrorCode::AsrLangMismatch,
            6001 => ErrorCode::ProtocolIncompatible,
            6002 => ErrorCode::OtaVerifyFail,
            6003 => ErrorCode::OtaDowngradeBlocked,
            6004 => ErrorCode::OtaBatteryLow,
            6005 => ErrorCode::OtaInterruptedRolledBack,
            7001 => ErrorCode::PairingMitmSuspected,
            7002 => ErrorCode::ServerIdentityMismatch,
            7003 => ErrorCode::OwnerMismatch,
            7004 => ErrorCode::TokenRevoked,
            _ => ErrorCode::Unknown,
        }
    }

    pub fn category(self) -> ErrorCategory {
        let n = self.numeric();
        match n {
            1000..=1999 => ErrorCategory::ProtocolWarn,
            2000..=2999 => ErrorCategory::HardwareFatal,
            3000..=3999 => ErrorCategory::Network,
            4000..=4999 => ErrorCategory::Ble,
            5000..=5999 => ErrorCategory::Business,
            6000..=6999 => ErrorCategory::VersionAndOta,
            _ => ErrorCategory::Security,
        }
    }

    // 设备 OLED 用 E-XXXX
    pub fn screen_code(self) -> String {
        format!("E-{:04}", self.numeric())
    }

    // 一行中文标签（≤ 12 显示字符）
    pub fn screen_label_zh(self) -> &'static str {
        match self {
            ErrorCode::AckTimeout => "连接抖动",
            ErrorCode::MsgDrop => "消息丢失",
            ErrorCode::DupMsgId => "消息重复",
            ErrorCode::NonceMismatch => "握手异常",
            ErrorCode::MicInitFail => "麦克风故障",
            ErrorCode::NvsCorrupt => "配置损坏",
            ErrorCode::PsramFault => "内存故障",
            ErrorCode::FlashEncDisabled => "未加密固件",
            ErrorCode::WifiAuthFail => "WiFi 密码错",
            ErrorCode::WsHandshakeFail => "电脑被拦",
            ErrorCode::MdnsTimeout => "找不到电脑",
            ErrorCode::DhcpTimeout => "未拿到 IP",
            ErrorCode::CertMismatch => "电脑身份变",
            ErrorCode::BleDisconnect => "蓝牙断开",
            ErrorCode::GattWriteFail => "蓝牙写失败",
            ErrorCode::PairingThrottled => "请稍候重试",
            ErrorCode::SessionExpired => "会话过期",
            ErrorCode::SaasTimeout => "云端超时",
            ErrorCode::Saas5xx => "云端异常",
            ErrorCode::NoCredits => "积分不足",
            ErrorCode::AuthExpired => "登录失效",
            ErrorCode::AsrEmptyTooQuiet => "声音太轻",
            ErrorCode::AsrEmptyNoSpeech => "未识别到",
            ErrorCode::AsrLangMismatch => "语言不符",
            ErrorCode::ProtocolIncompatible => "协议不兼容",
            ErrorCode::OtaVerifyFail => "固件校验失败",
            ErrorCode::OtaDowngradeBlocked => "禁止降级",
            ErrorCode::OtaBatteryLow => "电量不足",
            ErrorCode::OtaInterruptedRolledBack => "升级中断",
            ErrorCode::PairingMitmSuspected => "配对异常",
            ErrorCode::ServerIdentityMismatch => "电脑不可信",
            ErrorCode::OwnerMismatch => "账号不符",
            ErrorCode::TokenRevoked => "凭据失效",
            ErrorCode::Unknown => "未知错误",
        }
    }

    pub fn screen_label_en(self) -> &'static str {
        match self {
            ErrorCode::AckTimeout => "ACK timeout",
            ErrorCode::MsgDrop => "Msg dropped",
            ErrorCode::DupMsgId => "Dup msg",
            ErrorCode::NonceMismatch => "Bad nonce",
            ErrorCode::MicInitFail => "Mic fail",
            ErrorCode::NvsCorrupt => "NVS corrupt",
            ErrorCode::PsramFault => "PSRAM fail",
            ErrorCode::FlashEncDisabled => "Enc disabled",
            ErrorCode::WifiAuthFail => "WiFi auth",
            ErrorCode::WsHandshakeFail => "WS blocked",
            ErrorCode::MdnsTimeout => "No host",
            ErrorCode::DhcpTimeout => "No IP",
            ErrorCode::CertMismatch => "Cert changed",
            ErrorCode::BleDisconnect => "BLE off",
            ErrorCode::GattWriteFail => "GATT fail",
            ErrorCode::PairingThrottled => "Cool down",
            ErrorCode::SessionExpired => "Sess expired",
            ErrorCode::SaasTimeout => "Cloud timeout",
            ErrorCode::Saas5xx => "Cloud 5xx",
            ErrorCode::NoCredits => "No credits",
            ErrorCode::AuthExpired => "Auth expired",
            ErrorCode::AsrEmptyTooQuiet => "Too quiet",
            ErrorCode::AsrEmptyNoSpeech => "No speech",
            ErrorCode::AsrLangMismatch => "Lang mismatch",
            ErrorCode::ProtocolIncompatible => "Proto incompat",
            ErrorCode::OtaVerifyFail => "OTA verify",
            ErrorCode::OtaDowngradeBlocked => "No downgrade",
            ErrorCode::OtaBatteryLow => "Battery low",
            ErrorCode::OtaInterruptedRolledBack => "OTA rollback",
            ErrorCode::PairingMitmSuspected => "Pair MITM",
            ErrorCode::ServerIdentityMismatch => "Host changed",
            ErrorCode::OwnerMismatch => "Owner diff",
            ErrorCode::TokenRevoked => "Token gone",
            ErrorCode::Unknown => "Unknown",
        }
    }

    pub fn screen_label(self, locale: Locale) -> &'static str {
        match locale {
            Locale::ZhCn => self.screen_label_zh(),
            // P1 阶段 JaJp 暂用英文兜底
            Locale::EnUs | Locale::JaJp => self.screen_label_en(),
        }
    }

    // 桌面端 modal 用中文长文案
    pub fn recovery_hint(self) -> &'static str {
        match self {
            ErrorCode::AckTimeout => "网络抖动，正在重试。若持续出现请重新插拔设备。",
            ErrorCode::MsgDrop => "一条消息丢失，已重传。",
            ErrorCode::DupMsgId => "收到重复消息，已自动去重。",
            ErrorCode::NonceMismatch => "心跳应答异常。可能存在中继伪造，请确认你的网络环境可信。",
            ErrorCode::MicInitFail => "麦克风初始化失败。请重启设备，仍失败请联系售后。",
            ErrorCode::NvsCorrupt => "设备配置数据损坏。需要恢复出厂：长按按键+配网键 10 秒。",
            ErrorCode::PsramFault => "设备内存自检失败。请重启；若仍提示需返修。",
            ErrorCode::FlashEncDisabled => {
                "设备未启用闪存加密。这是工程版固件，不应用于生产；请刷写发布版。"
            }
            ErrorCode::WifiAuthFail => "WiFi 密码错误，请重新配网。",
            ErrorCode::WsHandshakeFail => {
                "电脑与设备的连接被防火墙拦截。请允许 OpenSpeech 进出站。"
            }
            ErrorCode::MdnsTimeout => {
                "找不到电脑端服务。请确认 OpenSpeech 桌面 App 已启动，且与设备在同一 WiFi。"
            }
            ErrorCode::DhcpTimeout => "设备未拿到 IP 地址。请检查路由器 DHCP 是否正常。",
            ErrorCode::CertMismatch => {
                "桌面端证书与首次配对时不一致。可能换了电脑或被中间人攻击；请在桌面 App 中点击「重新信任」。"
            }
            ErrorCode::BleDisconnect => "蓝牙连接断开。请将设备靠近电脑，或在 WiFi 通道继续使用。",
            ErrorCode::GattWriteFail => "蓝牙写入失败。请重试，若反复出现请重新配对。",
            ErrorCode::PairingThrottled => "配对失败次数过多，已暂时锁定。请稍候再试。",
            ErrorCode::SessionExpired => "会话已过期，正在自动重连。",
            ErrorCode::SaasTimeout => "云端听写服务无响应。请检查网络或稍候重试。",
            ErrorCode::Saas5xx => "云端服务出现问题，请稍候再试。",
            ErrorCode::NoCredits => {
                "OpenLoaf 积分不足，无法继续识别。请在桌面 App 中充值或升级套餐。"
            }
            ErrorCode::AuthExpired => "桌面端登录已过期，请在 App 中重新登录。",
            ErrorCode::AsrEmptyTooQuiet => "没听到您说话（音量过低）。本次不扣积分。",
            ErrorCode::AsrEmptyNoSpeech => "云端未识别到语音内容。本次不扣积分。",
            ErrorCode::AsrLangMismatch => "实际语言与配置语言不一致。要切换到检测到的语言吗？",
            ErrorCode::ProtocolIncompatible => {
                "设备与桌面 App 协议不兼容。请按提示升级桌面 App 或设备固件。"
            }
            ErrorCode::OtaVerifyFail => "固件验证失败（签名 / 哈希不匹配），已回滚。",
            ErrorCode::OtaDowngradeBlocked => "拒绝降级到老版本固件（安全策略）。",
            ErrorCode::OtaBatteryLow => "电量不足 50%，请先充电再升级固件。",
            ErrorCode::OtaInterruptedRolledBack => "升级被中断，已恢复旧版固件。请保持电源后重试。",
            ErrorCode::PairingMitmSuspected => {
                "配对过程中检测到异常，可能存在中间人攻击。请远离公共 WiFi 后重试。"
            }
            ErrorCode::ServerIdentityMismatch => {
                "桌面端身份与首次配对时不一致。出于安全考虑已拒绝连接。"
            }
            ErrorCode::OwnerMismatch => {
                "设备绑定的账号与当前登录账号不一致。请使用绑定账号或先解绑设备。"
            }
            ErrorCode::TokenRevoked => "本设备的访问凭据已被撤销，需要重新配对。",
            ErrorCode::Unknown => "未知错误。",
        }
    }
}

impl From<ErrorCode> for u16 {
    fn from(code: ErrorCode) -> u16 {
        code.numeric()
    }
}

// 永不失败 — try_from 仅为了配合 serde(into / try_from)，越界 → Unknown
impl TryFrom<u16> for ErrorCode {
    type Error = std::convert::Infallible;
    fn try_from(n: u16) -> Result<Self, Self::Error> {
        Ok(ErrorCode::from_numeric(n))
    }
}
