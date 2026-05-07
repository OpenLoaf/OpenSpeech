// 文件转写：把已落盘的录音（OGG / WAV）通过 V4 工具接口重新转成文字。
// 兼用 history 重试 + UTTERANCE 主路径——UTTERANCE 录音结束后直接走这条线。
//
// 接口分流（按时长自动选择，与前端 history 重试流程对接）：
// - ≤ 5 分钟 ⇒ `OL-TL-003` (asrShort)：同步 HTTP，base64 直传，秒级返回。
// - > 5 分钟 ⇒ `OL-TL-004` (asrLong)：base64 直传，服务端自动上传到 DashScope
//   免费 48h 临时 OSS；submit 拿 task_id 后用同一查询接口轮询。history 重试若
//   已有公网 URL 则直接传 URL。
//
// 路径安全：复用 audio 模块的统一校验——只接受
// `recordings/<yyyy-MM-dd>/<id>.ogg`（新版）或 `recordings/<id>.{ogg,wav}`
// （老库），拒绝绝对路径 / 多级嵌套 / `..`，防任意文件读取。

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD as B64;
use openloaf_saas::v4_tools::{
    AsrLongOlTl004Input, AsrLongOlTl004Lang, AsrLongOlTl004Params, AsrLongOlTl004Status,
    AsrShortOlTl003Input, AsrShortOlTl003Params,
};
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::asr::byok::{
    DictationBackend, DictationModality, ERR_BYOK_NOT_IMPLEMENTED, ERR_TENCENT_COS_BUCKET_REQUIRED,
    ProviderMode, ProviderRef, dispatch, provider_kind_str,
};

/// 自定义 provider 没配齐时悄悄回退到 SaaS，前端弹一次性 toast 解释原因。
const EVENT_DICTATION_FALLBACK: &str = "openspeech://dictation-fallback";
use crate::asr::aliyun::file::{
    DashScopeClient, FileTransError, ReqwestDashScopeClient, TokioSleeper as AliyunSleeper,
    merge_transcripts_payload, poll_task_until_terminal,
};
use crate::asr::aliyun::oss_upload::{
    BailianOssClient, OssUploadError, ReqwestBailianOssClient,
};
use crate::asr::tencent::cos::{CosClient, CosError};
use crate::asr::tencent::file::{
    CreateRecTaskRequest, ReqwestHttp, TencentFileError, TokioSleeper, merge_result_detail,
    poll_until_terminal, submit_create_task,
};
use crate::audio;
use crate::db;
use crate::openloaf::{SharedOpenLoaf, handle_session_expired};

const ERR_UNAUTHORIZED: &str = "unauthorized";
const ERR_NOT_AUTHENTICATED: &str = "not authenticated";

fn is_unauthorized(msg: &str) -> bool {
    msg.contains("401") || msg.contains("Unauthorized") || msg.contains("unauthorized")
}

const SHORT_AUDIO_LIMIT_MS: u64 = 5 * 60 * 1000;
const LONG_POLL_INTERVAL_MS: u64 = 4_000;
const LONG_POLL_MAX_TRIES: u32 = 360; // 4s × 360 ≈ 24 min；够覆盖大多数场景，超时让前端报错。
// SDK 用 ureq Agent 但没设 read timeout（见 openloaf-saas client.rs），
// 服务端 hang 时会无限挂——这里用 tokio timeout 把 caller 拽回来；spawn_blocking
// 内部线程没法取消，会泄漏到 socket 自然死，但 UI 至少能退出 transcribing 态。
const ASR_SHORT_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
pub const ERR_TRANSCRIBE_TIMEOUT: &str = "transcribe_timeout";

#[derive(Debug, serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TranscribeFileResult {
    pub text: String,
    /// 实际命中的接口（"asrShort" / "asrLong"）。前端可用于显示来源 / 计费提示。
    pub variant: String,
    pub credits_consumed: f64,
    /// 实际承载本次转写的 vendor + 通道（与 history.provider_kind 列对齐）。
    pub provider_kind: String,
}

fn read_recording_bytes<R: Runtime>(
    app: &AppHandle<R>,
    audio_path: &str,
) -> Result<Vec<u8>, String> {
    let sub = audio::validated_recording_subpath(audio_path)?;
    let abs = db::recordings_dir(app)?.join(sub);
    std::fs::read(&abs).map_err(|e| format!("read {}: {e}", abs.display()))
}

/// 根据 audio_path 后缀决定 base64 上传时的 media_type。
fn media_type_for(audio_path: &str) -> &'static str {
    if audio_path.to_ascii_lowercase().ends_with(".ogg") {
        "audio/ogg"
    } else {
        "audio/wav"
    }
}

fn parse_lang_short(lang: Option<&str>) -> Option<String> {
    let s = lang?.trim().to_ascii_lowercase();
    if s.is_empty() || s == "auto" {
        return None;
    }
    Some(match s.as_str() {
        "zh-cn" | "zh-tw" => "zh".into(),
        x if x.starts_with("en-") => "en".into(),
        _ => s,
    })
}

