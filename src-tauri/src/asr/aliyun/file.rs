// 阿里 DashScope filetrans（paraformer-v2）异步任务调用层。
//
// 协议见 docs/cloud-endpoints.md「阿里 DashScope BYOK」章节。E2E 已验证（byok_e2e.rs）。
//
// - 提交：POST /api/v1/services/audio/asr/transcription
//   Header: Authorization: Bearer <ApiKey>
//           Content-Type: application/json
//           X-DashScope-OssResourceResolve: enable    （oss:// URL 必须带）
//           X-DashScope-Async: enable                 （filetrans 只支持异步）
//   Body:   { "model": "paraformer-v2",
//             "input": { "file_urls": ["oss://dashscope-instant/<rest>/<file>"] } }
//   返回:   { "output": { "task_id": "...", "task_status": "PENDING" }, ... }
//
// - 轮询：GET /api/v1/tasks/{task_id}
//   Header: Authorization: Bearer <ApiKey>
//   返回:   task_status ∈ { PENDING | RUNNING | SUCCEEDED | FAILED | UNKNOWN }
//           SUCCEEDED 时：output.results[*].transcription_url 是个 OSS 临时签名 URL，
//           GET 一下拿真正的 transcription JSON：transcripts[*].text 拼起来即文本。
//           （早期一些 DashScope 模型把 transcription 直接平铺在 results[]，paraformer-v2
//           没有，所以 merge_transcriptions 兜不住，必须二级 fetch。）

use serde::Deserialize;
use std::time::{Duration, Instant};

const SUBMIT_URL: &str = "https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription";
const TASKS_URL: &str = "https://dashscope.aliyuncs.com/api/v1/tasks/";
/// DashScope 公网 BYOK 直连用的模型 id。SaaS 内部用的是 `qwen3-asr-flash-filetrans`
/// 这种别名，公网直连不识别（会得到 InvalidParameter.MalformedURL，迷惑性很强）。
pub const FILETRANS_MODEL: &str = "paraformer-v2";

#[derive(Debug, Clone)]
pub enum FileTransError {
    Unauthenticated(String),
    TaskFailed { msg: String },
    Timeout,
    RateLimited,
    Network(String),
    Decode(String),
}

impl FileTransError {
    #[allow(dead_code)] // 错误码 string 由 Display 主导；code() 留给将来按错误类型分流
    pub fn code(&self) -> &'static str {
        match self {
            FileTransError::Unauthenticated(_) => "aliyun_unauthenticated",
            FileTransError::TaskFailed { .. } => "aliyun_filetrans_failed",
            FileTransError::Timeout => "aliyun_filetrans_timeout",
            FileTransError::RateLimited => "aliyun_rate_limited",
            FileTransError::Network(_) => "aliyun_network_error",
            FileTransError::Decode(_) => "aliyun_filetrans_failed",
        }
    }
}

impl std::fmt::Display for FileTransError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            FileTransError::Unauthenticated(m) => write!(f, "aliyun_unauthenticated: {m}"),
            FileTransError::TaskFailed { msg } => write!(f, "aliyun_filetrans_failed: {msg}"),
            FileTransError::Timeout => write!(f, "aliyun_filetrans_timeout"),
            FileTransError::RateLimited => write!(f, "aliyun_rate_limited"),
            FileTransError::Network(m) => write!(f, "aliyun_network_error: {m}"),
            FileTransError::Decode(m) => write!(f, "aliyun_filetrans_failed: decode {m}"),
        }
    }
}

impl std::error::Error for FileTransError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskStatus {
    Pending,
    Running,
    Succeeded,
    Failed,
    Unknown,
}

