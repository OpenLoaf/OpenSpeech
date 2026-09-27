// 模型下载 + 校验 + 安装。
//
// 流程：staging/<archive>.part 流式写入（支持 Range 断点续传）→ 整文件 sha256 校验
// → 解压到 staging/extract（只保留 spec.files）→ 写 model.json → rename 到正式目录。
// 任一步失败正式目录都不受影响；只有「用户取消」和「校验失败」会删 .part，网络错误
// 保留 .part，下次点下载从断点续。
//
// 实测国内直连 GitHub Release 常见 100~200KB/s 且中途断流，所以断点续传和多源回退
// 不是锦上添花，是这条链路能用的前提。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use tauri::{Emitter, Runtime};

use super::catalog::{ArchiveFormat, ModelSpec};
use super::error::LocalAsrError;
use super::install;

pub const EVENT_DOWNLOAD_PROGRESS: &str = "openspeech://local-asr/download";

/// 单个数据块最长等待；超过视为断流，换源 / 让用户重试（保留 .part）。
const CHUNK_STALL_TIMEOUT: Duration = Duration::from_secs(30);
const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
/// 进度事件节流，避免每个 16KB 块都跨 IPC。
const PROGRESS_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Downloading,
    Verifying,
    Extracting,
    Done,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    pub model_id: String,
    pub phase: Phase,
    pub downloaded: u64,
    pub total: u64,
    /// Failed 时的稳定错误码。
    pub error: Option<String>,
}

fn active() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    static ACTIVE: std::sync::OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
        std::sync::OnceLock::new();
    ACTIVE.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn is_downloading(model_id: &str) -> bool {
    active().lock().is_ok_and(|g| g.contains_key(model_id))
}

pub fn cancel(model_id: &str) {
    if let Ok(g) = active().lock()
        && let Some(flag) = g.get(model_id)
    {
        flag.store(true, Ordering::Relaxed);
    }
}

/// 同一模型同时只允许一个下载；guard drop 时自动出表。
struct ActiveGuard(String);

impl ActiveGuard {
    fn register(model_id: &str) -> Result<(Self, Arc<AtomicBool>), LocalAsrError> {
        let mut g = active()
            .lock()
            .map_err(|e| LocalAsrError::Io(format!("download registry: {e}")))?;
        if g.contains_key(model_id) {
            return Err(LocalAsrError::DownloadInProgress(model_id.to_string()));
        }
        let flag = Arc::new(AtomicBool::new(false));
        g.insert(model_id.to_string(), flag.clone());
        Ok((Self(model_id.to_string()), flag))
    }
}

impl Drop for ActiveGuard {
    fn drop(&mut self) {
        if let Ok(mut g) = active().lock() {
            g.remove(&self.0);
        }
    }
}

struct Reporter<'a, R: Runtime> {
    app: &'a tauri::AppHandle<R>,
    model_id: &'static str,
    total: u64,
    last_emit: Instant,
}

impl<R: Runtime> Reporter<'_, R> {
    fn emit(&mut self, phase: Phase, downloaded: u64, error: Option<&str>) {
        let _ = self.app.emit(
            EVENT_DOWNLOAD_PROGRESS,
            Progress {
                model_id: self.model_id.to_string(),
                phase,
                downloaded,
                total: self.total,
                error: error.map(str::to_string),
            },
        );
        self.last_emit = Instant::now();
    }

    fn tick(&mut self, downloaded: u64) {
        if self.last_emit.elapsed() >= PROGRESS_INTERVAL {
            self.emit(Phase::Downloading, downloaded, None);
        }
    }
}

pub async fn download_and_install<R: Runtime>(
    app: tauri::AppHandle<R>,
    spec: &'static ModelSpec,
) -> Result<(), LocalAsrError> {
    let (_guard, cancel_flag) = ActiveGuard::register(spec.id)?;
    let mut rep = Reporter {
        app: &app,
        model_id: spec.id,
        total: spec.archive.bytes,
        last_emit: Instant::now(),
    };
    let result = run(&app, spec, &cancel_flag, &mut rep).await;
    match &result {
        Ok(()) => rep.emit(Phase::Done, spec.archive.bytes, None),
        Err(e) => {
            log::warn!("[local_asr] install {} failed: {e}", spec.id);
            rep.emit(Phase::Failed, 0, Some(e.code()));
        }
    }
    result
}