fn parse_lang_long(lang: Option<&str>) -> Option<AsrLongOlTl004Lang> {
    let s = lang?.trim().to_ascii_lowercase();
    if s.is_empty() {
        return None;
    }
    Some(match s.as_str() {
        "auto" => AsrLongOlTl004Lang::Auto,
        "zh" | "zh-cn" | "zh-tw" => AsrLongOlTl004Lang::Zh,
        x if x == "en" || x.starts_with("en-") => AsrLongOlTl004Lang::En,
        "ja" => AsrLongOlTl004Lang::Ja,
        "ko" => AsrLongOlTl004Lang::Ko,
        "yue" => AsrLongOlTl004Lang::Yue,
        "fr" => AsrLongOlTl004Lang::Fr,
        "de" => AsrLongOlTl004Lang::De,
        "ru" => AsrLongOlTl004Lang::Ru,
        "es" => AsrLongOlTl004Lang::Es,
        "pt" => AsrLongOlTl004Lang::Pt,
        "ar" => AsrLongOlTl004Lang::Ar,
        "it" => AsrLongOlTl004Lang::It,
        _ => AsrLongOlTl004Lang::Auto,
    })
}

fn default_saas_provider_ref() -> ProviderRef {
    ProviderRef {
        mode: ProviderMode::Saas,
        active_custom_provider_id: None,
        custom_provider_vendor: None,
        tencent_app_id: None,
        tencent_region: None,
        tencent_cos_bucket: None,
        custom_provider_name: None,
    }
}

/// 截取 system_prompt 的前 N 字（按 char）做日志预览。换行替成 ⏎ 让一行能看清结构。
fn system_prompt_preview(s: &str, max_chars: usize) -> String {
    let mut buf = String::with_capacity(max_chars * 4);
    for ch in s.chars().take(max_chars) {
        if ch == '\n' {
            buf.push_str("⏎");
        } else if ch == '\r' {
            // skip
        } else {
            buf.push(ch);
        }
    }
    buf
}

#[tauri::command]
pub async fn transcribe_recording_file<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    duration_ms: u64,
    lang: Option<String>,
    provider: Option<ProviderRef>,
    system_prompt: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let provider_ref = provider.unwrap_or_else(default_saas_provider_ref);
    let backend = match dispatch(&provider_ref, DictationModality::File) {
        Ok(b) => b,
        Err(e) if e.should_fallback_to_saas() => {
            log::warn!(
                "[transcribe] backend dispatch fallback to SaaS: {e} (custom provider not configured)"
            );
            let _ = app.emit(
                EVENT_DICTATION_FALLBACK,
                serde_json::json!({ "reason": "provider_not_configured" }),
            );
            dispatch(&default_saas_provider_ref(), DictationModality::File).map_err(|e2| {
                log::warn!("[transcribe] saas fallback dispatch failed: {e2}");
                e2.code().to_string()
            })?
        }
        Err(e) => {
            log::warn!("[transcribe] backend dispatch failed: {e}");
            return Err(e.code().to_string());
        }
    };

    let kind = provider_kind_str(&backend).to_string();
    log::info!(
        "[transcribe] dispatch → provider_kind={kind} audio={audio_path} duration_ms={duration_ms}"
    );
    let system_prompt = system_prompt.and_then(|s| {
        let trimmed = s.trim();
        if trimmed.is_empty() { None } else { Some(s) }
    });
    match backend {
        DictationBackend::SaasFile => {
            transcribe_recording_file_impl_async(
                app,
                audio_path,
                duration_ms,
                lang,
                kind,
                system_prompt,
            )
            .await
        }
        DictationBackend::TencentFile {
            app_id,
            secret_id,
            secret_key,
            region,
            cos_bucket,
            name,
        } => {
            if let Some(ref sp) = system_prompt {
                log::warn!(
                    "[transcribe] tencent file ignores system_prompt (chars={})",
                    sp.chars().count(),
                );
            }
            let bucket = cos_bucket
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| ERR_TENCENT_COS_BUCKET_REQUIRED.to_string())?
                .to_string();
            let bytes = read_recording_bytes(&app, &audio_path)?;
            log::info!(
                "[transcribe] tencent file vendor=tencent name={name} bucket={bucket} region={region} engine={}",
                tencent_engine_for(lang.as_deref()),
            );
            log::debug!(
                "[transcribe] tencent file params app_id={app_id} bytes_len={} lang={:?} audio_path={audio_path}",
                bytes.len(),
                lang
            );
            transcribe_tencent_file_via_cos(
                bytes,
                &audio_path,
                lang,
                &secret_id,
                &secret_key,
                &region,
                &bucket,
            )
            .await
            .map(|text| TranscribeFileResult {
                text,
                variant: "tencentFile".into(),
                credits_consumed: 0.0,
                provider_kind: kind,
            })
            .map_err(|e| e.to_string())
        }
        DictationBackend::AliyunFile { api_key, name } => {
            if let Some(ref sp) = system_prompt {
                log::warn!(
                    "[transcribe] aliyun file ignores system_prompt (chars={})",
                    sp.chars().count(),
                );
            }
            let bytes = read_recording_bytes(&app, &audio_path)?;
            log::info!(
                "[transcribe] aliyun file vendor=aliyun name={name} model=paraformer-v2 lang={:?}",
                lang
            );
            log::debug!(
                "[transcribe] aliyun file params bytes_len={} audio_path={audio_path}",
                bytes.len()
            );
            transcribe_aliyun_file(bytes, &audio_path, lang.as_deref(), &api_key)
                .await
                .map(|text| TranscribeFileResult {
                    text,
                    variant: "aliyunFile".into(),
                    credits_consumed: 0.0,
                    provider_kind: kind,
                })
                .map_err(|e| e.to_string())
        }
        other => {
            log::error!("[transcribe] dispatch returned unexpected backend for file: {other:?}");
            Err(ERR_BYOK_NOT_IMPLEMENTED.to_string())
        }
    }
}

