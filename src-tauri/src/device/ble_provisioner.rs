// BLE 配网状态机 — 桌面端 GATT Client（数字比对方案）。
//
// 状态机：
//   Idle
//     → Connecting        connect() 发起；GATT connect + discover + subscribe
//     → AwaitingChallenge 连上后等设备 notify pairing_challenge 推 6 位数字 code
//     → WaitingConfirm    code 已到，等用户在 UI 按 ✓/✗
//     → Pairing           用户按 ✓ + write pairing_confirm{accept:true}，等设备 pairing_result
//     → WaitingProvision  pairing_result.ok=true，可写 provision payload
//     → Provisioning      write provision 后等 provision_ack / provisioning_failed
//     → Provisioned       成功，**BLE 保持连接**作为 fallback；device_ip 给后续 ws:// 用
//     → ProvisionFailed   失败原因有 stage_code（0–8 见协议表）；可再次写 provision
//
//   分支：
//     - 用户按 ✗ → write pairing_confirm{accept:false} 后立即 disconnect → Idle
//     - 设备 notify pairing_result{ok:false} 兜底：disconnect → Idle
//
// 设备永不直连 internet：桌面端在 BLE 阶段写 wifi 凭据 + saas token 给设备。
// 详细 wire 协议见 /Users/zhao/Documents/01.Code/Hardward/Mic/firmware/openspeech_mic/BLE_PROVISIONING_PROTOCOL.md

use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use btleplug::api::{Central, Manager as _, Peripheral as _, ScanFilter, WriteType};
use btleplug::platform::{Manager, Peripheral};
use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::sync::Mutex;
use tokio::time::{Instant, timeout};
use uuid::Uuid;

use super::protocol::ble as ble_const;

pub const EVT_BLE_PROVISION_STATE: &str = "openspeech://ble-provision-state-changed";

// 协议第 6 节超时矩阵：
// - challenge：设备连接后立即推，10s 不到视为异常
// - pairing_confirm → pairing_result：5s 兜底
// - provision → provision_ack / provisioning_failed：WiFi 15s + NVS 5s + 缓冲 = 25s
// - GATT connect + discover_services 在 macOS 偶发慢，10s 给宽松点
const CHALLENGE_TIMEOUT: Duration = Duration::from_secs(10);
const PAIRING_TIMEOUT: Duration = Duration::from_secs(5);
const PROVISION_TIMEOUT: Duration = Duration::from_secs(25);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "stage", rename_all = "snake_case")]
pub enum ProvisionStage {
    Idle,
    Connecting {
        address: String,
        local_name: String,
    },
    /// GATT 连上 + 已订阅 PAIRING/CONTROL notify，等设备主动推 pairing_challenge
    AwaitingChallenge {
        address: String,
        local_name: String,
    },
    /// 已收到 6 位数字 code，等用户在 UI 按 ✓ 确认 / ✗ 拒绝
    WaitingConfirm {
        address: String,
        local_name: String,
        code: String,
    },
    /// 已 write pairing_confirm{accept:true}，等设备 notify pairing_result
    Pairing {
        address: String,
        local_name: String,
    },
    /// pairing_result.ok=true，可写 provision payload
    WaitingProvision {
        address: String,
        local_name: String,
    },
    /// provision payload 已写，等设备 notify
    Provisioning {
        address: String,
        local_name: String,
    },
    /// provisioning_failed，按 stage_code 查表给前端显示原因。设备退回 AdvertisingForPair，
    /// 桌面侧 GATT 已断，无法直接再写 provision（按协议 §9：需重扫重连）。
    ProvisionFailed {
        address: String,
        local_name: String,
        stage_code: u8,
        detail: String,
    },
    /// 完成。device_ip 是设备配网后拿到的 LAN IP，后续 ws:// 连接用。
    Provisioned {
        address: String,
        local_name: String,
        device_ip: String,
    },
}

// 顶层状态：当前 stage + last_error（最近一次错误简描，方便前端做横幅）
#[derive(Debug, Clone, Serialize)]
pub struct ProvisionState {
    pub stage: ProvisionStage,
    pub last_error: Option<String>,
}

