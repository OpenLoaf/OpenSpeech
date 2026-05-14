// BLE 中央角色——扫描周围广播 OpenSpeech service UUID 的 ESP32 设备。
// 配对 / SPAKE2 / 配网下发不在本文件，留给 ble_provisioner.rs（P1-B）。

use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use btleplug::api::{Central, CentralEvent, Manager as _, Peripheral as _, ScanFilter};
use btleplug::platform::{Adapter, Manager};
use futures_util::StreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri::async_runtime::JoinHandle;
use tokio::sync::Mutex;
use uuid::Uuid;

use super::protocol::ble as ble_const;

pub const EVT_BLE_SCAN_STATE: &str = "openspeech://ble-scan-state-changed";
pub const EVT_BLE_DEVICE_DISCOVERED: &str = "openspeech://ble-device-discovered";

// 一台已发现但未配对的设备。配对完成后会从 discovered 集合移除，进入 DeviceHub.connections。
#[derive(Debug, Clone, Serialize)]
pub struct DiscoveredBleDevice {
    pub address: String,
    pub local_name: String,
    pub rssi_dbm: i16,
    pub last_seen_at_ms: u64,
    pub matches_openspeech: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct BleScanState {
    pub scanning: bool,
    pub adapter_present: bool,
    pub adapter_name: String,
    pub last_error: Option<String>,
    pub discovered_count: usize,
}

pub struct BleScanner {
    app: AppHandle,
    inner: Mutex<Inner>,
}

struct Inner {
    discovered: HashMap<String, DiscoveredBleDevice>,
    task: Option<JoinHandle<()>>,
    adapter_name: String,
    adapter_present: bool,
    scanning: bool,
    last_error: Option<String>,
}

impl BleScanner {
    pub fn new(app: AppHandle) -> Self {
        Self {
            app,
            inner: Mutex::new(Inner {
                discovered: HashMap::new(),
                task: None,
                adapter_name: String::new(),
                adapter_present: false,
                scanning: false,
                last_error: None,
            }),
        }
    }

    pub async fn state(&self) -> BleScanState {
        let inner = self.inner.lock().await;
        BleScanState {
            scanning: inner.scanning,
            adapter_present: inner.adapter_present,
            adapter_name: inner.adapter_name.clone(),
            last_error: inner.last_error.clone(),
            discovered_count: inner.discovered.len(),
        }
    }

    pub async fn list(&self) -> Vec<DiscoveredBleDevice> {
        let inner = self.inner.lock().await;
        let mut v: Vec<DiscoveredBleDevice> = inner.discovered.values().cloned().collect();
        v.sort_by(|a, b| b.last_seen_at_ms.cmp(&a.last_seen_at_ms));
        v
    }

    pub async fn clear(&self) {
        let mut inner = self.inner.lock().await;
        inner.discovered.clear();
        let snapshot = snapshot(&inner);
        drop(inner);
        let _ = self.app.emit(EVT_BLE_SCAN_STATE, &snapshot);
    }

    pub async fn start(self: &Arc<Self>) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.scanning {
            return Ok(());
        }

        let manager = Manager::new()
            .await
            .map_err(|e| format!("BLE manager init failed: {e}"))?;
        let adapters = manager
            .adapters()
            .await
            .map_err(|e| format!("list adapters failed: {e}"))?;
        let adapter = adapters
            .into_iter()
            .next()
            .ok_or_else(|| "no BLE adapter found".to_string())?;

        let adapter_name = adapter
            .adapter_info()
            .await
            .unwrap_or_else(|_| "unknown".to_string());

        inner.adapter_name = adapter_name;
        inner.adapter_present = true;
        inner.last_error = None;

        // 启动扫描循环
        let scanner_arc = Arc::clone(self);
        let task = tauri::async_runtime::spawn(async move {
            if let Err(e) = scanner_arc.run_scan_loop(adapter).await {
                log::warn!("[ble] scan loop exited with error: {e}");
                let mut g = scanner_arc.inner.lock().await;
                g.scanning = false;
                g.last_error = Some(e);
                let snapshot = snapshot(&g);
                drop(g);
                let _ = scanner_arc.app.emit(EVT_BLE_SCAN_STATE, &snapshot);
            }
        });
        inner.task = Some(task);
        inner.scanning = true;

        let snapshot = snapshot(&inner);
        drop(inner);
        let _ = self.app.emit(EVT_BLE_SCAN_STATE, &snapshot);
        Ok(())
    }

    pub async fn stop(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if !inner.scanning {
            return Ok(());
        }
        if let Some(task) = inner.task.take() {
            task.abort();
        }
        inner.scanning = false;
        let snapshot = snapshot(&inner);
        drop(inner);
        let _ = self.app.emit(EVT_BLE_SCAN_STATE, &snapshot);
        Ok(())
    }

