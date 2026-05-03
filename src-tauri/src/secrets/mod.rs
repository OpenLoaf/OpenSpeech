// 系统密钥链封装。API Key 等机密一律走这里，不得落入 tauri-plugin-store。
//
// 后端：macOS Keychain / Windows Credential Manager / Linux Secret Service（通过 keyring crate）。
// 前端：invoke("secret_set|secret_get|secret_delete") —— 见 src/lib/secrets.ts。

use keyring::Entry;

// 固定写死生产 identifier，**不跟随 dev overlay 变化**——这样 dev 包能复用生产已登录的
// keychain（OpenLoaf token / API key），开发时不用反复重新登录。dev/prod 的 settings.json
// / SQLite / recordings 已经按 app_data_dir 隔离，机密层不需要再隔。
const SERVICE: &str = "com.openspeech.app";

fn entry(name: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, name).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn secret_set(name: String, value: String) -> Result<(), String> {
    let e = entry(&name)?;
    e.set_password(&value).map_err(|err| err.to_string())
}

#[tauri::command]
pub fn secret_get(name: String) -> Result<Option<String>, String> {
    let e = entry(&name)?;
    match e.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => Err(err.to_string()),
    }
}

#[tauri::command]
pub fn secret_delete(name: String) -> Result<(), String> {
    let e = entry(&name)?;
    match e.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(err) => Err(err.to_string()),
    }
}