const TENCENT_POLL_INTERVAL: Duration = Duration::from_secs(2);
const TENCENT_POLL_DEADLINE: Duration = Duration::from_secs(24 * 60);

/// 走 COS 公网 URL 时的 ASR 上限：腾讯实际接受 ≤512MB 音频，COS 物理桶上限 5GB。
/// 用 ASR 限制兜底，避免无谓上传。
const TENCENT_URL_MAX_BYTES: u64 = 512 * 1024 * 1024;
/// 预签名 URL TTL：1 小时够腾讯异步任务跑完（任务平均 1-3 分钟）。
const COS_PRESIGN_TTL_SECS: u64 = 3600;

fn tencent_engine_for(lang: Option<&str>) -> &'static str {
    match lang.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("en") | Some("en-us") | Some("en-gb") => "16k_en",
        Some("yue") => "16k_yue",
        Some("ja") => "16k_ja",
        Some("ko") => "16k_ko",
        _ => "16k_zh",
    }
}

/// 错误归一：COS 上传失败 → tencent_cos_*；ASR 调用失败 → tencent_*。
/// 前端 humanizeSttError 按 Display 字符串前缀路由。
#[derive(Debug)]
enum TencentCosFileError {
    Cos(CosError),
    File(TencentFileError),
}

impl std::fmt::Display for TencentCosFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TencentCosFileError::Cos(e) => write!(f, "{e}"),
            TencentCosFileError::File(e) => write!(f, "{e}"),
        }
    }
}

impl From<CosError> for TencentCosFileError {
    fn from(e: CosError) -> Self {
        TencentCosFileError::Cos(e)
    }
}

impl From<TencentFileError> for TencentCosFileError {
    fn from(e: TencentFileError) -> Self {
        TencentCosFileError::File(e)
    }
}

fn cos_object_key_for(audio_path: &str) -> String {
    let ext = std::path::Path::new(audio_path)
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_else(|| "wav".into());
    format!("openspeech-recordings/{}.{ext}", uuid::Uuid::new_v4())
}

fn cos_content_type_for(audio_path: &str) -> &'static str {
    if audio_path.to_ascii_lowercase().ends_with(".ogg") {
        "audio/ogg"
    } else {
        "audio/wav"
    }
}

async fn transcribe_tencent_file_via_cos(
    bytes: Vec<u8>,
    audio_path: &str,
    lang: Option<String>,
    secret_id: &str,
    secret_key: &str,
    region: &str,
    bucket: &str,
) -> Result<String, TencentCosFileError> {
    let actual_len = bytes.len() as u64;
    if actual_len > TENCENT_URL_MAX_BYTES {
        return Err(TencentCosFileError::File(TencentFileError::FileTooLarge {
            actual_bytes: actual_len,
        }));
    }
    let region_str = if region.trim().is_empty() {
        "ap-shanghai"
    } else {
        region
    };
    let cos = CosClient::new(region_str, bucket, secret_id, secret_key)?;
    let key = cos_object_key_for(audio_path);
    cos.put_object(&key, bytes, cos_content_type_for(audio_path))
        .await?;
    log::info!("[transcribe] tencent COS uploaded key={key} bucket={bucket} region={region_str}");
    let url = cos.presigned_get_url(&key, COS_PRESIGN_TTL_SECS)?;
    log::debug!("[transcribe] tencent COS presigned url={url} ttl_secs={COS_PRESIGN_TTL_SECS}");

    let req = CreateRecTaskRequest::new_url(url).engine(tencent_engine_for(lang.as_deref()));
    let region_opt = Some(region_str);
    let http = ReqwestHttp::new()?;
    let sleeper = TokioSleeper;
    let task_id = submit_create_task(&http, secret_id, secret_key, region_opt, &req).await?;
    log::info!("[transcribe] tencent CreateRecTask (URL) submitted task_id={task_id}");
    let deadline = Instant::now() + TENCENT_POLL_DEADLINE;
    let resp = poll_until_terminal(
        &http,
        &sleeper,
        secret_id,
        secret_key,
        region_opt,
        task_id,
        TENCENT_POLL_INTERVAL,
        deadline,
    )
    .await;

    // 任务结束后无论成败都尝试清理 COS 上的临时对象，best-effort（失败只 warn）。
    cos.delete_object_best_effort(&key).await;

    let resp = resp?;
    let data = resp
        .response
        .data
        .ok_or_else(|| TencentFileError::TaskFailed {
            msg: "DescribeTaskStatus returned no Data on success".into(),
        })?;
    let text = merge_result_detail(&data.result_detail);
    if text.is_empty() {
        Ok(strip_tencent_timestamps(&data.result))
    } else {
        Ok(text)
    }
}

// ─── 阿里 DashScope filetrans ───────────────────────────────────

const ALIYUN_POLL_INTERVAL: Duration = Duration::from_secs(3);
const ALIYUN_POLL_DEADLINE: Duration = Duration::from_secs(24 * 60);

