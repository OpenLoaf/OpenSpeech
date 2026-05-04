// 文件转写：把已落盘的录音（OGG / WAV）通过 V4 工具接口重新转成文字。
// 兼用 history 重试 + UTTERANCE 主路径——UTTERANCE 录音结束后直接走这条线。
//
// 接口分流（按时长自动选择，与前端 history 重试流程对接）：
// - ≤ 5 分钟 ⇒ `OL-TL-003` (asrShort)：同步 HTTP，base64 直传，秒级返回。
// - > 5 分钟 ⇒ `OL-TL-004` (asrLong)：上游只接受公网 URL，本地音频走不通；
//   暂不支持，返回明确错误让 UI 提示用户。后续若加上传服务再接通查询轮询路径。
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
use tauri::{AppHandle, Manager, Runtime};

use crate::asr::byok::{
    DictationBackend, DictationModality, ERR_BYOK_NOT_IMPLEMENTED, ProviderMode, ProviderRef,
    dispatch, provider_kind_str,
};
use crate::asr::aliyun::file::{
    DashScopeClient, FileTransError, ReqwestDashScopeClient, TokioSleeper as AliyunSleeper,
    merge_transcriptions, poll_task_until_terminal,
};
use crate::asr::aliyun::oss_upload::{
    BailianOssClient, OssUploadError, ReqwestBailianOssClient,
};
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

// 短文件（OL-TL-003）仍接受 Option<String>；长文件（OL-TL-004）0.3.13 起改成强类型枚举。
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
        custom_provider_name: None,
    }
}

#[tauri::command]
pub async fn transcribe_recording_file<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    duration_ms: u64,
    lang: Option<String>,
    provider: Option<ProviderRef>,
) -> Result<TranscribeFileResult, String> {
    let provider_ref = provider.unwrap_or_else(default_saas_provider_ref);
    let backend = dispatch(&provider_ref, DictationModality::File).map_err(|e| {
        log::warn!("[transcribe] backend dispatch failed: {e}");
        e.code().to_string()
    })?;

    let kind = provider_kind_str(&backend).to_string();
    match backend {
        DictationBackend::SaasFile => {
            tauri::async_runtime::spawn_blocking(move || {
                transcribe_recording_file_impl(app, audio_path, duration_ms, lang, kind)
            })
            .await
            .map_err(|e| format!("transcribe join: {e}"))?
        }
        DictationBackend::TencentFile {
            secret_id,
            secret_key,
            region,
            ..
        } => {
            let bytes = read_recording_bytes(&app, &audio_path)?;
            transcribe_tencent_file(bytes, &audio_path, lang, &secret_id, &secret_key, &region)
                .await
                .map(|text| TranscribeFileResult {
                    text,
                    variant: "tencentFile".into(),
                    credits_consumed: 0.0,
                    provider_kind: kind,
                })
                .map_err(|e| e.to_string())
        }
        DictationBackend::AliyunFile { api_key, .. } => {
            let bytes = read_recording_bytes(&app, &audio_path)?;
            transcribe_aliyun_file(bytes, &audio_path, &api_key)
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

fn tencent_engine_for(lang: Option<&str>) -> &'static str {
    match lang.map(|s| s.trim().to_ascii_lowercase()).as_deref() {
        Some("en") | Some("en-us") | Some("en-gb") => "16k_en",
        Some("yue") => "16k_yue",
        Some("ja") => "16k_ja",
        Some("ko") => "16k_ko",
        _ => "16k_zh",
    }
}

async fn transcribe_tencent_file(
    bytes: Vec<u8>,
    audio_path: &str,
    lang: Option<String>,
    secret_id: &str,
    secret_key: &str,
    region: &str,
) -> Result<String, TencentFileError> {
    let actual_len = bytes.len() as u64;
    if actual_len > crate::asr::tencent::file::TENCENT_FILE_MAX_BYTES {
        return Err(TencentFileError::FileTooLarge {
            actual_bytes: actual_len,
        });
    }
    let b64 = B64.encode(&bytes);
    let req = CreateRecTaskRequest::new_local(b64, actual_len)
        .engine(tencent_engine_for(lang.as_deref()));
    let _ = audio_path; // 暂未用到 OGG/WAV 区分（腾讯 16k_zh 通吃容器封装）
    let region_opt = if region.trim().is_empty() {
        None
    } else {
        Some(region)
    };
    let http = ReqwestHttp::new()?;
    let sleeper = TokioSleeper;
    let task_id = submit_create_task(&http, secret_id, secret_key, region_opt, &req).await?;
    log::info!("[transcribe] tencent CreateRecTask submitted task_id={task_id}");
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
    .await?;
    let data = resp.response.data.ok_or_else(|| TencentFileError::TaskFailed {
        msg: "DescribeTaskStatus returned no Data on success".into(),
    })?;
    let text = merge_result_detail(&data.result_detail);
    if text.is_empty() {
        // 兜底：腾讯 ResultDetail 偶发为空（短音频 / 旧路径），改用 Result 字段去掉时间戳前缀
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
    api_key: &str,
) -> Result<String, AliyunFileError> {
    let oss = ReqwestBailianOssClient::new()?;
    let scope = ReqwestDashScopeClient::new()?;
    transcribe_aliyun_file_with(&oss, &scope, &AliyunSleeper, bytes, audio_path, api_key).await
}

async fn transcribe_aliyun_file_with(
    oss: &dyn BailianOssClient,
    scope: &dyn DashScopeClient,
    sleeper: &dyn crate::asr::aliyun::file::Sleeper,
    bytes: Vec<u8>,
    audio_path: &str,
    api_key: &str,
) -> Result<String, AliyunFileError> {
    let file_name = aliyun_file_name_for(audio_path);

    // 上传：第一次 PolicyExpired 重新 get_policy 一次再试。
    let oss_url = match upload_with_retry(oss, api_key, &file_name, bytes).await {
        Ok(u) => u,
        Err(e) => return Err(e.into()),
    };
    log::info!("[transcribe] aliyun OSS uploaded: {oss_url}");

    let task_id = scope
        .submit_filetrans(api_key, &[oss_url])
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
    Ok(merge_transcriptions(&out.results))
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

fn transcribe_recording_file_impl<R: Runtime>(
    app: AppHandle<R>,
    audio_path: String,
    duration_ms: u64,
    lang: Option<String>,
    provider_kind: String,
) -> Result<TranscribeFileResult, String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    if duration_ms <= SHORT_AUDIO_LIMIT_MS {
        let bytes = read_recording_bytes(&app, &audio_path)?;
        let b64 = B64.encode(&bytes);
        let input = AsrShortOlTl003Input::from_base64(b64, media_type_for(&audio_path));
        let params = AsrShortOlTl003Params {
            language: parse_lang_short(lang.as_deref()),
            enable_itn: None,
        };
        let r = client
            .tools_v4()
            .asr_short_ol_tl_003(&input, &params)
            .map_err(|e| {
                let raw = e.to_string();
                if is_unauthorized(&raw) {
                    handle_session_expired(&app, &ol);
                    ERR_UNAUTHORIZED.to_string()
                } else {
                    format!("asr_short failed: {e}")
                }
            })?;
        Ok(TranscribeFileResult {
            text: r.data.text,
            variant: "asrShort".into(),
            credits_consumed: r.credits_consumed,
            provider_kind,
        })
    } else {
        // 长音频：服务端只接受公网 URL，本地音频没有可访问的 URL。
        // 给出明确错误让 UI 提示，避免用户以为是转写失败。
        Err(
            "long audio retry needs a public URL; local recording cannot be uploaded yet (>5min)"
                .into(),
        )
    }
}

#[tauri::command]
pub async fn transcribe_long_audio_url<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    tauri::async_runtime::spawn_blocking(move || transcribe_long_audio_url_impl(app, url, lang))
        .await
        .map_err(|e| format!("transcribe long join: {e}"))?
}

fn transcribe_long_audio_url_impl<R: Runtime>(
    app: AppHandle<R>,
    url: String,
    lang: Option<String>,
) -> Result<TranscribeFileResult, String> {
    let ol = app.state::<SharedOpenLoaf>();
    let client = ol.authenticated_client().ok_or_else(|| {
        handle_session_expired(&app, &ol);
        ERR_NOT_AUTHENTICATED.to_string()
    })?;

    let input = AsrLongOlTl004Input::from_url(url);
    let params = AsrLongOlTl004Params {
        language: parse_lang_long(lang.as_deref()),
        enable_words: Some(false),
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
                    provider_kind: "saas-file".into(),
                });
            }
            AsrLongOlTl004Status::Failed => {
                let msg = r
                    .error
                    .and_then(|e| e.message)
                    .unwrap_or_default();
                return Err(format!("asr_long failed: {msg}"));
            }
            AsrLongOlTl004Status::Pending | AsrLongOlTl004Status::Doing => continue,
        }
    }
    Err("asr_long poll timeout".into())
}

