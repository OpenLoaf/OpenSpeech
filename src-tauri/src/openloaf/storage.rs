//! `AuthStorage` 实现：把 SDK 0.3.2 的认证持久化绑到本地存储。
//!
//! 设计要点（与 SDK 协议对齐，跨 OpenLoaf 桌面应用 SSO 共享）：
//! - release：写系统 Keychain，service `"ai.openloaf.saas"`，跟其他 OpenLoaf 桌面 App
//!   共享 SSO；命名空间稳定，受 OS 加密保护。
//! - debug：写普通文件 `$HOME/.openspeech/dev-auth.json`，**完全不进 Keychain**。
//!   Why：debug 二进制每次 cargo build 出来 cdhash 都变，macOS Keychain ACL 绑的是
//!   cdhash —— 即便点了"始终允许"，下次重 build 又会被当作新进程重新弹密码框，
//!   开发者每天要被打断几十次。dev 数据非生产凭据，落普通文件足够；prod 行为不变。
//! - value 是 `serde_json(StoredAuth)`，含 `family_token / refresh_token / userId / source` 等。
//!   字段全部 camelCase + 全 optional → Node SDK 写的也能反序列化，反之亦然。
//! - 错误一律 `SaaSError::Input`：底层存储失败不是 SDK 自家协议的错误，包成 Input
//!   足够让上层 log + 优雅降级；阻断登录不合理。

use std::sync::Arc;

/// 老版 OpenSpeech 自家的 keychain 命名，仅 release 启动时一次性清理。
/// 老条目存的是裸 refresh_token 字符串，不是 StoredAuth JSON，新 SDK 读不了。
const LEGACY_KEYCHAIN_SERVICE: &str = "com.openspeech.app";
const LEGACY_KEYCHAIN_ACCOUNT: &str = "openloaf_refresh_token";

#[cfg(not(debug_assertions))]
pub type AuthStorageImpl = keychain::KeyringAuthStorage;
#[cfg(debug_assertions)]
pub type AuthStorageImpl = file::FileAuthStorage;

pub fn new_storage() -> Arc<AuthStorageImpl> {
    AuthStorageImpl::new()
}

/// 启动时调用一次：清理老命名空间的 keychain 残留（v0.2.6 之前的裸 refresh_token）。
/// debug 下也跑一次 —— 老用户可能从 release 升上来再切到 dev 跑，留着只是噪音。
pub fn cleanup_legacy_keychain() {
    use keyring::{Entry, Error as KeyringError};
    let entry = match Entry::new(LEGACY_KEYCHAIN_SERVICE, LEGACY_KEYCHAIN_ACCOUNT) {
        Ok(e) => e,
        Err(e) => {
            log::warn!("openloaf: legacy keychain entry build failed: {e}");
            return;
        }
    };
    match entry.delete_credential() {
        Ok(()) => log::info!(
            "openloaf: removed legacy keychain entry ({LEGACY_KEYCHAIN_SERVICE} / {LEGACY_KEYCHAIN_ACCOUNT})"
        ),
        Err(KeyringError::NoEntry) => {}
        Err(e) => log::warn!("openloaf: legacy keychain cleanup failed: {e}"),
    }
}

#[cfg(not(debug_assertions))]
mod keychain {
    use std::sync::Arc;

    use keyring::{Entry, Error as KeyringError};
    use openloaf_saas::{AuthStorage, SaaSError, SaaSResult, StoredAuth};

    const SERVICE: &str = "ai.openloaf.saas";
    const ACCOUNT: &str = "default";

    pub struct KeyringAuthStorage;

    impl KeyringAuthStorage {
        pub fn new() -> Arc<Self> {
            Arc::new(Self)
        }

        fn entry() -> Result<Entry, KeyringError> {
            Entry::new(SERVICE, ACCOUNT)
        }
    }

    impl AuthStorage for KeyringAuthStorage {
        fn load(&self) -> SaaSResult<Option<StoredAuth>> {
            let entry = Self::entry().map_err(|e| SaaSError::Input(format!("keyring: {e}")))?;
            match entry.get_password() {
                Ok(raw) => match serde_json::from_str::<StoredAuth>(&raw) {
                    Ok(v) => Ok(Some(v)),
                    Err(e) => {
                        log::warn!("openloaf: stored auth json corrupted, clearing: {e}");
                        let _ = entry.delete_credential();
                        Ok(None)
                    }
                },
                Err(KeyringError::NoEntry) => Ok(None),
                Err(e) => Err(SaaSError::Input(format!("keyring load: {e}"))),
            }
        }

        fn save(&self, value: &StoredAuth) -> SaaSResult<()> {
            let entry = Self::entry().map_err(|e| SaaSError::Input(format!("keyring: {e}")))?;
            let json = serde_json::to_string(value)
                .map_err(|e| SaaSError::Input(format!("serialize stored auth: {e}")))?;
            entry
                .set_password(&json)
                .map_err(|e| SaaSError::Input(format!("keyring save: {e}")))
        }

        fn clear(&self) -> SaaSResult<()> {
            let entry = Self::entry().map_err(|e| SaaSError::Input(format!("keyring: {e}")))?;
            match entry.delete_credential() {
                Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
                Err(e) => Err(SaaSError::Input(format!("keyring clear: {e}"))),
            }
        }
    }
}

#[cfg(debug_assertions)]
mod file {
    use std::path::PathBuf;
    use std::sync::Arc;

    use openloaf_saas::{AuthStorage, SaaSError, SaaSResult, StoredAuth};

    pub struct FileAuthStorage;

    impl FileAuthStorage {
        pub fn new() -> Arc<Self> {
            Arc::new(Self)
        }

        fn path() -> Result<PathBuf, String> {
            let home =
                std::env::var_os("HOME").ok_or_else(|| "$HOME not set".to_string())?;
            let mut p = PathBuf::from(home);
            p.push(".openspeech");
            p.push("dev-auth.json");
            Ok(p)
        }
    }

    impl AuthStorage for FileAuthStorage {
        fn load(&self) -> SaaSResult<Option<StoredAuth>> {
            let path = Self::path().map_err(SaaSError::Input)?;
            match std::fs::read_to_string(&path) {
                Ok(raw) => match serde_json::from_str::<StoredAuth>(&raw) {
                    Ok(v) => Ok(Some(v)),
                    Err(e) => {
                        log::warn!(
                            "openloaf: dev auth file corrupted, clearing ({}): {e}",
                            path.display()
                        );
                        let _ = std::fs::remove_file(&path);
                        Ok(None)
                    }
                },
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(e) => Err(SaaSError::Input(format!(
                    "dev auth read {}: {e}",
                    path.display()
                ))),
            }
        }

        fn save(&self, value: &StoredAuth) -> SaaSResult<()> {
            let path = Self::path().map_err(SaaSError::Input)?;
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent).map_err(|e| {
                    SaaSError::Input(format!("dev auth mkdir {}: {e}", parent.display()))
                })?;
            }
            let json = serde_json::to_string(value)
                .map_err(|e| SaaSError::Input(format!("serialize stored auth: {e}")))?;
            std::fs::write(&path, json).map_err(|e| {
                SaaSError::Input(format!("dev auth write {}: {e}", path.display()))
            })?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
            Ok(())
        }

        fn clear(&self) -> SaaSResult<()> {
            let path = Self::path().map_err(SaaSError::Input)?;
            match std::fs::remove_file(&path) {
                Ok(()) => Ok(()),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                Err(e) => Err(SaaSError::Input(format!(
                    "dev auth clear {}: {e}",
                    path.display()
                ))),
            }
        }
    }
}