/// 错误归一：把 OSS / filetrans 两条错误链路合到 String，前端 humanizeSttError 按
/// `aliyun_*` 前缀路由文案。
#[derive(Debug)]
enum AliyunFileError {
    Oss(OssUploadError),
    Trans(FileTransError),
}

impl std::fmt::Display for AliyunFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AliyunFileError::Oss(e) => write!(f, "{e}"),
            AliyunFileError::Trans(e) => write!(f, "{e}"),
        }
    }
}

impl From<OssUploadError> for AliyunFileError {
    fn from(e: OssUploadError) -> Self {
        AliyunFileError::Oss(e)
    }
}

impl From<FileTransError> for AliyunFileError {
    fn from(e: FileTransError) -> Self {
        AliyunFileError::Trans(e)
    }
}

/// 把前端送来的 ISO code 翻译成 paraformer-v2 的 language_hints。
/// auto / 不识别 → 空（让模型自检），其它一一对应。
fn aliyun_language_hints(lang: Option<&str>) -> Vec<String> {
    match lang.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("zh") => vec!["zh".into()],
        Some("en") | Some("en-us") | Some("en-gb") => vec!["en".into()],
        Some("ja") => vec!["ja".into()],
        Some("ko") => vec!["ko".into()],
        Some("yue") => vec!["yue".into()],
        _ => Vec::new(),
    }
}

fn aliyun_file_name_for(audio_path: &str) -> String {
    let stem = std::path::Path::new(audio_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("recording.wav")
        .to_string();
    if stem.is_empty() { "recording.wav".into() } else { stem }
}

async fn transcribe_aliyun_file(
    bytes: Vec<u8>,
    audio_path: &str,
    lang: Option<&str>,
    api_key: &str,
) -> Result<String, AliyunFileError> {
    let oss = ReqwestBailianOssClient::new()?;
    let scope = ReqwestDashScopeClient::new()?;
    transcribe_aliyun_file_with(&oss, &scope, &AliyunSleeper, bytes, audio_path, lang, api_key)
        .await
}

async fn transcribe_aliyun_file_with(
    oss: &dyn BailianOssClient,
    scope: &dyn DashScopeClient,
    sleeper: &dyn crate::asr::aliyun::file::Sleeper,
    bytes: Vec<u8>,
    audio_path: &str,
    lang: Option<&str>,
    api_key: &str,
) -> Result<String, AliyunFileError> {
    let file_name = aliyun_file_name_for(audio_path);

    // 上传：第一次 PolicyExpired 重新 get_policy 一次再试。
    let oss_url = match upload_with_retry(oss, api_key, &file_name, bytes).await {
        Ok(u) => u,
        Err(e) => return Err(e.into()),
    };
    log::info!("[transcribe] aliyun OSS uploaded: {oss_url}");

    // paraformer-v2 接受 language_hints；auto / 空表示不约束，让上游自检。
    let language_hints = aliyun_language_hints(lang);
    let task_id = scope
        .submit_filetrans(api_key, &[oss_url], &language_hints)
        .await
        .map_err(AliyunFileError::Trans)?;
    log::info!("[transcribe] aliyun filetrans submitted task_id={task_id}");
    let deadline = Instant::now() + ALIYUN_POLL_DEADLINE;
    let out = poll_task_until_terminal(
        scope,
        sleeper,
        api_key,
        &task_id,
        ALIYUN_POLL_INTERVAL,
        deadline,
    )
    .await
    .map_err(AliyunFileError::Trans)?;

    // paraformer-v2 真正的转写文本不在 results[*].transcription（永远是空），
    // 而在 results[*].transcription_url 指向的 OSS 临时签名 URL 里。逐个 fetch 再
    // 拼起来，是 BYOK 这条线唯一能拿到正文的路径。
    let mut payloads = Vec::with_capacity(out.results.len());
    for r in &out.results {
        let Some(url) = r.transcription_url.as_deref() else {
            continue;
        };
        if url.is_empty() {
            continue;
        }
        let payload = scope
            .fetch_transcription(url)
            .await
            .map_err(AliyunFileError::Trans)?;
        payloads.push(payload);
    }
    Ok(merge_transcripts_payload(&payloads))
}

async fn upload_with_retry(
    oss: &dyn BailianOssClient,
    api_key: &str,
    file_name: &str,
    bytes: Vec<u8>,
) -> Result<String, OssUploadError> {
    let policy = oss.get_policy(api_key).await?;
    // 文件大小护栏：policy 给 max_file_size_mb（默认 100MB），超限不上传直接报错。
    let actual = bytes.len() as u64;
    let max = policy.max_bytes();
    if actual > max {
        return Err(OssUploadError::FileTooLarge {
            actual_bytes: actual,
            max_bytes: max,
        });
    }
    match oss.upload_file(&policy, file_name, bytes.clone()).await {
        Ok(url) => Ok(url),
        Err(OssUploadError::PolicyExpired) => {
            log::warn!("[transcribe] aliyun OSS policy expired; refreshing and retrying once");
            let policy2 = oss.get_policy(api_key).await?;
            oss.upload_file(&policy2, file_name, bytes).await
        }
        Err(other) => Err(other),
    }
}

/// 把 `[0:0.020,0:2.380]  腾讯云语音识别欢迎您。\n` 这种带时间戳前缀 + 行尾换行的
/// 整段 Result 文本剥成纯文本。`ResultDetail` 为空时才走这条兜底。
fn strip_tencent_timestamps(raw: &str) -> String {
    raw.lines()
        .map(|line| {
            let line = line.trim_end();
            match (line.find('['), line.find(']')) {
                (Some(0), Some(close)) => line[close + 1..].trim_start().to_string(),
                _ => line.to_string(),
            }
        })
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("")
}

async fn transcribe_recording_file_impl_async<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    duration_ms: u64,
    lang: Option<String>,
    provider_kind: String,
    system_prompt: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let ol: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();

    // B：发请求前先确保 access_token 还没过期。唤醒场景必备——睡眠期间 refresh 定时器
    // 没机会跑，醒来第一次调如果不预检就一定 401，会把用户当登录失效踢出去。
    if !ol.ensure_access_token_fresh().await {
        log::warn!("[transcribe] saas preflight refresh failed; signaling auth-lost");
        handle_session_expired(&app, &ol);
        return Err(ERR_NOT_AUTHENTICATED.to_string());
    }

    let bytes = read_recording_bytes(&app, &audio_path)?;
    let b64 = B64.encode(&bytes);
    let media_type = media_type_for(&audio_path);

    if duration_ms > SHORT_AUDIO_LIMIT_MS {
        if let Some(ref sp) = system_prompt {
            log::warn!(
                "[transcribe] asr_long (OL-TL-004) ignores system_prompt (chars={}); only OL-TL-003 short path supports it",
                sp.chars().count(),
            );
        }
        let lang_long = parse_lang_long(lang.as_deref());
        return tauri::async_runtime::spawn_blocking(move || {
            let input = AsrLongOlTl004Input::from_base64(b64, Some(media_type));
            run_asr_long_blocking(app, input, lang_long, provider_kind)
        })
        .await
        .map_err(|e| format!("transcribe join: {e}"))?;
    }

    let lang_short = parse_lang_short(lang.as_deref());

    // 第一次尝试。spawn_blocking 包同步 SDK 调用，避免阻塞 tauri 主异步执行器。
    match run_asr_short_blocking(
        &ol,
        &b64,
        media_type,
        lang_short.clone(),
        system_prompt.clone(),
    )
    .await?
    {
        AsrShortAttempt::Ok(r) => Ok(TranscribeFileResult {
            text: r.data.text,
            variant: "asrShort".into(),
            credits_consumed: r.credits_consumed,
            provider_kind,
        }),
        AsrShortAttempt::Unauthorized(raw) => {
            // C：401 → 续期一次再重试一次；续期失败 / 重试还 401 才清场。
            log::warn!("[transcribe] asr_short hit 401; attempting refresh + retry. raw={raw}");
            if !ol.ensure_fresh_token().await {
                log::warn!("[transcribe] refresh failed; signaling auth-lost");
                handle_session_expired(&app, &ol);
                return Err(ERR_UNAUTHORIZED.to_string());
            }
            match run_asr_short_blocking(&ol, &b64, media_type, lang_short, system_prompt).await? {
                AsrShortAttempt::Ok(r) => {
                    log::info!("[transcribe] asr_short retry after refresh succeeded");
                    Ok(TranscribeFileResult {
                        text: r.data.text,
                        variant: "asrShort".into(),
                        credits_consumed: r.credits_consumed,
                        provider_kind,
                    })
                }
                AsrShortAttempt::Unauthorized(raw2) => {
                    log::warn!(
                        "[transcribe] asr_short retry still 401 after refresh; clearing session. raw={raw2}"
                    );
                    handle_session_expired(&app, &ol);
                    Err(ERR_UNAUTHORIZED.to_string())
                }
                AsrShortAttempt::Other(raw2) => Err(format!("asr_short failed: {raw2}")),
            }
        }
        AsrShortAttempt::Other(raw) => Err(format!("asr_short failed: {raw}")),
    }
}

