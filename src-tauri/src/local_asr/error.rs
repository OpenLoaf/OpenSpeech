// 本地 ASR 错误：对外只暴露稳定 code（前端 i18n 按 code 路由），细节只进日志。

#[derive(Debug, Clone)]
pub enum LocalAsrError {
    UnknownModel(String),
    NotInstalled(String),
    NotSelected,
    DownloadInProgress(String),
    Download(String),
    ChecksumMismatch,
    Cancelled,
    Extract(String),
    Load(String),
    /// 推理子进程意外退出（崩溃 / 被系统杀掉）。
    EngineExited(String),
    Decode(String),
    Io(String),
}

impl LocalAsrError {
    pub fn code(&self) -> &'static str {
        match self {
            LocalAsrError::UnknownModel(_) => "local_model_unknown",
            LocalAsrError::NotInstalled(_) => "local_model_not_installed",
            LocalAsrError::NotSelected => "local_model_not_selected",
            LocalAsrError::DownloadInProgress(_) => "local_model_download_in_progress",
            LocalAsrError::Download(_) => "local_model_download_failed",
            LocalAsrError::ChecksumMismatch => "local_model_checksum_mismatch",
            LocalAsrError::Cancelled => "local_model_download_cancelled",
            LocalAsrError::Extract(_) => "local_model_extract_failed",
            LocalAsrError::Load(_) => "local_model_load_failed",
            LocalAsrError::EngineExited(_) => "local_engine_exited",
            LocalAsrError::Decode(_) => "local_audio_decode_failed",
            LocalAsrError::Io(_) => "local_model_io_error",
        }
    }
}

impl std::fmt::Display for LocalAsrError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            LocalAsrError::UnknownModel(d)
            | LocalAsrError::NotInstalled(d)
            | LocalAsrError::DownloadInProgress(d)
            | LocalAsrError::Download(d)
            | LocalAsrError::Extract(d)
            | LocalAsrError::Load(d)
            | LocalAsrError::EngineExited(d)
            | LocalAsrError::Decode(d)
            | LocalAsrError::Io(d) => write!(f, "{}: {d}", self.code()),
            LocalAsrError::NotSelected
            | LocalAsrError::ChecksumMismatch
            | LocalAsrError::Cancelled => f.write_str(self.code()),
        }
    }
}

impl std::error::Error for LocalAsrError {}

/// Tauri 命令边界：只把 code 交给前端，detail 已在出错处打日志。
impl From<LocalAsrError> for String {
    fn from(e: LocalAsrError) -> Self {
        e.code().to_string()
    }
}
