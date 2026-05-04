// 腾讯云 ASR 录音文件识别（CreateRecTask + DescribeTaskStatus）。
//
// REST 接口：POST https://asr.tencentcloudapi.com/
// 鉴权：TC3-HMAC-SHA256（见 signature.rs）
// 协议：异步——`CreateRecTask` 拿 TaskId，再轮询 `DescribeTaskStatus`
//
// docs/tencent-asr/file-recognition-request.md
// docs/tencent-asr/file-recognition-query.md

use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};

use super::signature::{
    build_authorization, build_canonical_request, build_string_to_sign, derive_signing_key,
    sha256_hex, sign_v3, utc_date_from_timestamp,
};

// ─── CreateRecTask 请求 ──────────────────────────────────────────

/// 音频来源：URL 或本地 base64 二选一。
/// 腾讯把这俩条件分散在 `SourceType + Url` / `SourceType + Data + DataLen` 两组字段里，
/// 这里用枚举把它收成一个不可能搞错的类型。
///
/// 主路径只走 LocalBase64；Url 留作协议完整性 + 将来支持文件 URL 直传。
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum AudioSource {
    /// SourceType=0：公网可下载的 URL。≤5h、≤1GB。
    Url(String),
    /// SourceType=1：本地 base64。≤5MB（base64 前的字节数）。
    LocalBase64 { data: String, data_len: u64 },
}

/// 一个最小可用的 CreateRecTask 请求构造器。完整字段集见
/// docs/tencent-asr/file-recognition-request.md §2，本期只暴露常用项。
#[derive(Debug, Clone)]
pub struct CreateRecTaskRequest {
    /// EngineModelType：默认 16k_zh。完整枚举见文档。
    pub engine_model_type: String,
    /// ChannelNum：单声道 1（16k 必须 1）；双声道 2（仅 8k 电话音频）
    pub channel_num: u8,
    /// ResTextFormat：0 基础、1/2/3 词粒度+标点、4/5 增值付费
    pub res_text_format: u8,
    pub source: AudioSource,
    /// 可选：语种？腾讯没有独立 language 字段，全靠 EngineModelType 选；这里只为
    /// 让上层 fn 签名对齐其他 vendor 的"language hint"语义留个 stub，目前 ignored。
    pub _hint_lang: Option<String>,
}

impl CreateRecTaskRequest {
    /// 公网 URL 模式（SourceType=0）。COS BYOK 路径用：先把音频上传到用户 COS
    /// 再生成预签名 URL 喂进来。body 不含 DataLen——`length_bytes` 留给上层日志/护栏。
    pub fn new_url(url: impl Into<String>) -> Self {
        Self {
            engine_model_type: "16k_zh".into(),
            channel_num: 1,
            res_text_format: 0,
            source: AudioSource::Url(url.into()),
            _hint_lang: None,
        }
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub fn new_local(base64: impl Into<String>, data_len: u64) -> Self {
        Self {
            engine_model_type: "16k_zh".into(),
            channel_num: 1,
            res_text_format: 0,
            source: AudioSource::LocalBase64 {
                data: base64.into(),
                data_len,
            },
            _hint_lang: None,
        }
    }

    pub fn engine(mut self, eng: impl Into<String>) -> Self {
        self.engine_model_type = eng.into();
        self
    }

    /// 把请求序列化为 v3 签名要的 JSON body（必须**字段顺序无关**——v3 hash
    /// 整个 body string，所以只要前后端 key 一致即可）。
    pub fn to_json(&self) -> String {
        // 不写 `#[derive(Serialize)]` 因为 SourceType 的二选一要展开成扁平字段，
        // 用一个 Value 临时构造更直观。
        let mut v = serde_json::json!({
            "EngineModelType": self.engine_model_type,
            "ChannelNum": self.channel_num,
            "ResTextFormat": self.res_text_format,
        });
        let obj = v.as_object_mut().expect("just constructed object");
        match &self.source {
            AudioSource::Url(url) => {
                obj.insert("SourceType".into(), serde_json::json!(0));
                obj.insert("Url".into(), serde_json::json!(url));
            }
            AudioSource::LocalBase64 { data, data_len } => {
                obj.insert("SourceType".into(), serde_json::json!(1));
                obj.insert("Data".into(), serde_json::json!(data));
                obj.insert("DataLen".into(), serde_json::json!(data_len));
            }
        }
        serde_json::to_string(&v).expect("static structure serializable")
    }
}

// ─── CreateRecTask 响应 ──────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct CreateRecTaskResponse {
    #[serde(rename = "Response")]
    pub response: CreateRecTaskResponseInner,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // request_id 用于排查腾讯侧 trace，serde 反序列化目标
pub struct CreateRecTaskResponseInner {
    #[serde(rename = "RequestId")]
    pub request_id: String,
    /// 业务成功路径
    #[serde(rename = "Data", default)]
    pub data: Option<CreateRecTaskData>,
    /// 公共错误：v3 错误返回时是 `Response.Error.{Code, Message}`
    #[serde(rename = "Error", default)]
    pub error: Option<TencentApiError>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CreateRecTaskData {
    #[serde(rename = "TaskId")]
    pub task_id: i64,
}

#[derive(Debug, Clone, Deserialize, PartialEq)]
pub struct TencentApiError {
    #[serde(rename = "Code")]
    pub code: String,
    #[serde(rename = "Message")]
    pub message: String,
}

// ─── DescribeTaskStatus 请求 ─────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct DescribeTaskStatusRequest {
    #[serde(rename = "TaskId")]
    pub task_id: i64,
}

impl DescribeTaskStatusRequest {
    pub fn new(task_id: i64) -> Self {
        Self { task_id }
    }
    pub fn to_json(&self) -> String {
        serde_json::to_string(self).expect("static structure serializable")
    }
}

// ─── DescribeTaskStatus 响应 ─────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Waiting, // 0
    Doing,   // 1
    Success, // 2
    Failed,  // 3
}