enum AsrShortAttempt {
    Ok(openloaf_saas::v4_tools::AsrShortOlTl003Result),
    Unauthorized(String),
    Other(String),
}

async fn run_asr_short_blocking(
    ol: &SharedOpenLoaf,
    b64: &str,
    media_type: &'static str,
    lang_short: Option<String>,
    system_prompt: Option<String>,
) -> Result<AsrShortAttempt, String> {
    let client = ol.authenticated_client().ok_or_else(|| {
        log::warn!("[transcribe] authenticated_client() returned None right before dispatch");
        ERR_NOT_AUTHENTICATED.to_string()
    })?;
    let b64_owned = b64.to_string();
    match system_prompt.as_deref() {
        Some(sp) => {
            let chars = sp.chars().count();
            let bytes = sp.len();
            let lines = sp.lines().count();
            let preview = system_prompt_preview(sp, 200);
            log::info!(
                "[transcribe] asr_short with system_prompt: chars={chars} bytes={bytes} lines={lines} lang={lang_short:?} preview={preview:?}"
            );
            // dev/debug 等级才输出全文，避免线上日志被几千字提示词刷屏。
            log::debug!(
                "[transcribe] asr_short system_prompt full body ({chars} chars):\n{sp}"
            );
            if chars > 2000 {
                log::warn!(
                    "[transcribe] asr_short system_prompt chars={chars} exceeds the SDK-recommended 2000-char soft limit; upstream may truncate or refuse"
                );
            }
        }
        None => {
            log::info!(
                "[transcribe] asr_short without system_prompt lang={lang_short:?}"
            );
        }
    }
    let task = tokio::task::spawn_blocking(move || {
        let input = AsrShortOlTl003Input::from_base64(b64_owned, media_type);
        let params = AsrShortOlTl003Params {
            language: lang_short,
            enable_itn: Some(true),
            system_prompt,
        };
        client.tools_v4().asr_short_ol_tl_003(&input, &params)
    });
    let join = match tokio::time::timeout(ASR_SHORT_REQUEST_TIMEOUT, task).await {
        Ok(j) => j.map_err(|e| format!("transcribe join: {e}"))?,
        Err(_) => {
            log::warn!(
                "[transcribe] asr_short timed out after {}s; SDK has no read timeout, blocking thread leaks until socket dies",
                ASR_SHORT_REQUEST_TIMEOUT.as_secs()
            );
            return Err(ERR_TRANSCRIBE_TIMEOUT.to_string());
        }
    };
    Ok(match join {
        Ok(r) => AsrShortAttempt::Ok(r),
        Err(e) => {
            let raw = e.to_string();
            if is_unauthorized(&raw) {
                AsrShortAttempt::Unauthorized(raw)
            } else {
                AsrShortAttempt::Other(raw)
            }
        }
    })
}