    async fn run_scan_loop(self: &Arc<Self>, adapter: Adapter) -> Result<(), String> {
        let service_uuid = Uuid::from_str(ble_const::SERVICE_UUID)
            .map_err(|e| format!("bad SERVICE_UUID const: {e}"))?;

        // 关键：不传 services 白名单。macOS CoreBluetooth 在 ScanFilter.services
        // 非空时只回报 advertisement 包里显式声明该 service UUID 的设备；
        // ESP32 NimBLE 默认 adv 总长 31 字节，128-bit UUID 占 17 字节，常常只放
        // name + flags + tx power，service UUID 留在 GATT 注册表里没进 adv，
        // 设备会被 OS 直接过滤掉。改成 default 让所有 BLE 广播都到 events，
        // 然后在 on_peripheral_seen 里按 name 前缀 + advertised services 兜底匹配。
        adapter
            .start_scan(ScanFilter::default())
            .await
            .map_err(|e| format!("start_scan failed: {e}"))?;
        log::info!("[ble] scan started, service={service_uuid}, name_prefix={}", ble_const::ADV_NAME_PREFIX);

        let mut events = adapter
            .events()
            .await
            .map_err(|e| format!("subscribe events failed: {e}"))?;

        let mut sweep_ticker = tokio::time::interval(Duration::from_secs(5));
        // 立刻消费第一次 tick 避免开局立刻清扫
        sweep_ticker.tick().await;

        loop {
            tokio::select! {
                ev = events.next() => {
                    match ev {
                        Some(CentralEvent::DeviceDiscovered(id))
                        | Some(CentralEvent::DeviceUpdated(id)) => {
                            if let Ok(peripheral) = adapter.peripheral(&id).await {
                                self.on_peripheral_seen(&peripheral, service_uuid).await;
                            }
                        }
                        Some(CentralEvent::DeviceDisconnected(_id)) => {
                            // 不直接删除：让 sweep 按 TTL 清，避免抖动
                        }
                        Some(_) => {}
                        None => return Err("BLE event stream ended".to_string()),
                    }
                }
                _ = sweep_ticker.tick() => {
                    self.sweep_stale().await;
                }
            }
        }
    }

    async fn on_peripheral_seen(
        self: &Arc<Self>,
        peripheral: &btleplug::platform::Peripheral,
        target_service: Uuid,
    ) {
        let Ok(Some(props)) = peripheral.properties().await else {
            return;
        };
        let address = peripheral.address().to_string();
        let local_name = props.local_name.unwrap_or_default();
        let services_advertised = props.services;
        let rssi = props.rssi.unwrap_or(0);

        let svc_match = services_advertised.contains(&target_service);
        let name_match = local_name.starts_with(ble_const::ADV_NAME_PREFIX);
        let matches = svc_match || name_match;

        if !matches {
            // 看见但不匹配——debug 级，便于排查"为什么扫不到我的设备"：
            // 把 name + services + address + rssi 完整打出来，对照 ESP32 端
            // adv 是否声明了 OpenSpeech name 前缀或 service UUID。
            log::debug!(
                "[ble] saw non-matching peripheral addr={address} name={local_name:?} \
                 rssi={rssi} services={services_advertised:?}"
            );
            return;
        }

        let now = now_ms();
        let entry = DiscoveredBleDevice {
            address: address.clone(),
            local_name: local_name.clone(),
            rssi_dbm: rssi,
            last_seen_at_ms: now,
            matches_openspeech: true,
        };

        let mut inner = self.inner.lock().await;
        let is_new = !inner.discovered.contains_key(&address);
        inner.discovered.insert(address.clone(), entry.clone());

        if is_new {
            log::info!(
                "[ble] matched OpenSpeech device addr={address} name={local_name:?} \
                 rssi={rssi} via_svc={svc_match} via_name={name_match}"
            );
            let snapshot = snapshot(&inner);
            drop(inner);
            let _ = self.app.emit(EVT_BLE_DEVICE_DISCOVERED, &entry);
            let _ = self.app.emit(EVT_BLE_SCAN_STATE, &snapshot);
        }
    }

    async fn sweep_stale(&self) {
        let cutoff = now_ms().saturating_sub(30_000); // 30s 未刷新即移除
        let mut inner = self.inner.lock().await;
        let before = inner.discovered.len();
        inner
            .discovered
            .retain(|_, v| v.last_seen_at_ms >= cutoff);
        if inner.discovered.len() != before {
            let snapshot = snapshot(&inner);
            drop(inner);
            let _ = self.app.emit(EVT_BLE_SCAN_STATE, &snapshot);
        }
    }
}

fn snapshot(inner: &Inner) -> BleScanState {
    BleScanState {
        scanning: inner.scanning,
        adapter_present: inner.adapter_present,
        adapter_name: inner.adapter_name.clone(),
        last_error: inner.last_error.clone(),
        discovered_count: inner.discovered.len(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