impl TaskStatus {
    pub fn from_code(c: i32) -> Option<Self> {
        match c {
            0 => Some(Self::Waiting),
            1 => Some(Self::Doing),
            2 => Some(Self::Success),
            3 => Some(Self::Failed),
            _ => None,
        }
    }
    #[allow(dead_code)] // poll 循环用 match-arm 直接判，is_terminal 留给 ad-hoc 调用
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Success | Self::Failed)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct DescribeTaskStatusResponse {
    #[serde(rename = "Response")]
    pub response: DescribeTaskStatusResponseInner,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // request_id 用于排查腾讯侧 trace，serde 反序列化目标
pub struct DescribeTaskStatusResponseInner {
    #[serde(rename = "RequestId")]
    pub request_id: String,
    #[serde(rename = "Data", default)]
    pub data: Option<TaskStatusData>,
    #[serde(rename = "Error", default)]
    pub error: Option<TencentApiError>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // 协议形状字段（TaskId / AudioDuration 等）serde 反序列化目标
pub struct TaskStatusData {
    #[serde(rename = "TaskId")]
    pub task_id: i64,
    /// 0/1/2/3：与 TaskStatus::from_code 对齐
    #[serde(rename = "Status")]
    pub status: i32,
    #[serde(rename = "StatusStr", default)]
    pub status_str: String,
    /// 录音时长（秒）。Failed / Waiting 阶段为 0
    #[serde(rename = "AudioDuration", default)]
    pub audio_duration: f64,
    /// Success 时是带时间戳前缀的整段文本；Failed/Waiting 为空串
    #[serde(rename = "Result", default)]
    pub result: String,
    #[serde(rename = "ErrorMsg", default)]
    pub error_msg: String,
    /// Tencent 在 Waiting/Doing 时返回 `"ResultDetail": null`，serde 默认会把 null
    /// 当成失败（不会触发 default）。custom deserializer 把 null 也归一成空 Vec，
    /// 保持轮询循环稳定（这条路径以前会被包成 tencent_network_error 误导用户）。
    #[serde(
        rename = "ResultDetail",
        default,
        deserialize_with = "deserialize_null_to_default"
    )]
    pub result_detail: Vec<ResultDetail>,
}

