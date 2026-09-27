// 本地（离线）语音识别：模型清单、下载安装、推理引擎、常驻缓存。
//
// 分层（新增模型 / 引擎时各改一层，互不牵连）：
//   catalog.rs   模型清单（闭集）——加模型只改这里 + 前端 i18n 介绍
//   install.rs   安装目录布局与「已安装」判定
//   download.rs  下载（多源 / 断点续传 / sha256）+ 解压安装
//   engine/      推理引擎 trait；加引擎类型在这里实现（只在子进程里实例化）
//   host/        推理子进程：主进程侧按需拉起 / 闲置退出 + 子进程主循环 + 线协议
//   audio_file.rs 录音文件解码（历史重试走整段识别）
//
// 与听写链路的接缝：asr/byok.rs 的 ProviderMode::Local → DictationBackend::Local*，
// 实时走 asr/backends/local.rs（实现 RealtimeAsrBackend），文件走 transcribe_file()，
// 两条路都经 host::HostSession 交给子进程推理，主进程不持有模型。
// 全程不联网、不需要 OpenLoaf 登录；隐私边界见 docs/privacy.md。

pub mod audio_file;
pub mod catalog;
pub mod download;
pub mod engine;
pub mod error;
pub mod host;
pub mod install;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Runtime};

use catalog::ModelSpec;
use error::LocalAsrError;

pub const EVENT_ENGINE_STATE: &str = "openspeech://local-asr/engine";

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum InstallStatus {
    NotInstalled,
    Downloading,
    Installed,
}

/// 设置页渲染模型卡片用。介绍文案不在这里：Rust 只给元数据，文案走前端 i18n。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalModelInfo {
    pub id: &'static str,
    pub display_name: &'static str,
    pub author: &'static str,
    pub license: &'static str,
    pub homepage: &'static str,
    pub languages: &'static [&'static str],
    pub download_bytes: u64,
    pub disk_bytes: u64,
    pub memory_mb: u32,
    pub streaming: bool,
    pub punctuation: bool,
    pub status: InstallStatus,
    pub loaded: bool,
}

fn info<R: Runtime>(
    app: &AppHandle<R>,
    spec: &'static ModelSpec,
    loaded: Option<&str>,
) -> LocalModelInfo {
    let status = if download::is_downloading(spec.id) {
        InstallStatus::Downloading
    } else if install::is_installed(app, spec) {
        InstallStatus::Installed
    } else {
        InstallStatus::NotInstalled
    };
    LocalModelInfo {
        id: spec.id,
        display_name: spec.display_name,
        author: spec.author,
        license: spec.license,
        homepage: spec.homepage,
        languages: spec.languages,
        download_bytes: spec.archive.bytes,
        disk_bytes: spec.disk_bytes,
        memory_mb: spec.memory_mb,
        streaming: spec.streaming,
        punctuation: spec.punctuation,
        status,
        loaded: loaded == Some(spec.id),
    }
}

fn spec_of(model_id: &str) -> Result<&'static ModelSpec, LocalAsrError> {
    catalog::find(model_id).ok_or_else(|| LocalAsrError::UnknownModel(model_id.to_string()))
}