async fn run<R: Runtime>(
    app: &tauri::AppHandle<R>,
    spec: &'static ModelSpec,
    cancel_flag: &AtomicBool,
    rep: &mut Reporter<'_, R>,
) -> Result<(), LocalAsrError> {
    let staging = install::staging_dir(app, spec)?;
    std::fs::create_dir_all(&staging)
        .map_err(|e| LocalAsrError::Io(format!("mkdir staging: {e}")))?;
    let part = staging.join("archive.part");

    let mut last_err = LocalAsrError::Download("no download source".into());
    let mut fetched = false;
    for url in spec.archive.urls {
        match fetch(url, &part, cancel_flag, rep).await {
            Ok(()) => {
                fetched = true;
                break;
            }
            Err(LocalAsrError::Cancelled) => {
                let _ = std::fs::remove_file(&part);
                return Err(LocalAsrError::Cancelled);
            }
            Err(e) => {
                log::warn!("[local_asr] source failed url={url}: {e}");
                last_err = e;
            }
        }
    }
    if !fetched {
        return Err(last_err);
    }

    rep.emit(Phase::Verifying, spec.archive.bytes, None);
    let part_for_hash = part.clone();
    let digest = tauri::async_runtime::spawn_blocking(move || sha256_file(&part_for_hash))
        .await
        .map_err(|e| LocalAsrError::Io(format!("hash join: {e}")))??;
    if !digest.eq_ignore_ascii_case(spec.archive.sha256) {
        log::warn!(
            "[local_asr] checksum mismatch model={} got={digest} want={}",
            spec.id,
            spec.archive.sha256
        );
        let _ = std::fs::remove_file(&part);
        return Err(LocalAsrError::ChecksumMismatch);
    }

    rep.emit(Phase::Extracting, spec.archive.bytes, None);
    let final_dir = install::model_dir(app, spec)?;
    tauri::async_runtime::spawn_blocking(move || {
        install_from_archive(spec, &part, &staging, &final_dir)
    })
    .await
    .map_err(|e| LocalAsrError::Io(format!("extract join: {e}")))??;
    log::info!("[local_asr] model installed id={}", spec.id);
    Ok(())
}

