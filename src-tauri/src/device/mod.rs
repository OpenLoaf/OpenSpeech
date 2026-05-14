// 无线麦克风设备模块 — ESP32 客户端连入桌面端 WS server。
// P0 范围：mDNS 广告、明文 ws、hello/hello_ack、ping/pong、audio_chunk 落盘、
// 手工 text_result 下发。BLE / SPAKE2 / AEAD / TLS / OTA / Quarantine / SQLite 后续补。

#![allow(dead_code)]

pub mod ble_provisioner;
pub mod ble_scanner;
pub mod commands;
pub mod concurrent_lock;
pub mod error_codes;
pub mod event;
pub mod handshake;
pub mod heartbeat;
pub mod hub;
pub mod injection;
pub mod ota_pusher;
pub mod protocol;
pub mod registry;
pub mod version_guard;
pub mod wifi_mac;
pub mod ws_server;

use std::sync::Arc;

use tauri::{AppHandle, Manager};

pub use ble_provisioner::BleProvisioner;
pub use ble_scanner::BleScanner;
pub use hub::DeviceHub;

// setup 阶段调用一次：注册 state、spawn server。失败仅 warn 不阻塞启动。
pub fn install(app: &AppHandle) {
    let hub = Arc::new(DeviceHub::new(app.clone()));
    app.manage(hub.clone());

    let scanner = Arc::new(BleScanner::new(app.clone()));
    app.manage(scanner.clone());

    let provisioner = Arc::new(BleProvisioner::new(app.clone()));
    app.manage(provisioner.clone());

    let app_for_task = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(e) = start_server(app_for_task).await {
            log::warn!("[device] server start failed: {e:?}");
        }
    });
}

// 启动 listener + mDNS；当 hub.start() 已运行则幂等。
pub async fn start_server(app: AppHandle) -> anyhow::Result<()> {
    let hub = app
        .try_state::<Arc<DeviceHub>>()
        .ok_or_else(|| anyhow::anyhow!("DeviceHub state missing"))?;
    hub.start().await
}
