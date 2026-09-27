// 模型安装目录布局：
//
//   app_data_dir/models/
//   ├── <model-id>/            已安装模型（spec.files + model.json 清单）
//   └── .staging/<model-id>/   下载 / 解压中间态；装好后原子 rename 过去
//
// 「已安装」= model.json 存在、记录的 sha256 与当前 catalog 一致、spec.files 全在。
// catalog 换了新归档（sha256 变）时旧安装自动视为未安装，引导用户重下，避免新版
// 引擎配置去读旧文件。

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::{Manager, Runtime};

use super::catalog::ModelSpec;
use super::error::LocalAsrError;

const MANIFEST: &str = "model.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstallManifest {
    pub id: String,
    pub archive_sha256: String,
    pub installed_at_ms: i64,
}

pub fn models_root<R: Runtime>(app: &tauri::AppHandle<R>) -> Result<PathBuf, LocalAsrError> {
    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| LocalAsrError::Io(format!("app_data_dir: {e}")))?;
    Ok(base.join("models"))
}

pub fn model_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    spec: &ModelSpec,
) -> Result<PathBuf, LocalAsrError> {
    Ok(models_root(app)?.join(spec.id))
}

pub fn staging_dir<R: Runtime>(
    app: &tauri::AppHandle<R>,
    spec: &ModelSpec,
) -> Result<PathBuf, LocalAsrError> {
    Ok(models_root(app)?.join(".staging").join(spec.id))
}

pub fn is_installed_at(dir: &Path, spec: &ModelSpec) -> bool {
    let Ok(raw) = std::fs::read_to_string(dir.join(MANIFEST)) else {
        return false;
    };
    let Ok(manifest) = serde_json::from_str::<InstallManifest>(&raw) else {
        return false;
    };
    manifest.id == spec.id
        && manifest.archive_sha256 == spec.archive.sha256
        && spec.files.iter().all(|f| dir.join(f).is_file())
}

pub fn is_installed<R: Runtime>(app: &tauri::AppHandle<R>, spec: &ModelSpec) -> bool {
    model_dir(app, spec).is_ok_and(|d| is_installed_at(&d, spec))
}

pub fn write_manifest(dir: &Path, spec: &ModelSpec) -> Result<(), LocalAsrError> {
    let manifest = InstallManifest {
        id: spec.id.to_string(),
        archive_sha256: spec.archive.sha256.to_string(),
        installed_at_ms: chrono::Utc::now().timestamp_millis(),
    };
    let body = serde_json::to_vec_pretty(&manifest)
        .map_err(|e| LocalAsrError::Io(format!("manifest encode: {e}")))?;
    std::fs::write(dir.join(MANIFEST), body)
        .map_err(|e| LocalAsrError::Io(format!("manifest write: {e}")))
}

/// 删除已安装模型与残留的 staging。目录不存在视为成功（幂等）。
pub fn remove<R: Runtime>(
    app: &tauri::AppHandle<R>,
    spec: &ModelSpec,
) -> Result<(), LocalAsrError> {
    for dir in [model_dir(app, spec)?, staging_dir(app, spec)?] {
        match std::fs::remove_dir_all(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => {
                return Err(LocalAsrError::Io(format!("remove {}: {e}", dir.display())));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_asr::catalog::CATALOG;

    fn fixture(dir: &Path, spec: &ModelSpec) {
        std::fs::create_dir_all(dir).unwrap();
        for f in spec.files {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
        write_manifest(dir, spec).unwrap();
    }

    #[test]
    fn installed_requires_manifest_and_all_files() {
        let spec = &CATALOG[0];
        let tmp = std::env::temp_dir().join(format!("os-local-asr-{}", uuid::Uuid::new_v4()));
        fixture(&tmp, spec);
        assert!(is_installed_at(&tmp, spec));

        std::fs::remove_file(tmp.join(spec.files[0])).unwrap();
        assert!(!is_installed_at(&tmp, spec));
        std::fs::remove_dir_all(&tmp).unwrap();
    }

    // catalog 换归档后旧安装必须失效，否则新引擎配置会去读旧文件。
    #[test]
    fn stale_archive_hash_is_not_installed() {
        let spec = &CATALOG[0];
        let tmp = std::env::temp_dir().join(format!("os-local-asr-{}", uuid::Uuid::new_v4()));
        fixture(&tmp, spec);
        let stale = InstallManifest {
            id: spec.id.into(),
            archive_sha256: "0".repeat(64),
            installed_at_ms: 0,
        };
        std::fs::write(tmp.join(MANIFEST), serde_json::to_vec(&stale).unwrap()).unwrap();
        assert!(!is_installed_at(&tmp, spec));
        std::fs::remove_dir_all(&tmp).unwrap();
    }
}