#[tauri::command]
pub async fn transcribe_long_audio_url<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    // 先在异步上下文里做 B 预检，再把同步 SDK polling 逻辑扔进 spawn_blocking。
    // polling 循环时间很长（最多 24 min），靠预检保证 submit 那一发不会因为
    // 唤醒后 token 已过期直接被踢出去。polling 期间 401 仍走原路径清场——这种
    // 场景概率极小（24 min 内 token 剩余寿命够用），且需要中断 thread::sleep
    // 才能 await refresh，改造成本不划算。
    let ol: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();
    if !ol.ensure_access_token_fresh().await {
        log::warn!("[transcribe] long audio preflight refresh failed; signaling auth-lost");
        handle_session_expired(&app, &ol);
        return Err(ERR_NOT_AUTHENTICATED.to_string());
    }
    tauri::async_runtime::spawn_blocking(move || transcribe_long_audio_url_impl(app, url, lang))
        .await
        .map_err(|e| format!("transcribe long join: {e}"))?
}

fn transcribe_long_audio_url_impl<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let input = AsrLongOlTl004Input::from_url(url);
    let lang_long = parse_lang_long(lang.as_deref());
    run_asr_long_blocking(app, input, lang_long, "saas-file".into())
}

fn run_asr_long_blocking<R: Runtime>(
    app: AppHandle<R>,
    input: AsrLongOlTl004Input,
    lang: Option<AsrLongOlTl004Lang>,
    provider_kind: String,
) -> Result<TranscribeFileResult, String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    let params = AsrLongOlTl004Params {
        language: lang,
        enable_words: Some(false),
        enable_itn: Some(true),
        disfluency_removal_enabled: Some(true),
        ..Default::default()
    };
    let submitted = client
        .tools_v4()
        .asr_long_ol_tl_004(&input, &params)
        .map_err(|e| {
            let raw = e.to_string();
            if is_unauthorized(&raw) {
                handle_session_expired(&app, &ol);
                ERR_UNAUTHORIZED.to_string()
            } else {
                format!("asr_long submit failed: {e}")
            }
        })?;

    for _ in 0..LONG_POLL_MAX_TRIES {
        thread::sleep(Duration::from_millis(LONG_POLL_INTERVAL_MS));
        let r = client
            .tools_v4()
            .asr_long_ol_tl_004_task(&submitted.task_id)
            .map_err(|e| {
                let raw = e.to_string();
                if is_unauthorized(&raw) {
                    handle_session_expired(&app, &ol);
                    ERR_UNAUTHORIZED.to_string()
                } else {
                    format!("asr_long poll failed: {e}")
                }
            })?;
        match r.status {
            AsrLongOlTl004Status::Success => {
                return Ok(TranscribeFileResult {
                    text: r.text.unwrap_or_default(),
                    variant: "asrLong".into(),
                    credits_consumed: r.credits_consumed.unwrap_or(0.0),
                    provider_kind,
                });
            }
            AsrLongOlTl004Status::Failed => {
                let msg = r.error.and_then(|e| e.message).unwrap_or_default();
                return Err(format!("asr_long failed: {msg}"));
            }
            AsrLongOlTl004Status::Pending | AsrLongOlTl004Status::Doing => continue,
        }
    }
    Err("asr_long poll timeout".into())
}

#[cfg(test)]
mod tencent_tests {
    use crate::asr::byok::ERR_TENCENT_COS_BUCKET_REQUIRED;

    #[test]
    fn cos_bucket_required_constant_value_is_stable() {
        assert_eq!(ERR_TENCENT_COS_BUCKET_REQUIRED, "tencent_cos_bucket_required");
    }

    #[test]
    fn empty_or_whitespace_bucket_filtered_out() {
        let cases: Vec<Option<String>> = vec![None, Some(String::new()), Some("   ".into())];
        for c in cases {
            let bucket = c
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            assert!(bucket.is_none(), "expected None for {c:?}");
        }
        let ok = Some(" my-bucket ".to_string());
        let bucket = ok.as_deref().map(str::trim).filter(|s| !s.is_empty());
        assert_eq!(bucket, Some("my-bucket"));
    }
}

