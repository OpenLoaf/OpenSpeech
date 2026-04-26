//! Dev-only token dump：**不参与登录流程**，只是把已经登录成功的 session 旁路写到
//! `~/.openspeech/dev_session.json` 给测试脚本读，方便绕开 audio/hotkey 直测 SDK ↔ SaaS。
//!
//! - 写入时机：`apply_session` 完成（access_token 已设进 SaaSClient + refresh_token 已写
//!   Keychain）之后**额外**调一次。Keychain 才是登录态的真实落点；这个文件可以随时删，
//!   下次 apply_session 会重写，登录态不会丢。
//! - 清除时机：`clear_session`（logout / refresh 失败 / 401 自清）。
//! - **只在 `cfg(debug_assertions)` 下生效**——release 编译时这个 mod 整体被编译器丢弃，
//!   `dump_dev_session` / `clear_dev_session` 是空 stub。线上包永远不会落盘 token。
//! - 文件权限 0600，dev 场景按"可信本机"语境处理，不加密。
//! - 唯一读这个文件的代码：`src-tauri/examples/test_realtime_asr*.rs`。如果删除了 example，
//!   这个 mod 也可以一并删除。

#[cfg(debug_assertions)]
use crate::openloaf::DEFAULT_BASE_URL;

#[cfg(debug_assertions)]
fn dev_session_path() -> Option<std::path::PathBuf> {
    std::env::var("HOME")
        .ok()
        .map(|h| std::path::PathBuf::from(h).join(".openspeech/dev_session.json"))
}

#[cfg(debug_assertions)]
pub(super) fn dump_dev_session(access_token: &str, refresh_token: &str) {
    let Some(path) = dev_session_path() else {
        return;
    };
    if let Some(parent) = path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            log::warn!("openloaf: mkdir ~/.openspeech failed: {e}");
            return;
        }
    }
    let payload = serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "base_url": DEFAULT_BASE_URL,
        "note": "DEV ONLY — dumped by cfg(debug_assertions) build. Do NOT commit.",
    });
    let bytes = match serde_json::to_vec_pretty(&payload) {
        Ok(b) => b,
        Err(e) => {
            log::warn!("openloaf: serialize dev session: {e}");
            return;
        }
    };
    if let Err(e) = std::fs::write(&path, &bytes) {
        log::warn!("openloaf: write dev session: {e}");
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    log::info!(
        "openloaf: dev session dumped → {} (debug-only test bypass; real login state is in Keychain, not this file)",
        path.display()
    );
}

#[cfg(debug_assertions)]
pub(super) fn clear_dev_session() {
    if let Some(path) = dev_session_path() {
        if path.exists() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

#[cfg(not(debug_assertions))]
pub(super) fn dump_dev_session(_: &str, _: &str) {}

#[cfg(not(debug_assertions))]
pub(super) fn clear_dev_session() {}