#[cfg(test)]
mod aliyun_tests {
    use super::*;
    use crate::asr::aliyun::file::{
        DashScopeClient, FileTransError, Sleeper as AliyunPollSleeper, TaskOutput, TaskResult,
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
        ) -> Result<String, FileTransError> {
            self.captured.lock().unwrap().push(format!("submit:{}", oss_urls.join(",")));
            match self.pop() {
                ScopeOp::Submit(r) => r,
                ScopeOp::Query(_) => panic!("expected Submit op"),
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
                ScopeOp::Submit(_) => panic!("expected Query op"),
            }
        }
    }

    struct ZeroSleeper;
    #[async_trait::async_trait]
    impl AliyunPollSleeper for ZeroSleeper {
        async fn sleep(&self, _: Duration) {}
    }

    fn task_done(text: &str) -> TaskOutput {
        TaskOutput {
            task_id: "t-1".into(),
            task_status: "SUCCEEDED".into(),
            results: vec![TaskResult {
                file_url: None,
                subtask_status: Some("SUCCEEDED".into()),
                transcription: Some(text.into()),
                code: None,
                message: None,
            }],
            code: None,
            message: None,
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
        ]);
        let text = transcribe_aliyun_file_with(
            &oss,
            &scope,
            &ZeroSleeper,
            vec![1, 2, 3],
            "recordings/2026-05-04/audio.wav",
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
        ]);
        let text = transcribe_aliyun_file_with(
            &oss,
            &scope,
            &ZeroSleeper,
            vec![1, 2, 3],
            "audio.wav",
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