impl TaskStatus {
    pub fn from_str(s: &str) -> Self {
        match s.to_ascii_uppercase().as_str() {
            "PENDING" => Self::Pending,
            "RUNNING" => Self::Running,
            "SUCCEEDED" | "SUCCESS" => Self::Succeeded,
            "FAILED" | "ERROR" => Self::Failed,
            _ => Self::Unknown,
        }
    }

    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Succeeded | Self::Failed)
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubmitResponse {
    pub output: SubmitOutput,
    #[serde(default)]
    #[allow(dead_code)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SubmitOutput {
    pub task_id: String,
    #[serde(default)]
    pub task_status: String,
    /// 提交阶段就 reject 时（少见，多发生在 url 校验失败），DashScope 会直接平铺 code/message。
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaskResponse {
    pub output: TaskOutput,
    #[serde(default)]
    #[allow(dead_code)]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TaskOutput {
    #[serde(default)]
    #[allow(dead_code)]
    pub task_id: String,
    pub task_status: String,
    #[serde(default)]
    pub results: Vec<TaskResult>,
    /// 终态 FAILED 时 DashScope 在 output 上挂 code/message。
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)] // 字段全是 serde 反序列化目标 + 协议形状文档；transcription_url 是主路径用
pub struct TaskResult {
    #[serde(default)]
    pub file_url: Option<String>,
    #[serde(default)]
    pub subtask_status: Option<String>,
    /// 早期模型的内联 transcription 字段。paraformer-v2 始终为空，必须走 transcription_url。
    #[serde(default)]
    pub transcription: Option<String>,
    /// paraformer-v2 真正的输出口：OSS 临时签名 URL，GET 后内容是
    /// `{ "transcripts": [{"text": "...", "sentences": [...]}] }`。
    #[serde(default)]
    pub transcription_url: Option<String>,
    #[serde(default)]
    pub code: Option<String>,
    #[serde(default)]
    pub message: Option<String>,
}

/// transcription_url 指向的 JSON 结构（DashScope paraformer-v2 输出格式）。
#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptionPayload {
    #[serde(default)]
    pub transcripts: Vec<TranscriptEntry>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TranscriptEntry {
    #[serde(default)]
    pub text: String,
}

/// 把 results[*].transcription 顺序拼成纯文本（仅对内联版本有效；paraformer-v2 永远是空）。
#[allow(dead_code)] // paraformer-v2 走 fetch_transcription 二级；保留它给 paraformer-v1 / sensevoice 等内联模型
pub fn merge_transcriptions(results: &[TaskResult]) -> String {
    results
        .iter()
        .filter_map(|r| r.transcription.as_deref().filter(|s| !s.is_empty()))
        .collect::<Vec<_>>()
        .join("")
}

/// paraformer-v2 兼容版：把 transcription_url 对应的 JSON 里 transcripts[*].text 拼起来。
pub fn merge_transcripts_payload(payloads: &[TranscriptionPayload]) -> String {
    payloads
        .iter()
        .flat_map(|p| p.transcripts.iter())
        .map(|t| t.text.as_str())
        .collect::<Vec<_>>()
        .join("")
}

#[async_trait::async_trait]
pub trait DashScopeClient: Send + Sync {
    async fn submit_filetrans(
        &self,
        api_key: &str,
        oss_urls: &[String],
        language_hints: &[String],
    ) -> Result<String, FileTransError>;

    async fn query_task(
        &self,
        api_key: &str,
        task_id: &str,
    ) -> Result<TaskOutput, FileTransError>;

    /// 拉 transcription_url 指向的 OSS JSON。这是 paraformer-v2 唯一能拿到正文
    /// 的路径——/api/v1/tasks/{id} 的 results[*].transcription 永远是空。
    async fn fetch_transcription(
        &self,
        url: &str,
    ) -> Result<TranscriptionPayload, FileTransError>;
}

pub struct ReqwestDashScopeClient {
    client: reqwest::Client,
}

impl ReqwestDashScopeClient {
    pub fn new() -> Result<Self, FileTransError> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| FileTransError::Network(e.to_string()))?;
        Ok(Self { client })
    }

    #[allow(dead_code)]
    pub fn from_client(client: reqwest::Client) -> Self {
        Self { client }
    }
}

