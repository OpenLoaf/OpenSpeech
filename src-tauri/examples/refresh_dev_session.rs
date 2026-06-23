//! 一次性 dev 工具：用 dev-auth.json 里的 family_token 调 SaaS /auth/family/exchange
//! 续期（family 不轮换、TTL 长，比 refresh_token 稳），把新 access_token + refresh_token
//! 写回 dev_session.json。token 过期跑 prompt-eval 时用。不打印任何 token 明文。

use std::fs;
use std::path::PathBuf;

use openloaf_saas::{AuthClientInfo, SaaSClient, SaaSClientConfig};
use serde::Deserialize;
use serde_json::json;

#[derive(Deserialize)]
struct DevSession {
    base_url: String,
    #[serde(default)]
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredAuthFile {
    family_token: Option<String>,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = rustls::crypto::ring::default_provider().install_default();

    let home = std::env::var("HOME")?;
    let session_path = PathBuf::from(&home).join(".openspeech/dev_session.json");
    let auth_path = PathBuf::from(&home).join(".openspeech/dev-auth.json");

    let sess: DevSession = serde_json::from_slice(&fs::read(&session_path)?)?;
    let auth: StoredAuthFile = serde_json::from_slice(&fs::read(&auth_path)?)?;
    let family_token = auth
        .family_token
        .ok_or("dev-auth.json 没有 familyToken — 只能走重启 dev build 重新登录")?;

    let cfg = SaaSClientConfig {
        base_url: sess.base_url.clone(),
        ..Default::default()
    };
    let client = SaaSClient::new(cfg);

    let info = AuthClientInfo {
        app_id: Some("openspeech-desktop".into()),
        app_version: Some(env!("CARGO_PKG_VERSION").into()),
        platform: Some(std::env::consts::OS.into()),
        os_version: None,
        extra: None,
    };

    let new = client
        .auth()
        .family_exchange(&family_token, Some(&info))
        .map_err(|e| format!("family_exchange failed: {e}"))?;

    let out = json!({
        "access_token": new.access_token,
        "refresh_token": new.refresh_token,
        "base_url": sess.base_url,
        "note": sess.note.unwrap_or_else(|| "DEV ONLY — refreshed by refresh_dev_session".into()),
    });
    fs::write(&session_path, serde_json::to_vec_pretty(&out)?)?;

    eprintln!("[refresh] ok via family_exchange → {}", session_path.display());
    eprintln!("[refresh] user={}", new.user.id.unwrap_or_default());
    Ok(())
}