/// 下载到 part；已有部分内容时带 Range 续传。服务端不支持 Range（回 200）则从头写。
async fn fetch<R: Runtime>(
    url: &str,
    part: &Path,
    cancel_flag: &AtomicBool,
    rep: &mut Reporter<'_, R>,
) -> Result<(), LocalAsrError> {
    let existing = std::fs::metadata(part).map(|m| m.len()).unwrap_or(0);
    if existing == rep.total {
        return Ok(());
    }

    let mut req = crate::http::client().get(url);
    if existing > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let resp = tokio::time::timeout(CONNECT_TIMEOUT, req.send())
        .await
        .map_err(|_| LocalAsrError::Download(format!("connect timeout {url}")))?
        .map_err(|e| LocalAsrError::Download(format!("request {url}: {e}")))?;

    let status = resp.status();
    let (mut file, mut downloaded) = if status == reqwest::StatusCode::PARTIAL_CONTENT {
        let f = std::fs::OpenOptions::new()
            .append(true)
            .open(part)
            .map_err(|e| LocalAsrError::Io(format!("open part: {e}")))?;
        log::info!("[local_asr] resume download at {existing} bytes");
        (f, existing)
    } else if status.is_success() {
        let f = std::fs::File::create(part)
            .map_err(|e| LocalAsrError::Io(format!("create part: {e}")))?;
        (f, 0)
    } else if status == reqwest::StatusCode::RANGE_NOT_SATISFIABLE {
        // .part 比远端还大（换了归档 / 文件损坏）：丢掉重来，交给下一次尝试。
        let _ = std::fs::remove_file(part);
        return Err(LocalAsrError::Download(format!(
            "range not satisfiable {url}"
        )));
    } else {
        return Err(LocalAsrError::Download(format!("http {status} {url}")));
    };

    rep.emit(Phase::Downloading, downloaded, None);
    let mut body = resp.bytes_stream();
    loop {
        if cancel_flag.load(Ordering::Relaxed) {
            return Err(LocalAsrError::Cancelled);
        }
        let next = tokio::time::timeout(CHUNK_STALL_TIMEOUT, body.next())
            .await
            .map_err(|_| LocalAsrError::Download(format!("stalled {url}")))?;
        let Some(chunk) = next else { break };
        let chunk = chunk.map_err(|e| LocalAsrError::Download(format!("read {url}: {e}")))?;
        file.write_all(&chunk)
            .map_err(|e| LocalAsrError::Io(format!("write part: {e}")))?;
        downloaded += chunk.len() as u64;
        rep.tick(downloaded);
    }
    file.flush()
        .map_err(|e| LocalAsrError::Io(format!("flush part: {e}")))?;
    if downloaded != rep.total {
        return Err(LocalAsrError::Download(format!(
            "size mismatch {downloaded} != {} from {url}",
            rep.total
        )));
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, LocalAsrError> {
    let mut f = std::fs::File::open(path).map_err(|e| LocalAsrError::Io(format!("open: {e}")))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1 << 20];
    loop {
        let n = f
            .read(&mut buf)
            .map_err(|e| LocalAsrError::Io(format!("read: {e}")))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

fn install_from_archive(
    spec: &ModelSpec,
    archive: &Path,
    staging: &Path,
    final_dir: &Path,
) -> Result<(), LocalAsrError> {
    let extract_dir = staging.join("extract");
    let _ = std::fs::remove_dir_all(&extract_dir);
    std::fs::create_dir_all(&extract_dir)
        .map_err(|e| LocalAsrError::Io(format!("mkdir extract: {e}")))?;

    match spec.archive.format {
        ArchiveFormat::TarBz2 => {
            let f = std::fs::File::open(archive)
                .map_err(|e| LocalAsrError::Extract(format!("open archive: {e}")))?;
            let decoder = bzip2::read::BzDecoder::new(std::io::BufReader::new(f));
            extract_selected(tar::Archive::new(decoder), spec, &extract_dir)?;
        }
    }

    let missing: Vec<_> = spec
        .files
        .iter()
        .filter(|f| !extract_dir.join(f).is_file())
        .collect();
    if !missing.is_empty() {
        return Err(LocalAsrError::Extract(format!(
            "archive missing {missing:?}"
        )));
    }
    install::write_manifest(&extract_dir, spec)?;

    // 覆盖安装：先挪走旧目录再 rename，rename 失败时旧版本还能恢复。
    let backup = staging.join("previous");
    let _ = std::fs::remove_dir_all(&backup);
    let had_previous = final_dir.exists();
    if had_previous {
        std::fs::rename(final_dir, &backup)
            .map_err(|e| LocalAsrError::Io(format!("move previous install: {e}")))?;
    }
    if let Some(parent) = final_dir.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| LocalAsrError::Io(format!("mkdir models: {e}")))?;
    }
    if let Err(e) = std::fs::rename(&extract_dir, final_dir) {
        if had_previous {
            let _ = std::fs::rename(&backup, final_dir);
        }
        return Err(LocalAsrError::Io(format!("install rename: {e}")));
    }
    let _ = std::fs::remove_dir_all(staging);
    Ok(())
}

/// 只解出 spec.files 列出的条目；路径必须精确匹配 `<strip_prefix>/<file>`，
/// 天然挡住 `../` 之类的路径穿越条目。
fn extract_selected<A: Read>(
    mut archive: tar::Archive<A>,
    spec: &ModelSpec,
    dest: &Path,
) -> Result<(), LocalAsrError> {
    let entries = archive
        .entries()
        .map_err(|e| LocalAsrError::Extract(format!("tar entries: {e}")))?;
    for entry in entries {
        let mut entry = entry.map_err(|e| LocalAsrError::Extract(format!("tar entry: {e}")))?;
        let path: PathBuf = entry
            .path()
            .map_err(|e| LocalAsrError::Extract(format!("tar path: {e}")))?
            .into_owned();
        let Ok(rel) = path.strip_prefix(spec.archive.strip_prefix) else {
            continue;
        };
        let Some(name) = rel.to_str() else { continue };
        if !spec.files.contains(&name) {
            continue;
        }
        let target = dest.join(name);
        let mut out = std::fs::File::create(&target)
            .map_err(|e| LocalAsrError::Extract(format!("create {name}: {e}")))?;
        std::io::copy(&mut entry, &mut out)
            .map_err(|e| LocalAsrError::Extract(format!("write {name}: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local_asr::catalog::CATALOG;

    /// 真归档安装链路（手动跑）：校验 sha256 → 只解出清单文件 → 原子落位 → 判定已安装。
    ///   OPENSPEECH_LOCAL_ASR_ARCHIVE=<下载好的 .tar.bz2> \
    ///   cargo test --lib local_asr::download::tests::real_archive -- --ignored --nocapture
    #[test]
    #[ignore]
    fn real_archive_verifies_and_installs_only_listed_files() {
        let archive = PathBuf::from(std::env::var("OPENSPEECH_LOCAL_ASR_ARCHIVE").unwrap());
        let spec = &CATALOG[0];
        assert_eq!(sha256_file(&archive).unwrap(), spec.archive.sha256);

        let root = std::env::temp_dir().join(format!("os-local-asr-{}", uuid::Uuid::new_v4()));
        let staging = root.join(".staging").join(spec.id);
        let final_dir = root.join(spec.id);
        std::fs::create_dir_all(&staging).unwrap();
        install_from_archive(spec, &archive, &staging, &final_dir).unwrap();

        assert!(install::is_installed_at(&final_dir, spec));
        let mut names: Vec<_> = std::fs::read_dir(&final_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        names.sort();
        println!("installed files: {names:?}");
        // 测试音频 / 脚本 / README 不落盘。
        assert_eq!(names.len(), spec.files.len() + 1);
        assert!(!staging.exists(), "staging should be cleaned");

        // 覆盖安装（重复下载同一模型）也要成功。
        std::fs::create_dir_all(&staging).unwrap();
        install_from_archive(spec, &archive, &staging, &final_dir).unwrap();
        assert!(install::is_installed_at(&final_dir, spec));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