fn build_submit_body(oss_urls: &[String], language_hints: &[String]) -> String {
    let mut body = serde_json::json!({
        "model": FILETRANS_MODEL,
        "input": { "file_urls": oss_urls },
    });
    if !language_hints.is_empty() {
        body["parameters"] = serde_json::json!({ "language_hints": language_hints });
    }
    body.to_string()
}

#[async_trait::async_trait]
impl DashScopeClient for ReqwestDashScopeClient {
    async fn submit_filetrans(
        &self,
        api_key: &str,
        oss_urls: &[String],
        language_hints: &[String],
    ) -> Result<String, FileTransError> {
        let body = build_submit_body(oss_urls, language_hints);
        let resp = self
            .client
            .post(SUBMIT_URL)
            .header("Authorization", format!("Bearer {api_key}"))
            .header("Content-Type", "application/json")
            // 关键 header：oss:// URL 必须显式 enable，否则服务端拒收。
            .header("X-DashScope-OssResourceResolve", "enable")
            // filetrans endpoint 只支持异步提交（返回 task_id 走轮询），不带这个
            // header 服务端按同步处理，会报 AccessDenied "current user api does not
            // support synchronous calls"。
            .header("X-DashScope-Async", "enable")
            .body(body)
            .send()
            .await
            .map_err(|e| FileTransError::Network(e.to_string()))?;
        let status = resp.status();
        let raw = resp
            .text()
            .await
            .map_err(|e| FileTransError::Network(e.to_string()))?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(FileTransError::Unauthenticated(format!(
                "HTTP {status}: {raw}"
            )));
        }
        if status.as_u16() == 429 {
            return Err(FileTransError::RateLimited);
        }
        if !status.is_success() {
            return Err(FileTransError::Network(format!("HTTP {status}: {raw}")));
        }
        parse_submit_response(&raw)
    }

    async fn query_task(
        &self,
        api_key: &str,
        task_id: &str,
    ) -> Result<TaskOutput, FileTransError> {
        let url = format!("{TASKS_URL}{task_id}");
        let resp = self
            .client
            .get(&url)
            .header("Authorization", format!("Bearer {api_key}"))
            .send()
            .await
            .map_err(|e| FileTransError::Network(e.to_string()))?;
        let status = resp.status();
        let raw = resp
            .text()
            .await
            .map_err(|e| FileTransError::Network(e.to_string()))?;
        if status.as_u16() == 401 || status.as_u16() == 403 {
            return Err(FileTransError::Unauthenticated(format!(
                "HTTP {status}: {raw}"
            )));
        }
        if status.as_u16() == 429 {
            return Err(FileTransError::RateLimited);
        }
        if !status.is_success() {
            return Err(FileTransError::Network(format!("HTTP {status}: {raw}")));
        }
        let resp: TaskResponse = serde_json::from_str(&raw)
            .map_err(|e| FileTransError::Decode(format!("query_task: {e}; body={raw}")))?;
        Ok(resp.output)
    }

    async fn fetch_transcription(
        &self,
        url: &str,
    ) -> Result<TranscriptionPayload, FileTransError> {
        // OSS 临时签名 URL，自带认证；不要带 Bearer，否则签名校验冲突。
        let resp = self
            .client
            .get(url)
            .send()
            .await
            .map_err(|e| FileTransError::Network(e.to_string()))?;
        let status = resp.status();
        let raw = resp
            .text()
            .await
            .map_err(|e| FileTransError::Network(e.to_string()))?;
        if !status.is_success() {
            return Err(FileTransError::Network(format!(
                "transcription_url HTTP {status}: {raw}"
            )));
        }
        serde_json::from_str(&raw)
            .map_err(|e| FileTransError::Decode(format!("transcription payload: {e}; body={raw}")))
    }
}

