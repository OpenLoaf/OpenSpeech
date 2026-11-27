use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;
use std::time::Duration;

use serde::Deserialize;
use tauri::ipc::{InvokeBody, Request};
use tauri::{Manager, Webview};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;

const MAX_BYTES: usize = 32 * 1024 * 1024;
const CACHE_EXPIRY: Duration = Duration::from_secs(24 * 60 * 60);
const INVALID_DATA: &str = "MEETING_SUMMARY_COPY_INVALID_DATA";

// Linux serves clipboard data on demand, so keep the clipboard owner alive.
static FILE_CLIPBOARD: Mutex<Option<arboard::Clipboard>> = Mutex::new(None);

enum SummaryFormat {
    Markdown,
    Text,
    Image,
    Pdf,
    Word,
}

impl SummaryFormat {
    fn file_type(&self) -> (&'static str, &'static str) {
        match self {
            Self::Markdown => ("Markdown", "md"),
            Self::Text => ("TXT", "txt"),
            Self::Image => ("PNG", "png"),
            Self::Pdf => ("PDF", "pdf"),
            Self::Word => ("Word", "docx"),
        }
    }
}

fn summary_payload(
    webview: &Webview,
    request: &Request<'_>,
) -> Result<(Vec<u8>, SummaryFormat, String), String> {
    if webview.label() != "main" {
        return Err("MEETING_SUMMARY_COPY_UNAVAILABLE".into());
    }

    let valid_length = |length| (1..=MAX_BYTES).contains(&length);
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) if valid_length(bytes.len()) => bytes.clone(),
        // Tauri's postMessage fallback serializes a raw invocation as a JSON byte array.
        InvokeBody::Json(value)
            if value
                .as_array()
                .is_some_and(|bytes| valid_length(bytes.len())) =>
        {
            Vec::<u8>::deserialize(value).map_err(|_| INVALID_DATA)?
        }
        _ => return Err(INVALID_DATA.into()),
    };
    let format = match request
        .headers()
        .get("x-openspeech-summary-format")
        .map(|value| value.as_bytes())
    {
        Some(b"markdown") if std::str::from_utf8(&bytes).is_ok() => SummaryFormat::Markdown,
        Some(b"txt") if std::str::from_utf8(&bytes).is_ok() => SummaryFormat::Text,
        Some(b"png") if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => SummaryFormat::Image,
        Some(b"pdf") if bytes.starts_with(b"%PDF-") => SummaryFormat::Pdf,
        Some(b"docx") if bytes.starts_with(b"PK\x03\x04") => SummaryFormat::Word,
        _ => return Err(INVALID_DATA.into()),
    };
    let (_, extension) = format.file_type();
    let language = request
        .headers()
        .get("x-openspeech-summary-language")
        .and_then(|value| value.to_str().ok())
        .filter(|language| {
            matches!(
                *language,
                "en" | "zh" | "zh-TW" | "ja" | "ko" | "fr" | "de" | "es"
            )
        });
    let name = match language {
        Some(language) => format!("Meeting summary.{language}.{extension}"),
        None => format!("Meeting summary.{extension}"),
    };
    Ok((bytes, format, name))
}

#[tauri::command]
pub async fn meeting_copy_summary(webview: Webview, request: Request<'_>) -> Result<(), String> {
    let (bytes, format, filename) = summary_payload(&webview, &request)?;
    let app = webview.app_handle().clone();
    run_summary_task("MEETING_SUMMARY_COPY_FAILED", move || {
        match format {
            SummaryFormat::Image => {
                let image = tauri::image::Image::from_bytes(&bytes)?;
                app.clipboard().write_image(&image)?;
            }
            SummaryFormat::Pdf | SummaryFormat::Word => {
                let cache = app
                    .path()
                    .app_cache_dir()?
                    .join("meeting-summary-clipboard");
                copy_document_to_clipboard(&cache, &filename, &bytes)?;
            }
            SummaryFormat::Markdown | SummaryFormat::Text => anyhow::bail!(INVALID_DATA),
        }
        Ok(())
    })
    .await
}

#[tauri::command]
pub async fn meeting_save_summary(webview: Webview, request: Request<'_>) -> Result<bool, String> {
    let (bytes, format, filename) = summary_payload(&webview, &request)?;
    run_summary_task("MEETING_SUMMARY_SAVE_FAILED", move || {
        let (label, extension) = format.file_type();
        let dialog = webview
            .app_handle()
            .dialog()
            .file()
            .set_parent(&webview.window())
            .set_file_name(filename)
            .add_filter(label, &[extension]);
        let Some(selected) = dialog.blocking_save_file() else {
            return Ok(false);
        };
        let path = selected.into_path()?;
        let parent = path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("missing export directory"))?;
        let mut file = tempfile::NamedTempFile::new_in(parent)?;
        file.write_all(&bytes)?;
        file.persist(path)?;
        Ok(true)
    })
    .await
}

async fn run_summary_task<T: Send + 'static>(
    error_code: &'static str,
    operation: impl FnOnce() -> anyhow::Result<T> + Send + 'static,
) -> Result<T, String> {
    match tauri::async_runtime::spawn_blocking(operation).await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => {
            log::warn!("{error_code}: {error}");
            Err(error_code.into())
        }
        Err(error) => {
            log::warn!("{error_code}: {error}");
            Err(error_code.into())
        }
    }
}

fn copy_document_to_clipboard(cache: &Path, filename: &str, bytes: &[u8]) -> anyhow::Result<()> {
    fs::create_dir_all(cache)?;
    let directory = tempfile::Builder::new()
        .prefix("summary-")
        .tempdir_in(cache)?;
    let file = directory.path().join(filename);
    fs::write(&file, bytes)?;

    {
        let mut owner = FILE_CLIPBOARD
            .lock()
            .map_err(|_| anyhow::anyhow!("clipboard lock poisoned"))?;
        if owner.is_none() {
            *owner = Some(arboard::Clipboard::new()?);
        }
        if let Some(clipboard) = owner.as_mut() {
            clipboard.set().file_list(&[file])?;
        }
    }

    // Paste targets open the file after the clipboard write returns, possibly after the app exits.
    let current_directory = directory.keep();
    if let Ok(entries) = fs::read_dir(cache) {
        for entry in entries.flatten() {
            if entry.path() == current_directory
                || !entry.file_name().to_string_lossy().starts_with("summary-")
            {
                continue;
            }
            let expired = entry
                .metadata()
                .and_then(|metadata| metadata.modified())
                .ok()
                .and_then(|modified| modified.elapsed().ok())
                .is_some_and(|age| age > CACHE_EXPIRY);
            if expired {
                let _ = fs::remove_dir_all(entry.path());
            }
        }
    }
    Ok(())
}