#[cfg(test)]
mod aliyun_tests {
    use super::*;
    use crate::asr::aliyun::file::{
        DashScopeClient, FileTransError, Sleeper as AliyunPollSleeper, TaskOutput, TaskResult,
        TranscriptEntry, TranscriptionPayload,
    };
    use crate::asr::aliyun::oss_upload::{
        BailianOssClient, OssUploadError, UploadPolicy, UploadPolicyEnvelope,
    };
    use std::sync::Mutex;

    fn sample_policy() -> UploadPolicy {
        let raw = r#"{
            "data": {
                "policy": "POL", "signature": "SIG",
                "upload_dir": "tmp/abc",
                "upload_host": "https://dashscope-instant.oss-cn-beijing.aliyuncs.com",
                "expire_in_seconds": 172800, "max_file_size_mb": 100,
                "capacity_limit_mb": 500, "oss_access_key_id": "AK",
                "x_oss_object_acl": "private", "x_oss_forbid_overwrite": "true"
            }, "request_id": "r"
        }"#;
        serde_json::from_str::<UploadPolicyEnvelope>(raw).unwrap().data
    }

    enum OssOp {
        Policy(Result<UploadPolicy, OssUploadError>),
        Upload(Result<String, OssUploadError>),
    }

    struct MockOss {
        ops: Mutex<Vec<OssOp>>,
        captured: Mutex<Vec<String>>,
    }
    impl MockOss {
        fn new(ops: Vec<OssOp>) -> Self {
            Self { ops: Mutex::new(ops), captured: Mutex::new(Vec::new()) }
        }
        fn pop(&self) -> OssOp {
            let mut q = self.ops.lock().unwrap();
            assert!(!q.is_empty(), "mock oss exhausted");
            q.remove(0)
        }
    }
    #[async_trait::async_trait]
    impl BailianOssClient for MockOss {
        async fn get_policy(&self, _api_key: &str) -> Result<UploadPolicy, OssUploadError> {
            self.captured.lock().unwrap().push("get_policy".into());
            match self.pop() {
                OssOp::Policy(r) => r,
                OssOp::Upload(_) => panic!("expected Policy op"),
            }
        }
        async fn upload_file(
            &self,
            _policy: &UploadPolicy,
            file_name: &str,
            _bytes: Vec<u8>,
        ) -> Result<String, OssUploadError> {
            self.captured.lock().unwrap().push(format!("upload:{file_name}"));
            match self.pop() {
                OssOp::Upload(r) => r,
                OssOp::Policy(_) => panic!("expected Upload op"),
            }
        }
    }

    enum ScopeOp {
        Submit(Result<String, FileTransError>),
        Query(Result<TaskOutput, FileTransError>),
        FetchTranscription(Result<TranscriptionPayload, FileTransError>),
    }
    struct MockScope {
        ops: Mutex<Vec<ScopeOp>>,
        captured: Mutex<Vec<String>>,
    }
    impl MockScope {
        fn new(ops: Vec<ScopeOp>) -> Self {
            Self { ops: Mutex::new(ops), captured: Mutex::new(Vec::new()) }
        }
        fn pop(&self) -> ScopeOp {
            let mut q = self.ops.lock().unwrap();
            assert!(!q.is_empty(), "mock scope exhausted");
            q.remove(0)
        }
    }
    #[async_trait::async_trait]
    impl DashScopeClient for MockScope {
        async fn submit_filetrans(
            &self,
            _api_key: &str,
            oss_urls: &[String],
            language_hints: &[String],
        ) -> Result<String, FileTransError> {
            self.captured.lock().unwrap().push(format!(
                "submit:{}|hints:{}",
                oss_urls.join(","),
                language_hints.join(",")
            ));
            match self.pop() {
                ScopeOp::Submit(r) => r,
                _ => panic!("expected Submit op"),
            }
        }
        async fn query_task(
            &self,
            _api_key: &str,
            task_id: &str,
        ) -> Result<TaskOutput, FileTransError> {
            self.captured.lock().unwrap().push(format!("query:{task_id}"));
            match self.pop() {
                ScopeOp::Query(r) => r,
                _ => panic!("expected Query op"),
            }
        }
        async fn fetch_transcription(
            &self,
            url: &str,
        ) -> Result<TranscriptionPayload, FileTransError> {
            self.captured.lock().unwrap().push(format!("fetch:{url}"));
            match self.pop() {
                ScopeOp::FetchTranscription(r) => r,
                _ => panic!("expected FetchTranscription op"),
            }
        }
    }

    struct ZeroSleeper;
    #[async_trait::async_trait]
    impl AliyunPollSleeper for ZeroSleeper {
        async fn sleep(&self, _: Duration) {}
    }

    fn task_done(text: &str) -> TaskOutput {
        let _ = text; // 文字交给 fetch_transcription mock，task_done 只代表 SUCCEEDED 信号
        TaskOutput {
            task_id: "t-1".into(),
            task_status: "SUCCEEDED".into(),
            results: vec![TaskResult {
                file_url: None,
                subtask_status: Some("SUCCEEDED".into()),
                transcription: None,
                transcription_url: Some("https://oss/result.json".into()),
                code: None,
                message: None,
            }],
            code: None,
            message: None,
        }
    }

    fn transcript_payload(text: &str) -> TranscriptionPayload {
        TranscriptionPayload {
            transcripts: vec![TranscriptEntry { text: text.into() }],
        }
    }

    #[tokio::test]
    async fn aliyun_happy_path_uploads_then_polls_to_text() {
        let oss = MockOss::new(vec![
            OssOp::Policy(Ok(sample_policy())),
            OssOp::Upload(Ok("oss://dashscope-instant/tmp/abc/audio.wav".into())),
        ]);
        let scope = MockScope::new(vec![
            ScopeOp::Submit(Ok("t-1".into())),
            ScopeOp::Query(Ok(task_done("你好世界"))),
            ScopeOp::FetchTranscription(Ok(transcript_payload("你好世界"))),
        ]);
        let text = transcribe_aliyun_file_with(
            &oss,
            &scope,
            &ZeroSleeper,
            vec![1, 2, 3],
            "recordings/2026-05-04/audio.wav",
            None,
            "ak",
        )
        .await
        .unwrap();
        assert_eq!(text, "你好世界");
    }

    #[tokio::test]
    async fn aliyun_policy_expired_triggers_one_retry() {
        let oss = MockOss::new(vec![
            OssOp::Policy(Ok(sample_policy())),
            OssOp::Upload(Err(OssUploadError::PolicyExpired)),
            OssOp::Policy(Ok(sample_policy())),
            OssOp::Upload(Ok("oss://dashscope-instant/tmp/abc/audio.wav".into())),
        ]);
        let scope = MockScope::new(vec![
            ScopeOp::Submit(Ok("t-1".into())),
            ScopeOp::Query(Ok(task_done("ok"))),
            ScopeOp::FetchTranscription(Ok(transcript_payload("ok"))),
        ]);
        let text = transcribe_aliyun_file_with(
            &oss,
            &scope,
            &ZeroSleeper,
            vec![1, 2, 3],
            "audio.wav",
            None,
            "ak",
        )
        .await
        .unwrap();
        assert_eq!(text, "ok");
        // get_policy 被调用两次（首次 + 过期重试）
        let cap = oss.captured.lock().unwrap().clone();
        assert_eq!(cap.iter().filter(|c| *c == "get_policy").count(), 2);
    }

    #[tokio::test]
    async fn aliyun_file_too_large_short_circuits_before_upload() {
        // 小 policy 上限触发护栏：bytes.len() > max_bytes
        let mut p = sample_policy();
        p.max_file_size_mb = 1; // 1 MB
        let oss = MockOss::new(vec![OssOp::Policy(Ok(p))]);
        let scope = MockScope::new(vec![]);
        let big = vec![0u8; 2 * 1024 * 1024]; // 2 MB > 1 MB
        let err = transcribe_aliyun_file_with(
            &oss,
            &scope,
            &ZeroSleeper,
            big,
            "audio.wav",
            None,
            "ak",
        )
        .await
        .unwrap_err();
        let s = err.to_string();
        assert!(s.contains("aliyun_file_too_large"), "got {s}");
    }

    #[tokio::test]
    async fn aliyun_filetrans_submit_unauthenticated_propagates() {
        let oss = MockOss::new(vec![
            OssOp::Policy(Ok(sample_policy())),
            OssOp::Upload(Ok("oss://b/k".into())),
        ]);
        let scope = MockScope::new(vec![ScopeOp::Submit(Err(
            FileTransError::Unauthenticated("HTTP 401".into()),
        ))]);
        let err = transcribe_aliyun_file_with(
            &oss,
            &scope,
            &ZeroSleeper,
            vec![1, 2, 3],
            "audio.wav",
            None,
            "ak",
        )
        .await
        .unwrap_err();
        let s = err.to_string();
        assert!(s.contains("aliyun_unauthenticated"), "got {s}");
    }

    #[tokio::test]
    async fn aliyun_filetrans_task_failed_propagates_msg() {
        let oss = MockOss::new(vec![
            OssOp::Policy(Ok(sample_policy())),
            OssOp::Upload(Ok("oss://b/k".into())),
        ]);
        let mut bad = TaskOutput {
            task_id: "t-1".into(),
            task_status: "FAILED".into(),
            results: vec![],
            code: Some("AudioInvalid".into()),
            message: Some("decode error".into()),
        };
        bad.task_status = "FAILED".into();
        let scope = MockScope::new(vec![
            ScopeOp::Submit(Ok("t-1".into())),
            ScopeOp::Query(Ok(bad)),
        ]);
        let err = transcribe_aliyun_file_with(
            &oss,
            &scope,
            &ZeroSleeper,
            vec![1, 2, 3],
            "audio.wav",
            None,
            "ak",
        )
        .await
        .unwrap_err();
        let s = err.to_string();
        assert!(s.contains("aliyun_filetrans_failed"), "got {s}");
        assert!(s.contains("AudioInvalid"), "got {s}");
    }

    #[test]
    fn aliyun_file_name_extraction() {
        assert_eq!(
            aliyun_file_name_for("recordings/2026-05-04/abc.ogg"),
            "abc.ogg"
        );
        assert_eq!(
            aliyun_file_name_for("recordings/legacy.wav"),
            "legacy.wav"
        );
        assert_eq!(aliyun_file_name_for(""), "recording.wav");
    }
}