pub fn parse_submit_response(raw: &str) -> Result<String, FileTransError> {
    let resp: SubmitResponse = serde_json::from_str(raw)
        .map_err(|e| FileTransError::Decode(format!("submit: {e}; body={raw}")))?;
    if let Some(code) = &resp.output.code
        && !code.is_empty()
        && !TaskStatus::from_str(&resp.output.task_status).is_terminal()
        && resp.output.task_id.is_empty()
    {
        // 部分错误会平铺 code/message 而无 task_id：直接归为 TaskFailed。
        let msg = resp.output.message.clone().unwrap_or_default();
        return Err(FileTransError::TaskFailed {
            msg: format!("{code}: {msg}"),
        });
    }
    if resp.output.task_id.is_empty() {
        let code = resp.output.code.clone().unwrap_or_default();
        let msg = resp.output.message.clone().unwrap_or_default();
        return Err(FileTransError::TaskFailed {
            msg: format!("{code}: {msg}"),
        });
    }
    Ok(resp.output.task_id)
}

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

/// 轮询直到任务进入终态或 deadline。
pub async fn poll_task_until_terminal(
    client: &dyn DashScopeClient,
    sleeper: &dyn Sleeper,
    api_key: &str,
    task_id: &str,
    interval: Duration,
    deadline: Instant,
) -> Result<TaskOutput, FileTransError> {
    loop {
        let out = client.query_task(api_key, task_id).await?;
        match TaskStatus::from_str(&out.task_status) {
            TaskStatus::Succeeded => return Ok(out),
            TaskStatus::Failed => {
                let code = out.code.clone().unwrap_or_default();
                let msg = out.message.clone().unwrap_or_default();
                let detail = if code.is_empty() && msg.is_empty() {
                    out.task_status.clone()
                } else {
                    format!("{code}: {msg}")
                };
                return Err(FileTransError::TaskFailed { msg: detail });
            }
            TaskStatus::Pending | TaskStatus::Running | TaskStatus::Unknown => {}
        }
        if Instant::now() >= deadline {
            return Err(FileTransError::Timeout);
        }
        sleeper.sleep(interval).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    // ─── 单元解析 ──────────────────────────────────────────

    #[test]
    fn task_status_normalization() {
        assert_eq!(TaskStatus::from_str("PENDING"), TaskStatus::Pending);
        assert_eq!(TaskStatus::from_str("running"), TaskStatus::Running);
        assert_eq!(TaskStatus::from_str("SUCCEEDED"), TaskStatus::Succeeded);
        assert_eq!(TaskStatus::from_str("Success"), TaskStatus::Succeeded);
        assert_eq!(TaskStatus::from_str("FAILED"), TaskStatus::Failed);
        assert_eq!(TaskStatus::from_str("ERROR"), TaskStatus::Failed);
        assert_eq!(TaskStatus::from_str("???"), TaskStatus::Unknown);
        assert!(TaskStatus::Succeeded.is_terminal());
        assert!(TaskStatus::Failed.is_terminal());
        assert!(!TaskStatus::Pending.is_terminal());
        assert!(!TaskStatus::Running.is_terminal());
    }

    #[test]
    fn submit_body_shape() {
        let body = build_submit_body(&["oss://b/k".into()], &[]);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["model"], FILETRANS_MODEL);
        assert_eq!(v["input"]["file_urls"][0], "oss://b/k");
        assert!(v.get("parameters").is_none());
    }

    #[test]
    fn submit_body_with_language_hints() {
        let body = build_submit_body(&["oss://b/k".into()], &["en".into()]);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["parameters"]["language_hints"][0], "en");
    }

    #[test]
    fn parse_submit_response_happy_path() {
        let raw = r#"{
            "output": { "task_id": "t-123", "task_status": "PENDING" },
            "request_id": "rid"
        }"#;
        let id = parse_submit_response(raw).unwrap();
        assert_eq!(id, "t-123");
    }

    #[test]
    fn parse_submit_response_missing_task_id_is_task_failed() {
        let raw = r#"{
            "output": { "task_id": "", "task_status": "FAILED",
                        "code": "InvalidParameter", "message": "bad url" }
        }"#;
        let err = parse_submit_response(raw).unwrap_err();
        match err {
            FileTransError::TaskFailed { msg } => {
                assert!(msg.contains("InvalidParameter"));
                assert!(msg.contains("bad url"));
            }
            other => panic!("expected TaskFailed, got {other:?}"),
        }
    }

    #[test]
    fn parse_submit_response_decode_error_on_garbage() {
        let err = parse_submit_response("not json").unwrap_err();
        assert!(matches!(err, FileTransError::Decode(_)));
        assert_eq!(err.code(), "aliyun_filetrans_failed");
    }

    #[test]
    fn merge_transcriptions_skips_empty_and_failed() {
        let results = vec![
            TaskResult {
                file_url: None,
                subtask_status: Some("SUCCEEDED".into()),
                transcription: Some("你好".into()),
                transcription_url: None,
                code: None,
                message: None,
            },
            TaskResult {
                file_url: None,
                subtask_status: Some("FAILED".into()),
                transcription: None,
                transcription_url: None,
                code: Some("TaskFailed".into()),
                message: Some("oops".into()),
            },
            TaskResult {
                file_url: None,
                subtask_status: Some("SUCCEEDED".into()),
                transcription: Some("世界".into()),
                transcription_url: None,
                code: None,
                message: None,
            },
        ];
        assert_eq!(merge_transcriptions(&results), "你好世界");
    }

    #[test]
    fn parse_task_response_succeeded() {
        let raw = r#"{
            "output": {
                "task_id": "t-1", "task_status": "SUCCEEDED",
                "results": [
                    { "file_url": "oss://b/k1", "subtask_status": "SUCCEEDED",
                      "transcription": "你好世界" }
                ]
            },
            "request_id": "r"
        }"#;
        let resp: TaskResponse = serde_json::from_str(raw).unwrap();
        assert_eq!(TaskStatus::from_str(&resp.output.task_status), TaskStatus::Succeeded);
        assert_eq!(merge_transcriptions(&resp.output.results), "你好世界");
    }

    #[test]
    fn error_codes_are_stable() {
        assert_eq!(FileTransError::Unauthenticated("x".into()).code(), "aliyun_unauthenticated");
        assert_eq!(FileTransError::TaskFailed { msg: "x".into() }.code(), "aliyun_filetrans_failed");
        assert_eq!(FileTransError::Timeout.code(), "aliyun_filetrans_timeout");
        assert_eq!(FileTransError::RateLimited.code(), "aliyun_rate_limited");
        assert_eq!(FileTransError::Network("x".into()).code(), "aliyun_network_error");
    }

    // ─── HTTP / 轮询 mock ───────────────────────────────────

    #[allow(dead_code)]
    enum Op {
        Submit(Result<String, FileTransError>),
        Query(Result<TaskOutput, FileTransError>),
    }

    struct MockClient {
        ops: Mutex<Vec<Op>>,
        captured: Mutex<Vec<String>>,
    }

    impl MockClient {
        fn new(ops: Vec<Op>) -> Self {
            Self {
                ops: Mutex::new(ops),
                captured: Mutex::new(Vec::new()),
            }
        }
        fn pop(&self) -> Op {
            let mut q = self.ops.lock().unwrap();
            assert!(!q.is_empty(), "mock exhausted");
            q.remove(0)
        }
    }

    #[async_trait::async_trait]
    impl DashScopeClient for MockClient {
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
                Op::Submit(r) => r,
                Op::Query(_) => panic!("expected Submit op"),
            }
        }

        async fn query_task(
            &self,
            _api_key: &str,
            task_id: &str,
        ) -> Result<TaskOutput, FileTransError> {
            self.captured.lock().unwrap().push(format!("query:{task_id}"));
            match self.pop() {
                Op::Query(r) => r,
                Op::Submit(_) => panic!("expected Query op"),
            }
        }

        async fn fetch_transcription(
            &self,
            _url: &str,
        ) -> Result<TranscriptionPayload, FileTransError> {
            // 测试默认不走 transcription_url 二级 fetch；需要时改用富 mock。
            unimplemented!("MockClient.fetch_transcription not stubbed for this test")
        }
    }

    struct ZeroSleeper;
    #[async_trait::async_trait]
    impl Sleeper for ZeroSleeper {
        async fn sleep(&self, _: Duration) {}
    }

    fn task_output(status: &str, transcript: Option<&str>) -> TaskOutput {
        TaskOutput {
            task_id: "t-1".into(),
            task_status: status.into(),
            results: transcript
                .map(|t| {
                    vec![TaskResult {
                        file_url: None,
                        subtask_status: Some(status.into()),
                        transcription: Some(t.into()),
                        transcription_url: None,
                        code: None,
                        message: None,
                    }]
                })
                .unwrap_or_default(),
            code: None,
            message: None,
        }
    }

    #[tokio::test]
    async fn poll_pending_running_succeeded_path() {
        let mock = MockClient::new(vec![
            Op::Query(Ok(task_output("PENDING", None))),
            Op::Query(Ok(task_output("RUNNING", None))),
            Op::Query(Ok(task_output("SUCCEEDED", Some("你好")))),
        ]);
        let out = poll_task_until_terminal(
            &mock,
            &ZeroSleeper,
            "ak",
            "t-1",
            Duration::from_millis(0),
            Instant::now() + Duration::from_secs(60),
        )
        .await
        .unwrap();
        assert_eq!(merge_transcriptions(&out.results), "你好");
        assert_eq!(mock.captured.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn poll_failed_returns_task_failed() {
        let mut out = task_output("FAILED", None);
        out.code = Some("InternalError".into());
        out.message = Some("oops".into());
        let mock = MockClient::new(vec![Op::Query(Ok(out))]);
        let err = poll_task_until_terminal(
            &mock,
            &ZeroSleeper,
            "ak",
            "t-1",
            Duration::from_millis(0),
            Instant::now() + Duration::from_secs(60),
        )
        .await
        .unwrap_err();
        match err {
            FileTransError::TaskFailed { msg } => {
                assert!(msg.contains("InternalError"));
                assert!(msg.contains("oops"));
            }
            other => panic!("expected TaskFailed, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn poll_deadline_returns_timeout() {
        let mock = MockClient::new(vec![
            Op::Query(Ok(task_output("PENDING", None))),
            Op::Query(Ok(task_output("RUNNING", None))),
            Op::Query(Ok(task_output("PENDING", None))),
        ]);
        let already_past = Instant::now()
            .checked_sub(Duration::from_secs(1))
            .unwrap_or_else(Instant::now);
        let err = poll_task_until_terminal(
            &mock,
            &ZeroSleeper,
            "ak",
            "t-1",
            Duration::from_millis(0),
            already_past,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, FileTransError::Timeout));
        assert_eq!(err.code(), "aliyun_filetrans_timeout");
    }

    #[tokio::test]
    async fn poll_propagates_unauthenticated_from_query() {
        let mock = MockClient::new(vec![Op::Query(Err(FileTransError::Unauthenticated(
            "401".into(),
        )))]);
        let err = poll_task_until_terminal(
            &mock,
            &ZeroSleeper,
            "ak",
            "t-1",
            Duration::from_millis(0),
            Instant::now() + Duration::from_secs(60),
        )
        .await
        .unwrap_err();
        assert!(matches!(err, FileTransError::Unauthenticated(_)));
    }

    #[tokio::test]
    async fn poll_unknown_status_keeps_polling_until_succeed() {
        // 防御性：DashScope 偶尔会返回未在文档列表里的中间状态字符串，
        // 必须按 still-running 处理而非立即报错。
        let mock = MockClient::new(vec![
            Op::Query(Ok(task_output("PROCESSING", None))),
            Op::Query(Ok(task_output("SUCCEEDED", Some("ok")))),
        ]);
        let out = poll_task_until_terminal(
            &mock,
            &ZeroSleeper,
            "ak",
            "t-1",
            Duration::from_millis(0),
            Instant::now() + Duration::from_secs(60),
        )
        .await
        .unwrap();
        assert_eq!(merge_transcriptions(&out.results), "ok");
    }
}
