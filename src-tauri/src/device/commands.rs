// Tauri 入口命令——契约见 device/CONTRACT.md。

use std::sync::Arc;

use serde::Deserialize;
use tauri::State;

use super::ble_provisioner::{BleProvisioner, ProvisionState};
use super::ble_scanner::{BleScanState, BleScanner, DiscoveredBleDevice};
use super::hub::{DeviceHub, DeviceRecordView, ServerStatus};
use super::wifi_mac::{self, CurrentWifi};

type HubState<'r> = State<'r, Arc<DeviceHub>>;
type ScannerState<'r> = State<'r, Arc<BleScanner>>;
type ProvisionerState<'r> = State<'r, Arc<BleProvisioner>>;

#[tauri::command]
pub async fn device_server_status(hub: HubState<'_>) -> Result<ServerStatus, String> {
    Ok(hub.status().await)
}

#[tauri::command]
pub async fn device_server_start(hub: HubState<'_>) -> Result<(), String> {
    hub.inner().clone().start().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_server_stop(hub: HubState<'_>) -> Result<(), String> {
    hub.inner().clone().stop().await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn device_list(hub: HubState<'_>) -> Result<Vec<DeviceRecordView>, String> {
    Ok(hub.list_devices().await)
}

#[tauri::command]
pub async fn device_get(
    hub: HubState<'_>,
    device_id: String,
) -> Result<Option<DeviceRecordView>, String> {
    Ok(hub.get_device(&device_id).await)
}

#[tauri::command]
pub async fn device_remove(
    hub: HubState<'_>,
    provisioner: ProvisionerState<'_>,
    device_id: String,
) -> Result<(), String> {
    hub.inner().clone().remove_device(&device_id).await;
    // 单设备策略下"移除" = 解绑：把保活的 BLE fallback 通道一起断，状态归 Idle，
    // 避免 device record 已删但 provisioner 还停在 Provisioned 引用旧 peripheral。
    let _ = provisioner.inner().clone().disconnect().await;
    Ok(())
}

#[tauri::command]
pub async fn device_clear_all(hub: HubState<'_>) -> Result<(), String> {
    hub.inner().clone().clear_all().await;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SetActiveArgs {
    pub device_id: String,
}

#[tauri::command]
pub async fn device_set_active(
    hub: HubState<'_>,
    args: SetActiveArgs,
) -> Result<(), String> {
    hub.inner().clone().set_active(&args.device_id).await
}

#[derive(Debug, Deserialize)]
pub struct RenameArgs {
    pub device_id: String,
    pub label: String,
}

#[tauri::command]
pub async fn device_rename(hub: HubState<'_>, args: RenameArgs) -> Result<(), String> {
    hub.rename(&args.device_id, &args.label).await
}

#[derive(Debug, Deserialize)]
pub struct SendTextArgs {
    pub device_id: String,
    pub text: String,
    #[serde(default)]
    pub target_app: Option<String>,
}

#[tauri::command]
pub async fn device_send_text(hub: HubState<'_>, args: SendTextArgs) -> Result<(), String> {
    hub.send_text(&args.device_id, &args.text, args.target_app.as_deref())
        .await
}

#[derive(Debug, Deserialize)]
pub struct PushOtaArgs {
    pub device_id: String,
    pub file_path: String,
    pub target_version: String,
}

#[tauri::command]
pub async fn device_push_ota(hub: HubState<'_>, args: PushOtaArgs) -> Result<String, String> {
    log::info!("[device] push_ota stub file={} target={}", args.file_path, args.target_version);
    hub.inner()
        .clone()
        .push_ota_stub(args.device_id, args.target_version)
        .await
}

#[tauri::command]
pub async fn device_ble_scan_start(scanner: ScannerState<'_>) -> Result<(), String> {
    scanner.inner().clone().start().await
}

#[tauri::command]
pub async fn device_ble_scan_stop(scanner: ScannerState<'_>) -> Result<(), String> {
    scanner.inner().clone().stop().await
}

#[tauri::command]
pub async fn device_ble_scan_state(scanner: ScannerState<'_>) -> Result<BleScanState, String> {
    Ok(scanner.state().await)
}

#[tauri::command]
pub async fn device_ble_discovered_list(
    scanner: ScannerState<'_>,
) -> Result<Vec<DiscoveredBleDevice>, String> {
    Ok(scanner.list().await)
}

#[tauri::command]
pub async fn device_ble_discovered_clear(scanner: ScannerState<'_>) -> Result<(), String> {
    scanner.clear().await;
    Ok(())
}

// ──────── BLE 配网 ────────

#[derive(Debug, Deserialize)]
pub struct BleConnectArgs {
    pub address: String,
}

#[tauri::command]
pub async fn device_ble_connect(
    provisioner: ProvisionerState<'_>,
    args: BleConnectArgs,
) -> Result<(), String> {
    // 多设备策略：注册数量无上限，但 hub 内同一时刻仅 1 个 is_active。
    provisioner.inner().clone().connect(args.address).await
}

#[derive(Debug, Deserialize)]
pub struct BlePairingConfirmArgs {
    pub accept: bool,
}

#[tauri::command]
pub async fn device_ble_pairing_confirm(
    provisioner: ProvisionerState<'_>,
    args: BlePairingConfirmArgs,
) -> Result<(), String> {
    provisioner
        .inner()
        .clone()
        .send_pairing_confirm(args.accept)
        .await
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BleSendProvisionArgs {
    pub ssid: String,
    pub psk: String,
    pub token: String,
    pub bound_user_id: String,
    pub server_host: String,
    pub server_port: u16,
}

#[tauri::command]
pub async fn device_ble_send_provision(
    provisioner: ProvisionerState<'_>,
    args: BleSendProvisionArgs,
) -> Result<(), String> {
    provisioner
        .inner()
        .clone()
        .send_provision(
            args.ssid,
            args.psk,
            args.token,
            args.bound_user_id,
            args.server_host,
            args.server_port,
        )
        .await
}

#[tauri::command]
pub async fn device_ble_provision_disconnect(
    provisioner: ProvisionerState<'_>,
) -> Result<(), String> {
    provisioner.inner().clone().disconnect().await
}

#[tauri::command]
pub async fn device_ble_provision_state(
    provisioner: ProvisionerState<'_>,
) -> Result<ProvisionState, String> {
    Ok(provisioner.state().await)
}

// ──────── macOS WiFi 自填充 ────────
//
// 三个 command 都在非 macOS 平台返回 Err；前端按平台决定是否显示"使用当前 WiFi"按钮。

#[tauri::command]
pub async fn device_wifi_current() -> Result<CurrentWifi, String> {
    wifi_mac::current_wifi()
}

#[tauri::command]
pub async fn device_wifi_list_preferred() -> Result<Vec<String>, String> {
    wifi_mac::preferred_ssids()
}

#[derive(Debug, Deserialize)]
pub struct WifiPasswordArgs {
    pub ssid: String,
}

/// 从 Keychain 取密码 — **会弹系统授权对话框**，需用户允许或 Touch ID。
/// 失败（拒绝/不存在）都走 Err，前端只提示"已跳过自动填充"即可。
#[tauri::command]
pub async fn device_wifi_password(args: WifiPasswordArgs) -> Result<String, String> {
    wifi_mac::keychain_password(&args.ssid)
}