fn deserialize_null_to_default<'de, T, D>(d: D) -> Result<T, D::Error>
where
    T: Default + Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Option::<T>::deserialize(d)?.unwrap_or_default())
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // 协议形状：主路径只读 final_sentence；其余留作时间戳/分轨 hooks
pub struct ResultDetail {
    #[serde(rename = "FinalSentence", default)]
    pub final_sentence: String,
    #[serde(rename = "SliceSentence", default)]
    pub slice_sentence: String,
    #[serde(rename = "StartMs", default)]
    pub start_ms: i64,
    #[serde(rename = "EndMs", default)]
    pub end_ms: i64,
    #[serde(rename = "SpeakerId", default)]
    pub speaker_id: i64,
}

/// 把 ResultDetail 里的 FinalSentence 顺序拼成纯文本。
/// 优先于 `result` 字段（后者带时间戳前缀，呈现 UI 不友好）。
pub fn merge_result_detail(details: &[ResultDetail]) -> String {
    details
        .iter()
        .map(|d| d.final_sentence.as_str())
        .collect::<Vec<_>>()
        .join("")
}

// ─── 公共参数 / Header 常量 ──────────────────────────────────────

pub const ASR_HOST: &str = "asr.tencentcloudapi.com";
pub const ASR_SERVICE: &str = "asr";
pub const ASR_VERSION: &str = "2019-06-14";
pub const ACTION_CREATE: &str = "CreateRecTask";
pub const ACTION_QUERY: &str = "DescribeTaskStatus";

/// 腾讯文件转写本地 base64 上限：5MB（base64 前的字节数）。
pub const TENCENT_FILE_MAX_BYTES: u64 = 5 * 1024 * 1024;

// ─── HTTP 错误 ───────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum TencentFileError {
    Unauthenticated(String),
    FileTooLarge { actual_bytes: u64 },
    TaskFailed { msg: String },
    Timeout,
    RateLimited,
    Network(String),
}

impl TencentFileError {
    #[allow(dead_code)] // 错误码 string 由 Display 主导；code() 留给将来按错误类型分流
    pub fn code(&self) -> &'static str {
        match self {
            TencentFileError::Unauthenticated(_) => "tencent_unauthenticated",
            TencentFileError::FileTooLarge { .. } => "file_too_large_for_tencent_byok",
            TencentFileError::TaskFailed { .. } => "tencent_task_failed",
            TencentFileError::Timeout => "tencent_task_timeout",
            TencentFileError::RateLimited => "tencent_rate_limited",
            TencentFileError::Network(_) => "tencent_network_error",
        }
    }
}

impl std::fmt::Display for TencentFileError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            TencentFileError::Unauthenticated(m) => write!(f, "tencent_unauthenticated: {m}"),
            TencentFileError::FileTooLarge { actual_bytes } => {
                write!(f, "file_too_large_for_tencent_byok: {actual_bytes} bytes")
            }
            TencentFileError::TaskFailed { msg } => write!(f, "tencent_task_failed: {msg}"),
            TencentFileError::Timeout => write!(f, "tencent_task_timeout"),
            TencentFileError::RateLimited => write!(f, "tencent_rate_limited"),
            TencentFileError::Network(m) => write!(f, "tencent_network_error: {m}"),
        }
    }
}

impl std::error::Error for TencentFileError {}

// ─── HTTP 抽象（便于单测 mock） ──────────────────────────────────

/// 一次签好名 + 头都装好的 v3 请求。Body 是已序列化的 JSON 字符串。
#[derive(Debug, Clone)]
pub struct SignedV3Request {
    pub url: String,
    pub action: String,
    pub region: Option<String>,
    pub timestamp: i64,
    pub authorization: String,
    pub body: String,
}

/// HTTP 调用层抽象 —— 真实实现走 reqwest，单测里 mock。
#[async_trait::async_trait]
pub trait TencentHttp: Send + Sync {
    async fn post(&self, req: &SignedV3Request) -> Result<String, TencentFileError>;
}

pub struct ReqwestHttp {
    client: reqwest::Client,
}

impl ReqwestHttp {
    pub fn new() -> Result<Self, TencentFileError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| TencentFileError::Network(e.to_string()))?;
        Ok(Self { client })
    }

    #[allow(dead_code)]
    pub fn from_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

