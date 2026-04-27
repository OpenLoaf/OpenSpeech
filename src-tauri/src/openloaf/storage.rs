//! `AuthStorage` 实现：把 SDK 0.3.2 的认证持久化绑到系统 Keychain。
//!
//! 设计要点（与 SDK 协议对齐，跨 OpenLoaf 桌面应用 SSO 共享）：
//! - service 名按 build profile 分岔：release 用 `"ai.openloaf.saas"` 走 SDK 0.3.2 推荐的
//!   跨应用 SSO 命名；debug 用 `"ai.openloaf.saas.dev"` 完全隔离，避免本机跑 dev SaaS
//!   时把 dev token 写进生产共享 entry 后污染生产 OpenSpeech / 其他生产 OpenLoaf 应用。
//!   线上事故案例：dev 启动后写入 `ai.openloaf.saas`，prod 启动读到 base_url=localhost:5180
//!   的 token，登录 hang 在 Loading（dev server 已关）。
//! - value 是 `serde_json(StoredAuth)`，含 `family_token / refresh_token / userId / source` 等。
//!   字段全部 camelCase + 全 optional → Node SDK 写的也能反序列化，反之亦然。
//! - 错误一律 `SaaSError::Input`：keyring 失败不是 SDK 自家协议的错误，包成 Input
//!   足够让上层 log + 优雅降级；阻断登录不合理。

use std::sync::Arc;

use keyring::{Entry, Error as KeyringError};
use openloaf_saas::{AuthStorage, SaaSError, SaaSResult, StoredAuth};

#[cfg(not(debug_assertions))]
const SERVICE: &str = "ai.openloaf.saas";
#[cfg(debug_assertions)]
const SERVICE: &str = "ai.openloaf.saas.dev";

const ACCOUNT: &str = "default";

/// 老版 OpenSpeech 自家的 keychain 命名，仅用于 `cleanup_legacy()` 一次性清理。
/// 老条目存的是裸 refresh_token 字符串，不是 StoredAuth JSON，新 SDK 读不了。
const LEGACY_SERVICE: &str = "com.openspeech.app";
const LEGACY_ACCOUNT: &str = "openloaf_refresh_token";

pub struct KeyringAuthStorage;

impl KeyringAuthStorage {
    pub fn new() -> Arc<Self> {
        Arc::new(Self)
    }

    fn entry() -> Result<Entry, KeyringError> {
        Entry::new(SERVICE, ACCOUNT)
    }

    /// 应用启动时调用一次：删掉老命名空间的 refresh_token 条目（如果有），避免长期残留。
    /// `NoEntry` 静默忽略；其它错误只 warn 不 panic。
    pub fn cleanup_legacy() {
        let entry = match Entry::new(LEGACY_SERVICE, LEGACY_ACCOUNT) {
            Ok(e) => e,
            Err(e) => {
                log::warn!("openloaf: legacy keychain entry build failed: {e}");
                return;
            }
        };
        match entry.delete_credential() {
            Ok(()) => log::info!(
                "openloaf: removed legacy keychain entry ({LEGACY_SERVICE} / {LEGACY_ACCOUNT})"
            ),
            Err(KeyringError::NoEntry) => {}
            Err(e) => log::warn!("openloaf: legacy keychain cleanup failed: {e}"),
        }
    }
}

impl AuthStorage for KeyringAuthStorage {
    fn load(&self) -> SaaSResult<Option<StoredAuth>> {
        let entry = Self::entry().map_err(|e| SaaSError::Input(format!("keyring: {e}")))?;
        match entry.get_password() {
            Ok(raw) => match serde_json::from_str::<StoredAuth>(&raw) {
                Ok(v) => Ok(Some(v)),
                Err(e) => {
                    // 损坏的 JSON 不要把用户卡死——清掉让 SDK 走 OAuth 重登。
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
