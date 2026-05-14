// macOS WiFi 元数据封装：当前 SSID / 已知 SSID 列表 / 从 Keychain 取密码。
//
// 全部命令行调用，避免引入 CoreWLAN/Security framework binding：
// - networksetup（无权限）：detect 接口、当前 SSID、preferred 列表
// - security find-generic-password（需 Keychain 授权）：读密码 → 系统弹授权框
//
// 非 macOS 平台直接返回 Err("unsupported")，桌面端 UI 据此隐藏按钮。

#[cfg(target_os = "macos")]
use std::process::Command;

#[derive(Debug, serde::Serialize)]
pub struct CurrentWifi {
    pub ssid: String,
    pub interface: String,
}

/// 选第一个 Wi-Fi 硬件端口对应的 BSD 设备名（一般 en0；Intel + USB Wi-Fi 可能是 en1/en2）。
#[cfg(target_os = "macos")]
fn detect_wifi_iface() -> Result<String, String> {
    let output = Command::new("networksetup")
        .arg("-listallhardwareports")
        .output()
        .map_err(|e| format!("networksetup spawn failed: {e}"))?;
    if !output.status.success() {
        return Err("networksetup -listallhardwareports failed".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);

    // 段落形如：
    //   Hardware Port: Wi-Fi
    //   Device: en0
    //   Ethernet Address: ...
    let mut hit = false;
    for line in text.lines() {
        let line = line.trim();
        if hit {
            if let Some(dev) = line.strip_prefix("Device:") {
                return Ok(dev.trim().to_string());
            }
        }
        if line == "Hardware Port: Wi-Fi" {
            hit = true;
        }
    }
    Err("no Wi-Fi hardware port".into())
}

#[cfg(target_os = "macos")]
pub fn current_wifi() -> Result<CurrentWifi, String> {
    let iface = detect_wifi_iface()?;
    let output = Command::new("networksetup")
        .args(["-getairportnetwork", &iface])
        .output()
        .map_err(|e| format!("networksetup spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!("networksetup -getairportnetwork {iface} failed"));
    }
    let text = String::from_utf8_lossy(&output.stdout);

    // 已连接："Current Wi-Fi Network: <SSID>"；未连接："You are not associated..."
    let ssid = text
        .lines()
        .find_map(|l| l.trim().strip_prefix("Current Wi-Fi Network:"))
        .map(|s| s.trim().to_string())
        .ok_or_else(|| "当前未连接 Wi-Fi".to_string())?;

    if ssid.is_empty() {
        return Err("当前未连接 Wi-Fi".into());
    }

    Ok(CurrentWifi {
        ssid,
        interface: iface,
    })
}

#[cfg(target_os = "macos")]
pub fn preferred_ssids() -> Result<Vec<String>, String> {
    let iface = detect_wifi_iface()?;
    let output = Command::new("networksetup")
        .args(["-listpreferredwirelessnetworks", &iface])
        .output()
        .map_err(|e| format!("networksetup spawn failed: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "networksetup -listpreferredwirelessnetworks {iface} failed"
        ));
    }
    let text = String::from_utf8_lossy(&output.stdout);

    // 输出：
    //   Preferred networks on en0:
    //       SSID-1
    //       SSID-2
    // 首行是 header，其余每行一个（缩进 tab/4 空格）。
    let list: Vec<String> = text
        .lines()
        .skip(1)
        .map(|l| l.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    Ok(list)
}

/// 从 Keychain 取 WiFi 密码。**首次调用会弹系统授权对话框**——用户必须按"允许"或
/// 通过 Touch ID。被拒绝时返回 Err，不要把错误 surface 成"出错了"，前端 UI 提示
/// "已跳过自动填充，请手输密码"即可。
#[cfg(target_os = "macos")]
pub fn keychain_password(ssid: &str) -> Result<String, String> {
    let output = Command::new("security")
        .args(["find-generic-password", "-wa", ssid])
        .output()
        .map_err(|e| format!("security spawn failed: {e}"))?;
    if !output.status.success() {
        // 用户拒绝授权 / Keychain 里没有该 SSID 都走这里
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(stderr.trim().to_string());
    }
    // -w 输出是裸密码 + 换行；trim 一下
    let pwd = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if pwd.is_empty() {
        return Err("empty password from keychain".into());
    }
    Ok(pwd)
}

// 非 macOS 平台：编译时给桩，让上层 Tauri command 始终返回错误即可。
#[cfg(not(target_os = "macos"))]
pub fn current_wifi() -> Result<CurrentWifi, String> {
    Err("unsupported on this platform".into())
}
#[cfg(not(target_os = "macos"))]
pub fn preferred_ssids() -> Result<Vec<String>, String> {
    Err("unsupported on this platform".into())
}
#[cfg(not(target_os = "macos"))]
pub fn keychain_password(_ssid: &str) -> Result<String, String> {
    Err("unsupported on this platform".into())
}