#[async_trait::async_trait]
impl TencentHttp for ReqwestHttp {
    async fn post(&self, req: &SignedV3Request) -> Result<String, TencentFileError> {
        let mut builder = self
            .client
            .post(&req.url)
            .header("Content-Type", "application/json; charset=utf-8")
            .header("Host", ASR_HOST)
            .header("X-TC-Action", &req.action)
            .header("X-TC-Version", ASR_VERSION)
            .header("X-TC-Timestamp", req.timestamp.to_string())
            .header("Authorization", &req.authorization);
        if let Some(r) = &req.region {
            builder = builder.header("X-TC-Region", r);
        }
        let resp = builder
            .body(req.body.clone())
            .send()
            .await
            .map_err(|e| TencentFileError::Network(e.to_string()))?;
        let status = resp.status();
        let text = resp
            .text()
            .await
            .map_err(|e| TencentFileError::Network(e.to_string()))?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(TencentFileError::Unauthenticated(format!(
                "HTTP {status}: {text}"
            )));
        }
        if status.as_u16() == 429 {
            return Err(TencentFileError::RateLimited);
        }
        if !status.is_success() {
            return Err(TencentFileError::Network(format!(
                "HTTP {status}: {text}"
            )));
        }
        Ok(text)
    }
}

// ─── 签名 + 调用辅助 ─────────────────────────────────────────────

fn sign_request(
    action: &str,
    body: &str,
    secret_id: &str,
    secret_key: &str,
    region: Option<&str>,
) -> SignedV3Request {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let date = utc_date_from_timestamp(timestamp);
    let payload_hash = sha256_hex(body.as_bytes());
    let canonical_headers = format!(
        "content-type:application/json; charset=utf-8\nhost:{ASR_HOST}\nx-tc-action:{}\n",
        action.to_ascii_lowercase()
    );
    let signed_headers = "content-type;host;x-tc-action";
    let canonical_request = build_canonical_request(
        "POST",
        "/",
        "",
        &canonical_headers,
        signed_headers,
        &payload_hash,
    );
    let string_to_sign = build_string_to_sign(timestamp, &date, ASR_SERVICE, &canonical_request);
    let key = derive_signing_key(secret_key, &date, ASR_SERVICE);
    let signature = sign_v3(&key, &string_to_sign);
    let authorization =
        build_authorization(secret_id, &date, ASR_SERVICE, signed_headers, &signature);
    SignedV3Request {
        url: format!("https://{ASR_HOST}/"),
        action: action.to_string(),
        region: region.map(|s| s.to_string()),
        timestamp,
        authorization,
        body: body.to_string(),
    }
}

/// 把 v3 公共错误码映射成 TencentFileError。Auth* → Unauthenticated；其余按 TaskFailed 兜。
fn classify_api_error(code: &str, message: &str) -> TencentFileError {
    if code.starts_with("AuthFailure") {
        TencentFileError::Unauthenticated(format!("{code}: {message}"))
    } else if code.starts_with("RequestLimitExceeded") {
        TencentFileError::RateLimited
    } else {
        TencentFileError::TaskFailed {
            msg: format!("{code}: {message}"),
        }
    }
}

// ─── CreateRecTask 调用 ──────────────────────────────────────────

/// 提交录音文件转写任务，返回 TaskId。
pub async fn submit_create_task(
    http: &dyn TencentHttp,
    secret_id: &str,
    secret_key: &str,
    region: Option<&str>,
    request: &CreateRecTaskRequest,
) -> Result<i64, TencentFileError> {
    if let AudioSource::LocalBase64 { data_len, .. } = &request.source {
        if *data_len > TENCENT_FILE_MAX_BYTES {
            return Err(TencentFileError::FileTooLarge {
                actual_bytes: *data_len,
            });
        }
    }
    let body = request.to_json();
    let signed = sign_request(ACTION_CREATE, &body, secret_id, secret_key, region);
    let raw = http.post(&signed).await?;
    let resp: CreateRecTaskResponse = serde_json::from_str(&raw)
        .map_err(|e| TencentFileError::Network(format!("decode CreateRecTask: {e}")))?;
    if let Some(err) = resp.response.error {
        return Err(classify_api_error(&err.code, &err.message));
    }
    let data = resp.response.data.ok_or_else(|| TencentFileError::Network(
        "CreateRecTask: response missing both Data and Error".into(),
    ))?;
    Ok(data.task_id)
}