/// 命令边界统一出口：细节进日志，前端只拿稳定 code。
fn report(context: &str, e: LocalAsrError) -> String {
    log::warn!("[local_asr] {context}: {e}");
    e.into()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatePayload {
    model_id: String,
    /// loading / ready / failed / stopped（子进程闲置退出或被关掉）
    state: &'static str,
    error: Option<String>,
}

pub(crate) fn emit_engine_state<R: Runtime>(
    app: &AppHandle<R>,
    model_id: &str,
    state: &'static str,
    error: Option<String>,
) {
    let _ = app.emit(
        EVENT_ENGINE_STATE,
        EngineStatePayload {
            model_id: model_id.to_string(),
            state,
            error,
        },
    );
}

#[tauri::command]
pub fn local_asr_list_models<R: Runtime>(app: AppHandle<R>) -> Vec<LocalModelInfo> {
    let loaded = host::loaded_model_id();
    catalog::CATALOG
        .iter()
        .map(|s| info(&app, s, loaded.as_deref()))
        .collect()
}

/// 下载并安装；进度走 download::EVENT_DOWNLOAD_PROGRESS。返回即完成（或失败 code）。
#[tauri::command]
pub async fn local_asr_download<R: Runtime>(
    app: AppHandle<R>,
    model_id: String,
) -> Result<(), String> {
    let spec = spec_of(&model_id).map_err(|e| report("download", e))?;
    download::download_and_install(app, spec)
        .await
        .map_err(|e| report("download", e))
}

#[tauri::command]
pub fn local_asr_cancel_download(model_id: String) {
    download::cancel(&model_id);
}

#[tauri::command]
pub async fn local_asr_delete<R: Runtime>(
    app: AppHandle<R>,
    model_id: String,
) -> Result<(), String> {
    let spec = spec_of(&model_id).map_err(|e| report("delete", e))?;
    if download::is_downloading(spec.id) {
        return Err(report(
            "delete",
            LocalAsrError::DownloadInProgress(model_id.clone()),
        ));
    }
    if host::loaded_model_id().as_deref() == Some(spec.id) {
        host::shutdown("model deleted");
    }
    tauri::async_runtime::spawn_blocking(move || install::remove(&app, spec))
        .await
        .map_err(|e| format!("delete join: {e}"))?
        .map_err(|e| report("delete", e))
}

/// 预热：后台拉起推理子进程并加载模型，状态走 EVENT_ENGINE_STATE。设置页点「使用」
/// 时调，让紧接着的第一次按键不用等冷启动；不用的话子进程闲置 5 分钟后自己退出。
#[tauri::command]
pub fn local_asr_preload<R: Runtime>(app: AppHandle<R>, model_id: String) {
    std::thread::Builder::new()
        .name("openspeech-local-asr-preload".into())
        .spawn(move || {
            if let Err(e) = host::preload(&app, &model_id) {
                log::warn!("[local_asr] preload failed: {e}");
                emit_engine_state(&app, &model_id, "failed", Some(e.code().to_string()));
            }
        })
        .map(|_| ())
        .unwrap_or_else(|e| log::warn!("[local_asr] spawn preload thread: {e}"));
}

/// 切走本地通道时立即结束子进程、归还内存。
#[tauri::command]
pub fn local_asr_unload() {
    host::shutdown("unload requested");
}

/// 整段识别录音文件（transcribe_recording_file 的本地分支）。阻塞，调用方需 spawn_blocking。
pub fn transcribe_file<R: Runtime>(
    app: &AppHandle<R>,
    model_id: &str,
    path: &std::path::Path,
) -> Result<String, LocalAsrError> {
    use host::StreamSession;
    use host::protocol::Event;

    let samples = audio_file::load_mono_16k(path)?;
    let started = std::time::Instant::now();
    let mut session = host::HostSession::open(app, model_id)?;
    // 100ms 一帧，贴近实时路径的解码节奏。
    for chunk in samples.chunks(engine::SAMPLE_RATE as usize / 10) {
        session.send_audio(chunk.to_vec());
    }
    session.finish();

    let audio_ms = samples.len() as u64 * 1000 / engine::SAMPLE_RATE as u64;
    // 解码实测约 20 倍实时；给到音频时长 + 30s 足够，超时视为子进程卡死。
    let deadline = started + std::time::Duration::from_millis(audio_ms + 30_000);
    let mut text = String::new();
    loop {
        let left = deadline.saturating_duration_since(std::time::Instant::now());
        match session.recv_timeout(left) {
            Ok(Event::Final { text: t }) => text.push_str(&t),
            Ok(Event::End) => break,
            Ok(_) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                return Err(LocalAsrError::EngineExited(
                    "file transcription timed out".into(),
                ));
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                return Err(LocalAsrError::EngineExited("host exited mid-file".into()));
            }
        }
    }
    log::info!(
        "[local_asr] file transcribed model={model_id} audio_ms={audio_ms} cost_ms={} chars={}",
        started.elapsed().as_millis(),
        text.chars().count()
    );
    Ok(text)
}