impl Default for ProvisionState {
    fn default() -> Self {
        Self {
            stage: ProvisionStage::Idle,
            last_error: None,
        }
    }
}

// 设备 → 桌面的 notify payload；按 t 分发
#[derive(Debug, Deserialize)]
#[serde(tag = "t", rename_all = "snake_case")]
enum IncomingNotify {
    PairingChallenge {
        code: String,
    },
    PairingResult {
        ok: bool,
    },
    ProvisionAck {
        ok: bool,
        #[serde(default)]
        device_ip: String,
    },
    ProvisioningFailed {
        stage: u8,
        #[serde(default)]
        detail: String,
    },
    // 其它消息（recording_state / channel_status 等）配网阶段不关心，吞掉。
    #[serde(other)]
    Other,
}

pub struct BleProvisioner {
    app: AppHandle,
    inner: Mutex<Inner>,
}

struct Inner {
    state: ProvisionState,
    peripheral: Option<Peripheral>,
    notify_task: Option<JoinHandle<()>>,
}

impl BleProvisioner {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Mutex::new(Inner {
                state: ProvisionState::default(),
                peripheral: None,
                notify_task: None,
            }),
        }
    }

    pub async fn state(&self) -> ProvisionState {
        self.inner.lock().await.state.clone()
    }

    /// 扫描列表选中一台设备 → GATT connect + discover + subscribe。
    /// 成功后切到 AwaitingChallenge，等设备主动推 pairing_challenge。
    pub async fn connect(self: &Arc<Self>, address: String) -> Result<(), String> {
        self.cleanup_existing().await;

        let local_name = address.clone();
        self.set_stage(
            ProvisionStage::Connecting {
                address: address.clone(),
                local_name: local_name.clone(),
            },
            None,
        )
        .await;

        let peripheral = match find_peripheral(&address).await {
            Ok(p) => p,
            Err(e) => {
                self.fail_to_idle(format!("locate peripheral failed: {e}")).await;
                return Err(e);
            }
        };

        let connect_result = timeout(CONNECT_TIMEOUT, async {
            peripheral.connect().await?;
            peripheral.discover_services().await?;
            Result::<(), btleplug::Error>::Ok(())
        })
        .await;
        match connect_result {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                self.fail_to_idle(format!("connect failed: {e}")).await;
                return Err(format!("connect failed: {e}"));
            }
            Err(_) => {
                self.fail_to_idle("connect timeout".into()).await;
                return Err("connect timeout".into());
            }
        }

        let real_name = peripheral
            .properties()
            .await
            .ok()
            .flatten()
            .and_then(|p| p.local_name)
            .unwrap_or_else(|| address.clone());

        // 订阅 PAIRING + CONTROL notify
        let chars = peripheral.characteristics();
        let pairing_uuid = Uuid::from_str(ble_const::CHAR_PAIRING_UUID)
            .map_err(|e| format!("bad CHAR_PAIRING_UUID const: {e}"))?;
        let control_uuid = Uuid::from_str(ble_const::CHAR_CONTROL_UUID)
            .map_err(|e| format!("bad CHAR_CONTROL_UUID const: {e}"))?;

        let pairing_char = chars
            .iter()
            .find(|c| c.uuid == pairing_uuid)
            .cloned()
            .ok_or_else(|| "PAIRING characteristic missing".to_string());
        let control_char = chars
            .iter()
            .find(|c| c.uuid == control_uuid)
            .cloned()
            .ok_or_else(|| "CONTROL characteristic missing".to_string());

        let pairing_char = match pairing_char {
            Ok(c) => c,
            Err(e) => {
                let _ = peripheral.disconnect().await;
                self.fail_to_idle(e.clone()).await;
                return Err(e);
            }
        };
        let control_char = match control_char {
            Ok(c) => c,
            Err(e) => {
                let _ = peripheral.disconnect().await;
                self.fail_to_idle(e.clone()).await;
                return Err(e);
            }
        };

        if let Err(e) = peripheral.subscribe(&pairing_char).await {
            let _ = peripheral.disconnect().await;
            self.fail_to_idle(format!("subscribe PAIRING failed: {e}"))
                .await;
            return Err(format!("subscribe PAIRING failed: {e}"));
        }
        if let Err(e) = peripheral.subscribe(&control_char).await {
            let _ = peripheral.disconnect().await;
            self.fail_to_idle(format!("subscribe CONTROL failed: {e}"))
                .await;
            return Err(format!("subscribe CONTROL failed: {e}"));
        }

        // 起 notify 消费 task
        let me = Arc::clone(self);
        let pp = peripheral.clone();
        let task = tauri::async_runtime::spawn(async move {
            match pp.notifications().await {
                Ok(mut stream) => {
                    while let Some(n) = stream.next().await {
                        me.handle_notify(&n.value).await;
                    }
                    log::info!("[ble-prov] notification stream ended");
                }
                Err(e) => {
                    log::warn!("[ble-prov] notifications() failed: {e}");
                    me.fail_to_idle(format!("notifications failed: {e}")).await;
                }
            }
        });

        // 切到 AwaitingChallenge + 起 challenge watchdog
        let mut inner = self.inner.lock().await;
        inner.peripheral = Some(peripheral);
        inner.notify_task = Some(task);
        inner.state.stage = ProvisionStage::AwaitingChallenge {
            address: address.clone(),
            local_name: real_name.clone(),
        };
        inner.state.last_error = None;
        let snap = inner.state.clone();
        drop(inner);
        let _ = self.app.emit(EVT_BLE_PROVISION_STATE, &snap);
        log::info!(
            "[ble-prov] connected, awaiting pairing_challenge: addr={address} name={real_name}"
        );

        self.spawn_challenge_watchdog().await;
        Ok(())
    }

    /// 用户在 UI 按"确认/拒绝"后调用：写 pairing_confirm{accept}。
    /// accept=false 时写完立即 disconnect 回 Idle（设备会回 AdvertisingForPair 自愈）。
    pub async fn send_pairing_confirm(self: &Arc<Self>, accept: bool) -> Result<(), String> {
        let (peripheral, addr, name) = {
            let inner = self.inner.lock().await;
            let peripheral = inner
                .peripheral
                .clone()
                .ok_or_else(|| "not connected".to_string())?;
            let (addr, name) = match &inner.state.stage {
                ProvisionStage::WaitingConfirm {
                    address,
                    local_name,
                    ..
                } => (address.clone(), local_name.clone()),
                _ => return Err("not in waiting-confirm stage".into()),
            };
            (peripheral, addr, name)
        };

        // accept=true → 切 Pairing 态等 result；accept=false → 维持当前态，写完即 disconnect
        if accept {
            self.set_stage(
                ProvisionStage::Pairing {
                    address: addr.clone(),
                    local_name: name.clone(),
                },
                None,
            )
            .await;
        }

        let pairing_uuid = Uuid::from_str(ble_const::CHAR_PAIRING_UUID)
            .map_err(|e| format!("bad CHAR_PAIRING_UUID const: {e}"))?;
        let pairing_char = peripheral
            .characteristics()
            .iter()
            .find(|c| c.uuid == pairing_uuid)
            .cloned()
            .ok_or_else(|| "PAIRING characteristic missing".to_string())?;

        let body = serde_json::json!({
            "msg_id": Uuid::new_v4().to_string(),
            "ts_ms": now_ms(),
            "t": "pairing_confirm",
            "accept": accept,
        });
        let bytes = serde_json::to_vec(&body).map_err(|e| format!("encode confirm failed: {e}"))?;

        let watchdog = if accept {
            Some(self.spawn_pairing_watchdog().await)
        } else {
            None
        };

        let write_result = peripheral
            .write(&pairing_char, &bytes, WriteType::WithResponse)
            .await;
        if let Err(e) = write_result {
            if let Some(w) = watchdog {
                w.abort();
            }
            if accept {
                // 写失败：退回 WaitingConfirm（code 已没了，索性回 Idle）
                self.fail_to_idle(format!("write pairing_confirm failed: {e}"))
                    .await;
            } else {
                self.fail_to_idle(format!("write pairing_confirm(reject) failed: {e}"))
                    .await;
            }
            return Err(format!("write pairing_confirm failed: {e}"));
        }

        if !accept {
            log::info!("[ble-prov] user rejected pairing, disconnecting");
            self.cleanup_existing().await;
            self.set_stage(ProvisionStage::Idle, None).await;
        }
        let _ = (addr, name); // 仅消除 lint
        Ok(())
    }

    /// 用户输入 SSID/PSK 后调用：写 PROVISION char + saas 凭据。
    #[allow(clippy::too_many_arguments)]
    pub async fn send_provision(
        self: &Arc<Self>,
        ssid: String,
        psk: String,
        token: String,
        bound_user_id: String,
        server_host: String,
        server_port: u16,
    ) -> Result<(), String> {
        let (peripheral, addr, name) = {
            let inner = self.inner.lock().await;
            let peripheral = inner
                .peripheral
                .clone()
                .ok_or_else(|| "not connected".to_string())?;
            let (addr, name) = match &inner.state.stage {
                // ProvisionFailed 在协议 §9 下设备已退 AdvertisingForPair，桌面侧 BLE 也会断；
                // 这里只接受 WaitingProvision —— 失败重试由用户重扫触发。
                ProvisionStage::WaitingProvision {
                    address,
                    local_name,
                } => (address.clone(), local_name.clone()),
                _ => return Err("not in waiting-provision stage".into()),
            };
            (peripheral, addr, name)
        };

        self.set_stage(
            ProvisionStage::Provisioning {
                address: addr.clone(),
                local_name: name.clone(),
            },
            None,
        )
        .await;

        let provision_uuid = Uuid::from_str(ble_const::CHAR_PROVISION_UUID)
            .map_err(|e| format!("bad CHAR_PROVISION_UUID const: {e}"))?;
        let provision_char = peripheral
            .characteristics()
            .iter()
            .find(|c| c.uuid == provision_uuid)
            .cloned()
            .ok_or_else(|| "PROVISION characteristic missing".to_string())?;

        let body = serde_json::json!({
            "msg_id": Uuid::new_v4().to_string(),
            "ts_ms": now_ms(),
            "t": "provision",
            "ssid": ssid,
            "psk": psk,
            "token": token,
            "bound_user_id": bound_user_id,
            "server_host": server_host,
            "server_port": server_port,
        });
        let bytes =
            serde_json::to_vec(&body).map_err(|e| format!("encode provision failed: {e}"))?;

        let watchdog = self.spawn_provision_watchdog().await;

        let write_result = peripheral
            .write(&provision_char, &bytes, WriteType::WithResponse)
            .await;
        if let Err(e) = write_result {
            watchdog.abort();
            self.set_stage(
                ProvisionStage::WaitingProvision {
                    address: addr,
                    local_name: name,
                },
                Some(format!("write provision failed: {e}")),
            )
            .await;
            return Err(format!("write provision failed: {e}"));
        }
        Ok(())
    }

    /// 用户主动取消 / 关闭面板：断 BLE，回 Idle。设备会自动重新广告。
    pub async fn disconnect(self: &Arc<Self>) -> Result<(), String> {
        self.cleanup_existing().await;
        self.set_stage(ProvisionStage::Idle, None).await;
        Ok(())
    }

    // ───────── 内部 ─────────

    async fn handle_notify(self: &Arc<Self>, raw: &[u8]) {
        let parsed: Result<IncomingNotify, _> = serde_json::from_slice(raw);
        let msg = match parsed {
            Ok(m) => m,
            Err(e) => {
                log::trace!(
                    "[ble-prov] non-json notify ({e}): {:?}",
                    String::from_utf8_lossy(raw)
                );
                return;
            }
        };

        let (addr, name) = {
            let inner = self.inner.lock().await;
            match &inner.state.stage {
                ProvisionStage::AwaitingChallenge { address, local_name }
                | ProvisionStage::WaitingConfirm { address, local_name, .. }
                | ProvisionStage::Pairing { address, local_name }
                | ProvisionStage::WaitingProvision { address, local_name }
                | ProvisionStage::Provisioning { address, local_name }
                | ProvisionStage::ProvisionFailed { address, local_name, .. } => {
                    (address.clone(), local_name.clone())
                }
                _ => {
                    // Idle / Connecting / Provisioned 都不期望收到 notify，丢
                    return;
                }
            }
        };

        match msg {
            IncomingNotify::PairingChallenge { code } => {
                log::info!("[ble-prov] pairing_challenge code={code}");
                self.set_stage(
                    ProvisionStage::WaitingConfirm {
                        address: addr,
                        local_name: name,
                        code,
                    },
                    None,
                )
                .await;
            }
            IncomingNotify::PairingResult { ok: true } => {
                log::info!("[ble-prov] pairing_result ok=true");
                self.set_stage(
                    ProvisionStage::WaitingProvision {
                        address: addr,
                        local_name: name,
                    },
                    None,
                )
                .await;
            }
            IncomingNotify::PairingResult { ok: false } => {
                // 协议 §9：设备退回 AdvertisingForPair；桌面侧已断（accept=false 时即时断），
                // 但也可能是设备主动 reject。统一回 Idle + 错误描述。
                log::warn!("[ble-prov] pairing_result ok=false");
                self.cleanup_existing().await;
                self.fail_to_idle("已取消配对".into()).await;
            }
            IncomingNotify::ProvisionAck { ok: true, device_ip } => {
                log::info!(
                    "[ble-prov] provision_ack ok=true device_ip={device_ip}, keeping BLE alive"
                );
                self.set_stage(
                    ProvisionStage::Provisioned {
                        address: addr,
                        local_name: name,
                        device_ip,
                    },
                    None,
                )
                .await;
                // 协议第 5.5 节 SHOULD 是 disconnect，这里产品决策覆盖：保留 BLE 连接当
                // fallback 控制通道，给后续 ws 掉线时无缝接管。BLE 在用户解绑 / 主动取消 /
                // 设备 reboot 时自然断开。
            }
            IncomingNotify::ProvisionAck { ok: false, .. } => {
                // 当前协议规定失败走 provisioning_failed；保留兜底
                self.set_stage(
                    ProvisionStage::ProvisionFailed {
                        address: addr,
                        local_name: name,
                        stage_code: 255,
                        detail: "provision_ack ok=false".into(),
                    },
                    None,
                )
                .await;
            }
            IncomingNotify::ProvisioningFailed { stage, detail } => {
                log::warn!("[ble-prov] provisioning_failed stage={stage} detail={detail}");
                self.set_stage(
                    ProvisionStage::ProvisionFailed {
                        address: addr,
                        local_name: name,
                        stage_code: stage,
                        detail,
                    },
                    None,
                )
                .await;
            }
            IncomingNotify::Other => {}
        }
    }

    async fn set_stage(&self, stage: ProvisionStage, last_error: Option<String>) {
        let mut inner = self.inner.lock().await;
        inner.state.stage = stage;
        if last_error.is_some() {
            inner.state.last_error = last_error;
        }
        let snap = inner.state.clone();
        drop(inner);
        let _ = self.app.emit(EVT_BLE_PROVISION_STATE, &snap);
    }

    async fn fail_to_idle(&self, msg: String) {
        log::warn!("[ble-prov] {msg}");
        let mut inner = self.inner.lock().await;
        inner.state.stage = ProvisionStage::Idle;
        inner.state.last_error = Some(msg);
        let snap = inner.state.clone();
        drop(inner);
        let _ = self.app.emit(EVT_BLE_PROVISION_STATE, &snap);
    }

    async fn cleanup_existing(&self) {
        let (peripheral, task) = {
            let mut inner = self.inner.lock().await;
            (inner.peripheral.take(), inner.notify_task.take())
        };
        if let Some(p) = peripheral {
            if let Err(e) = p.disconnect().await {
                log::debug!("[ble-prov] disconnect tail error: {e}");
            }
        }
        if let Some(t) = task {
            t.abort();
        }
    }

    /// 连上后 10s 内必须收到 pairing_challenge；超时回 Idle 让用户重扫。
    async fn spawn_challenge_watchdog(self: &Arc<Self>) -> JoinHandle<()> {
        let me = Arc::clone(self);
        let deadline = Instant::now() + CHALLENGE_TIMEOUT;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let still_awaiting = {
                let inner = me.inner.lock().await;
                matches!(inner.state.stage, ProvisionStage::AwaitingChallenge { .. })
            };
            if still_awaiting {
                log::warn!("[ble-prov] challenge watchdog fired, no pairing_challenge received");
                me.cleanup_existing().await;
                me.fail_to_idle("设备未在 10 秒内推送配对码".into()).await;
            }
        })
    }

    /// pairing_confirm{accept:true} 写出后等 pairing_result；超时回 Idle。
    async fn spawn_pairing_watchdog(self: &Arc<Self>) -> JoinHandle<()> {
        let me = Arc::clone(self);
        let deadline = Instant::now() + PAIRING_TIMEOUT;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let need_revert = {
                let inner = me.inner.lock().await;
                matches!(inner.state.stage, ProvisionStage::Pairing { .. })
            };
            if need_revert {
                log::warn!("[ble-prov] pairing watchdog fired");
                me.cleanup_existing().await;
                me.fail_to_idle("配对超时，请重试".into()).await;
            }
        })
    }

    async fn spawn_provision_watchdog(self: &Arc<Self>) -> JoinHandle<()> {
        let me = Arc::clone(self);
        let deadline = Instant::now() + PROVISION_TIMEOUT;
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep_until(deadline).await;
            let need_revert = {
                let inner = me.inner.lock().await;
                matches!(inner.state.stage, ProvisionStage::Provisioning { .. })
            };
            if need_revert {
                log::warn!("[ble-prov] provision watchdog fired, revert to WaitingProvision");
                let (addr, name) = {
                    let inner = me.inner.lock().await;
                    match &inner.state.stage {
                        ProvisionStage::Provisioning { address, local_name } => {
                            (address.clone(), local_name.clone())
                        }
                        _ => return,
                    }
                };
                me.set_stage(
                    ProvisionStage::WaitingProvision {
                        address: addr,
                        local_name: name,
                    },
                    Some("provision timeout, please retry".into()),
                )
                .await;
            }
        })
    }
}