// ─── DescribeTaskStatus 轮询 ─────────────────────────────────────

async fn query_once(
    http: &dyn TencentHttp,
    secret_id: &str,
    secret_key: &str,
    region: Option<&str>,
    task_id: i64,
) -> Result<DescribeTaskStatusResponse, TencentFileError> {
    let body = DescribeTaskStatusRequest::new(task_id).to_json();
    let signed = sign_request(ACTION_QUERY, &body, secret_id, secret_key, region);
    let raw = http.post(&signed).await?;
    let resp: DescribeTaskStatusResponse = serde_json::from_str(&raw)
        .map_err(|e| TencentFileError::Network(format!("decode DescribeTaskStatus: {e}")))?;
    if let Some(err) = resp.response.error {
        return Err(classify_api_error(&err.code, &err.message));
    }
    Ok(resp)
}

/// Sleep 抽象 —— 让单测可以用 0 延迟跑过轮询循环，不实际等。
#[async_trait::async_trait]
pub trait Sleeper: Send + Sync {
    async fn sleep(&self, dur: Duration);
}

pub struct TokioSleeper;

#[async_trait::async_trait]
impl Sleeper for TokioSleeper {
    async fn sleep(&self, dur: Duration) {
        tokio::time::sleep(dur).await;
    }
}

