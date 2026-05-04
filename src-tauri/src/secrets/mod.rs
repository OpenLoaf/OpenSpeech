// 系统密钥链封装。API Key 等机密一律走这里，不得落入 tauri-plugin-store。
//
// release：macOS Keychain / Windows Credential Manager / Linux Secret Service（keyring crate），
//          service `com.openspeech.app`。
// debug  ：写普通文件 `$HOME/.openspeech/dev-secrets.json`，不进 Keychain。
//          Why：debug 二进制每次 cargo build cdhash 都变，macOS Keychain ACL 绑 cdhash，
//          即便点了"始终允许"也会被当作新进程重新弹密码框。dev 数据非生产凭据，
//          落 0600 权限的本地文件足够；prod 行为不变。openloaf/storage.rs 已是同模式。
//
// 前端：invoke("secret_set|secret_get|secret_delete") —— 见 src/lib/secrets.ts。

#[cfg(not(debug_assertions))]
mod backend {
    use keyring::Entry;

    const SERVICE: &str = "com.openspeech.app";

    fn entry(name: &str) -> Result<Entry, String> {
        Entry::new(SERVICE, name).map_err(|e| e.to_string())
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        entry(name)?.set_password(value).map_err(|e| e.to_string())
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        match entry(name)?.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn delete(name: &str) -> Result<(), String> {
        match entry(name)?.delete_credential() {
            Ok(_) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

#[cfg(debug_assertions)]
mod backend {
    use std::collections::BTreeMap;
    use std::path::PathBuf;
    use std::sync::Mutex;

    static LOCK: Mutex<()> = Mutex::new(());

    fn path() -> Result<PathBuf, String> {
        let home = std::env::var_os("HOME").ok_or_else(|| "$HOME not set".to_string())?;
        let mut p = PathBuf::from(home);
        p.push(".openspeech");
        p.push("dev-secrets.json");
        Ok(p)
    }

    fn load() -> Result<BTreeMap<String, String>, String> {
        let p = path()?;
        match std::fs::read_to_string(&p) {
            Ok(raw) if raw.trim().is_empty() => Ok(BTreeMap::new()),
            Ok(raw) => match serde_json::from_str::<BTreeMap<String, String>>(&raw) {
                Ok(v) => Ok(v),
                Err(e) => {
                    log::warn!(
                        "secrets: dev secrets file corrupted, resetting ({}): {e}",
                        p.display()
                    );
                    let _ = std::fs::remove_file(&p);
                    Ok(BTreeMap::new())
                }
            },
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
            Err(e) => Err(format!("dev secrets read {}: {e}", p.display())),
        }
    }

    fn save(map: &BTreeMap<String, String>) -> Result<(), String> {
        let p = path()?;
        if let Some(parent) = p.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("dev secrets mkdir {}: {e}", parent.display()))?;
        }
        let json = serde_json::to_string_pretty(map)
            .map_err(|e| format!("dev secrets serialize: {e}"))?;
        std::fs::write(&p, json).map_err(|e| format!("dev secrets write {}: {e}", p.display()))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o600));
        }
        Ok(())
    }

    pub fn set(name: &str, value: &str) -> Result<(), String> {
        let _g = LOCK.lock().unwrap();
        let mut m = load()?;
        m.insert(name.to_string(), value.to_string());
        save(&m)
    }

    pub fn get(name: &str) -> Result<Option<String>, String> {
        let _g = LOCK.lock().unwrap();
        Ok(load()?.get(name).cloned())
    }

    pub fn delete(name: &str) -> Result<(), String> {
        let _g = LOCK.lock().unwrap();
        let mut m = load()?;
        if m.remove(name).is_some() {
            save(&m)?;
        }
        Ok(())
    }
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    backend::set(&name, &value)
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    backend::get(&name)
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    backend::delete(&name)
}

// ─── Dictation provider 凭证（仅 secret 部分） ─────────────────
//
// 与 src/lib/secrets.ts saveDictationProviderCredentials 对齐：keyring 存
// 一段 camelCase JSON。AppID / region 不是 secret，留在 settings.json，由
// 前端透传到 Rust（见 asr/byok.rs ProviderRef DTO）。

pub const DICTATION_PROVIDER_KEY_PREFIX: &str = "dictation_provider_";

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(tag = "vendor", rename_all = "lowercase")]
pub enum DictationCredentials {
    Tencent {
        #[serde(rename = "secretId")]
        secret_id: String,
        #[serde(rename = "secretKey")]
        secret_key: String,
    },
    Aliyun {
        #[serde(rename = "apiKey")]
        api_key: String,
    },
}

pub fn load_dictation_provider_credentials_for_rust(
    provider_id: &str,
) -> Result<Option<DictationCredentials>, String> {
    let key = format!("{DICTATION_PROVIDER_KEY_PREFIX}{provider_id}");
    let Some(raw) = backend::get(&key)? else {
        return Ok(None);
    };
    serde_json::from_str::<DictationCredentials>(&raw)
        .map(Some)
        .map_err(|e| format!("dictation credentials decode for {provider_id}: {e}"))
}