async fn find_peripheral(address: &str) -> Result<Peripheral, String> {
    let manager = Manager::new()
        .await
        .map_err(|e| format!("manager init failed: {e}"))?;
    let adapter = manager
        .adapters()
        .await
        .map_err(|e| format!("list adapters failed: {e}"))?
        .into_iter()
        .next()
        .ok_or_else(|| "no BLE adapter found".to_string())?;

    // 已扫到的 peripheral 列表里找 address。BleScanner 已在跑扫描；这里不重新 start_scan。
    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|e| format!("peripherals() failed: {e}"))?;
    for p in peripherals {
        if p.address().to_string().eq_ignore_ascii_case(address) {
            return Ok(p);
        }
    }

    // 列表里没找到 → 临时 start_scan 触发系统填充 peripheral 表
    let service_uuid = Uuid::from_str(ble_const::SERVICE_UUID)
        .map_err(|e| format!("bad SERVICE_UUID const: {e}"))?;
    let _ = adapter.start_scan(ScanFilter::default()).await;
    tokio::time::sleep(Duration::from_millis(1500)).await;
    let _ = adapter.stop_scan().await;

    let peripherals = adapter
        .peripherals()
        .await
        .map_err(|e| format!("peripherals() failed: {e}"))?;
    for p in peripherals {
        if p.address().to_string().eq_ignore_ascii_case(address) {
            return Ok(p);
        }
    }

    Err(format!(
        "peripheral {address} not found (service={service_uuid})"
    ))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