/// 轮询直到任务进入终态（Success / Failed）或 deadline。
pub async fn poll_until_terminal(
    http: &dyn TencentHttp,
    sleeper: &dyn Sleeper,
    secret_id: &str,
    secret_key: &str,
    region: Option<&str>,
    task_id: i64,
    poll_interval: Duration,
    deadline: Instant,
) -> Result<DescribeTaskStatusResponse, TencentFileError> {
    loop {
        let resp = query_once(http, secret_id, secret_key, region, task_id).await?;
        if let Some(data) = &resp.response.data {
            if let Some(s) = TaskStatus::from_code(data.status) {
                match s {
                    TaskStatus::Success => return Ok(resp),
                    TaskStatus::Failed => {
                        return Err(TencentFileError::TaskFailed {
                            msg: if data.error_msg.is_empty() {
                                data.status_str.clone()
                            } else {
                                data.error_msg.clone()
                            },
                        });
                    }
                    TaskStatus::Waiting | TaskStatus::Doing => {}
                }
            }
        }
        if Instant::now() >= deadline {
            return Err(TencentFileError::Timeout);
        }
        sleeper.sleep(poll_interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn create_request_url_body_shape() {
        // 文档示例 1（按 URL）
        let req = CreateRecTaskRequest::new_url("http://test.cos.ap-guangzhou.myqcloud.com/test.wav")
            .engine("16k_zh");
        let body: Value = serde_json::from_str(&req.to_json()).unwrap();
        assert_eq!(body["EngineModelType"], "16k_zh");
        assert_eq!(body["ChannelNum"], 1);
        assert_eq!(body["ResTextFormat"], 0);
        assert_eq!(body["SourceType"], 0);
        assert_eq!(body["Url"], "http://test.cos.ap-guangzhou.myqcloud.com/test.wav");
        // URL 模式不能带 Data / DataLen
        assert!(body.get("Data").is_none());
        assert!(body.get("DataLen").is_none());
    }

    #[test]
    fn create_request_local_body_shape() {
        // 文档示例 2（按 base64 数据）
        let req = CreateRecTaskRequest::new_local("eGNmYXNkZmFzZmFzZGZhc2RmCg==", 50);
        let body: Value = serde_json::from_str(&req.to_json()).unwrap();
        assert_eq!(body["SourceType"], 1);
        assert_eq!(body["Data"], "eGNmYXNkZmFzZmFzZGZhc2RmCg==");
        assert_eq!(body["DataLen"], 50);
        assert!(body.get("Url").is_none());
    }

    #[test]
    fn parse_create_response_success() {
        // 文档输出示例
        let raw = r#"{
            "Response": {
                "RequestId": "3c140219-cfe9-470e-b241-907877d6fb03",
                "Data": { "TaskId": 1393265 }
            }
        }"#;
        let resp: CreateRecTaskResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(resp.response.request_id, "3c140219-cfe9-470e-b241-907877d6fb03");
        assert_eq!(resp.response.data.unwrap().task_id, 1393265);
        assert!(resp.response.error.is_none());
    }

    #[test]
    fn parse_create_response_error_envelope() {
        // 公共错误外层（v3 鉴权失败时返回这种）
        let raw = r#"{
            "Response": {
                "RequestId": "abc",
                "Error": { "Code": "AuthFailure.SignatureFailure", "Message": "签名验证失败" }
            }
        }"#;
        let resp: CreateRecTaskResponse = serde_json::from_str(raw).unwrap();
        let err = resp.response.error.unwrap();
        assert_eq!(err.code, "AuthFailure.SignatureFailure");
        assert!(resp.response.data.is_none());
    }

    #[test]
    fn task_status_from_code() {
        assert_eq!(TaskStatus::from_code(0), Some(TaskStatus::Waiting));
        assert_eq!(TaskStatus::from_code(1), Some(TaskStatus::Doing));
        assert_eq!(TaskStatus::from_code(2), Some(TaskStatus::Success));
        assert_eq!(TaskStatus::from_code(3), Some(TaskStatus::Failed));
        assert_eq!(TaskStatus::from_code(99), None);
    }

    #[test]
    fn task_status_terminal_only_success_or_failed() {
        assert!(!TaskStatus::Waiting.is_terminal());
        assert!(!TaskStatus::Doing.is_terminal());
        assert!(TaskStatus::Success.is_terminal());
        assert!(TaskStatus::Failed.is_terminal());
    }

    #[test]
    fn parse_query_response_success() {
        // 文档示例 2
        let raw = r#"{
            "Response": {
                "RequestId": "a73b14a6-5044-41cb-bf32-e735d5bd69de",
                "Data": {
                    "TaskId": 9266418,
                    "Status": 2,
                    "StatusStr": "success",
                    "AudioDuration": 2.38,
                    "Result": "[0:0.020,0:2.380]  腾讯云语音识别欢迎您。\n",
                    "ResultDetail": [{
                        "FinalSentence": "腾讯云语音识别欢迎您。",
                        "SliceSentence": "腾讯云 语音识别 欢迎 您",
                        "StartMs": 20,
                        "EndMs": 2380,
                        "SpeakerId": 0
                    }],
                    "ErrorMsg": ""
                }
            }
        }"#;
        let resp: DescribeTaskStatusResponse = serde_json::from_str(raw).unwrap();
        let data = resp.response.data.unwrap();
        assert_eq!(data.status, 2);
        assert_eq!(TaskStatus::from_code(data.status), Some(TaskStatus::Success));
        assert_eq!(data.audio_duration, 2.38);
        assert_eq!(data.result_detail.len(), 1);
        assert_eq!(merge_result_detail(&data.result_detail), "腾讯云语音识别欢迎您。");
    }

    #[test]
    fn parse_query_response_failed() {
        // 文档示例 1
        let raw = r#"{
            "Response": {
                "RequestId": "8824366f-0e8f-4bd4-8924-af5e84127caa",
                "Data": {
                    "TaskId": 522931820,
                    "Status": 3,
                    "StatusStr": "failed",
                    "AudioDuration": 0,
                    "Result": "",
                    "ErrorMsg": "Failed to download audio file!",
                    "ResultDetail": []
                }
            }
        }"#;
        let resp: DescribeTaskStatusResponse = serde_json::from_str(raw).unwrap();
        let data = resp.response.data.unwrap();
        assert_eq!(TaskStatus::from_code(data.status), Some(TaskStatus::Failed));
        assert_eq!(data.error_msg, "Failed to download audio file!");
        assert_eq!(merge_result_detail(&data.result_detail), "");
    }

    #[test]
    fn parse_query_response_waiting() {
        // 文档示例 3
        let raw = r#"{
            "Response": {
                "RequestId": "x",
                "Data": { "TaskId": 1, "Status": 0, "StatusStr": "waiting",
                          "AudioDuration": 0, "Result": "", "ErrorMsg": "",
                          "ResultDetail": [] }
            }
        }"#;
        let resp: DescribeTaskStatusResponse = serde_json::from_str(raw).unwrap();
        let s = TaskStatus::from_code(resp.response.data.unwrap().status).unwrap();
        assert_eq!(s, TaskStatus::Waiting);
        assert!(!s.is_terminal());
    }

    #[test]
    fn merge_multiple_sentences_in_order() {
        let details = vec![
            ResultDetail {
                final_sentence: "你好。".into(),
                ..Default::default()
            },
            ResultDetail {
                final_sentence: "世界。".into(),
                ..Default::default()
            },
        ];
        assert_eq!(merge_result_detail(&details), "你好。世界。");
    }

    impl Default for ResultDetail {
        fn default() -> Self {
            Self {
                final_sentence: String::new(),
                slice_sentence: String::new(),
                start_ms: 0,
                end_ms: 0,
                speaker_id: 0,
            }
        }
    }

    // ─── HTTP / 轮询 mock 测试 ────────────────────────────────────

    use std::sync::Mutex;

    struct MockHttp {
        responses: Mutex<Vec<Result<String, TencentFileError>>>,
        captured_actions: Mutex<Vec<String>>,
    }

    impl MockHttp {
        fn new(responses: Vec<Result<String, TencentFileError>>) -> Self {
            Self {
                responses: Mutex::new(responses),
                captured_actions: Mutex::new(Vec::new()),
            }
        }
    }

    #[async_trait::async_trait]
    impl TencentHttp for MockHttp {
        async fn post(&self, req: &SignedV3Request) -> Result<String, TencentFileError> {
            self.captured_actions
                .lock()
                .unwrap()
                .push(req.action.clone());
            let mut q = self.responses.lock().unwrap();
            if q.is_empty() {
                return Err(TencentFileError::Network("mock exhausted".into()));
            }
            q.remove(0)
        }
    }

    struct ZeroSleeper;
    #[async_trait::async_trait]
    impl Sleeper for ZeroSleeper {
        async fn sleep(&self, _: Duration) {}
    }

    #[tokio::test]
    async fn submit_create_task_happy_path() {
        let http = MockHttp::new(vec![Ok(r#"{"Response":{"RequestId":"rid","Data":{"TaskId":777}}}"#.into())]);
        let req = CreateRecTaskRequest::new_local("aGVsbG8=", 5);
        let task_id = submit_create_task(&http, "sid", "skey", None, &req).await.unwrap();
        assert_eq!(task_id, 777);
        assert_eq!(http.captured_actions.lock().unwrap()[0], ACTION_CREATE);
    }

    #[tokio::test]
    async fn submit_create_task_auth_failure_maps_to_unauthenticated() {
        let http = MockHttp::new(vec![Ok(r#"{"Response":{"RequestId":"rid","Error":{"Code":"AuthFailure.SignatureFailure","Message":"sig bad"}}}"#.into())]);
        let req = CreateRecTaskRequest::new_local("aGVsbG8=", 5);
        let err = submit_create_task(&http, "sid", "skey", None, &req).await.unwrap_err();
        assert!(matches!(err, TencentFileError::Unauthenticated(_)), "got {err:?}");
        assert_eq!(err.code(), "tencent_unauthenticated");
    }

    #[tokio::test]
    async fn submit_create_task_rate_limit_maps() {
        let http = MockHttp::new(vec![Ok(r#"{"Response":{"RequestId":"rid","Error":{"Code":"RequestLimitExceeded","Message":"qps"}}}"#.into())]);
        let req = CreateRecTaskRequest::new_local("aGVsbG8=", 5);
        let err = submit_create_task(&http, "sid", "skey", None, &req).await.unwrap_err();
        assert!(matches!(err, TencentFileError::RateLimited));
    }

    #[tokio::test]
    async fn submit_create_task_file_too_large_short_circuits_before_http() {
        // 超过 5MB：不发请求就直接返错
        let http = MockHttp::new(vec![]);
        let req = CreateRecTaskRequest::new_local("ignored", TENCENT_FILE_MAX_BYTES + 1);
        let err = submit_create_task(&http, "sid", "skey", None, &req).await.unwrap_err();
        assert!(matches!(err, TencentFileError::FileTooLarge { .. }));
        assert_eq!(err.code(), "file_too_large_for_tencent_byok");
        // mock 没被调到
        assert!(http.captured_actions.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn submit_create_task_network_error_propagates() {
        let http = MockHttp::new(vec![Err(TencentFileError::Network("dns fail".into()))]);
        let req = CreateRecTaskRequest::new_local("aGVsbG8=", 5);
        let err = submit_create_task(&http, "sid", "skey", None, &req).await.unwrap_err();
        assert!(matches!(err, TencentFileError::Network(_)));
        assert_eq!(err.code(), "tencent_network_error");
    }

    #[tokio::test]
    async fn poll_waiting_doing_success_path() {
        let waiting = r#"{"Response":{"RequestId":"r1","Data":{"TaskId":1,"Status":0,"StatusStr":"waiting","AudioDuration":0,"Result":"","ErrorMsg":"","ResultDetail":[]}}}"#;
        let doing = r#"{"Response":{"RequestId":"r2","Data":{"TaskId":1,"Status":1,"StatusStr":"doing","AudioDuration":0,"Result":"","ErrorMsg":"","ResultDetail":[]}}}"#;
        let success = r#"{"Response":{"RequestId":"r3","Data":{"TaskId":1,"Status":2,"StatusStr":"success","AudioDuration":2.38,"Result":"[0:0.020,0:2.380]  腾讯云语音识别欢迎您。\n","ResultDetail":[{"FinalSentence":"腾讯云语音识别欢迎您。","SliceSentence":"","StartMs":20,"EndMs":2380,"SpeakerId":0}],"ErrorMsg":""}}}"#;
        let http = MockHttp::new(vec![Ok(waiting.into()), Ok(doing.into()), Ok(success.into())]);
        let resp = poll_until_terminal(
            &http,
            &ZeroSleeper,
            "sid",
            "skey",
            None,
            1,
            Duration::from_millis(0),
            Instant::now() + Duration::from_secs(60),
        )
        .await
        .unwrap();
        let data = resp.response.data.unwrap();
        assert_eq!(data.status, 2);
        assert_eq!(merge_result_detail(&data.result_detail), "腾讯云语音识别欢迎您。");
        // 三次轮询全打到 mock
        assert_eq!(http.captured_actions.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn poll_failed_returns_task_failed_with_msg() {
        let failed = r#"{"Response":{"RequestId":"r","Data":{"TaskId":1,"Status":3,"StatusStr":"failed","AudioDuration":0,"Result":"","ErrorMsg":"Failed to download audio file!","ResultDetail":[]}}}"#;
        let http = MockHttp::new(vec![Ok(failed.into())]);
        let err = poll_until_terminal(
            &http,
            &ZeroSleeper,
            "sid",
            "skey",
            None,
            1,
            Duration::from_millis(0),
            Instant::now() + Duration::from_secs(60),
        )
        .await
        .unwrap_err();
        match err {
            TencentFileError::TaskFailed { msg } => {
                assert!(msg.contains("Failed to download"), "got {msg}")
            }
            other => panic!("expected TaskFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn poll_deadline_returns_timeout() {
        // 一直返 waiting，deadline 过去就 Timeout
        let waiting = r#"{"Response":{"RequestId":"r","Data":{"TaskId":1,"Status":0,"StatusStr":"waiting","AudioDuration":0,"Result":"","ErrorMsg":"","ResultDetail":[]}}}"#;
        let http = MockHttp::new(vec![Ok(waiting.into()), Ok(waiting.into()), Ok(waiting.into())]);
        let already_past = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let err = poll_until_terminal(
            &http,
            &ZeroSleeper,
            "sid",
            "skey",
            None,
            1,
            Duration::from_millis(0),
            already_past,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, TencentFileError::Timeout));
        assert_eq!(err.code(), "tencent_task_timeout");
    }

    #[tokio::test]
    async fn poll_propagates_auth_failure_from_query() {
        let auth_err = r#"{"Response":{"RequestId":"r","Error":{"Code":"AuthFailure.SignatureFailure","Message":"bad sig"}}}"#;
        let http = MockHttp::new(vec![Ok(auth_err.into())]);
        let err = poll_until_terminal(
            &http,
            &ZeroSleeper,
            "sid",
            "skey",
            None,
            1,
            Duration::from_millis(0),
            Instant::now() + Duration::from_secs(60),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, TencentFileError::Unauthenticated(_)));
    }
}
