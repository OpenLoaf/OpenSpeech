// 双通道独立心跳骨架 — BLE 与 WiFi 各自跑 ping/pong、RTT、去抖
// 默认值来自 protocol::heartbeat_defaults

use std::time::Instant;

use super::protocol::{ChannelType, heartbeat_defaults};

#[derive(Debug, Clone)]
pub struct ChannelHeartbeat {
    pub channel: ChannelType,
    pub interval_ms: u32,
    pub stale_timeout_ms: u32,
    pub last_pong_at: Option<Instant>,
    pub last_rtt_ms: Option<u16>,
    // 滑窗内 flap 次数，用于 flap_alert_per_minute 触发
    pub flap_count: u8,
}

impl ChannelHeartbeat {
    pub fn new_ble() -> Self {
        Self {
            channel: ChannelType::Ble,
            interval_ms: heartbeat_defaults::BLE_INTERVAL_MS,
            stale_timeout_ms: heartbeat_defaults::STALE_TIMEOUT_MS,
            last_pong_at: None,
            last_rtt_ms: None,
            flap_count: 0,
        }
    }

    pub fn new_wifi() -> Self {
        Self {
            channel: ChannelType::Wifi,
            interval_ms: heartbeat_defaults::WIFI_INTERVAL_MS,
            stale_timeout_ms: heartbeat_defaults::STALE_TIMEOUT_MS,
            last_pong_at: None,
            last_rtt_ms: None,
            flap_count: 0,
        }
    }

    // 触发新 ping；返回 nonce 给 ws/ble 层发送
    pub fn issue_ping(&mut self) -> PingTicket {
        todo!("生成 nonce + 记录 sent_at；超过 stale_timeout_ms 没回则触发 lost 事件")
    }

    // 收到 pong：算 RTT、刷新 last_pong_at、可能触发 signal_restored
    pub fn on_pong(&mut self, _echo_nonce: &str, _sent_at: Instant) {
        todo!("RTT = now - sent_at；超过 SIGNAL_WEAK_RTT_MS 触发 signal_weak")
    }

    // 定时检测：lost / weak / restored 三态切换（带去抖）
    pub fn tick(&mut self, _now: Instant) -> Option<HeartbeatEvent> {
        todo!("FLAP_DEBOUNCE_MS 内的连续 lost/restored 切换不上抛")
    }
}

#[derive(Debug, Clone)]
pub struct PingTicket {
    pub nonce: String,
    pub sent_at: Instant,
}

#[derive(Debug, Clone)]
pub enum HeartbeatEvent {
    Lost { channel: ChannelType, last_seen_ms_ago: u32 },
    Restored { channel: ChannelType },
    SignalWeak { channel: ChannelType, rtt_ms: u16 },
    SignalRestored { channel: ChannelType },
    Unstable { channel: ChannelType, flap_count: u8, window_ms: u32 },
}
