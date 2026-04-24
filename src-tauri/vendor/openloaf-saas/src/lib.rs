//! OpenLoaf SaaS Rust SDK — safe wrapper.
//!
//! 这层是 **开源** 的。所有业务实现在预编译好的 `libopenloaf_saas_core.a`
//! 里，通过 C ABI 暴露一个 `openloaf_saas_call` dispatcher，本 crate 负责：
//!
//! * 把 Rust 调用组装成 JSON envelope 传给 FFI
//! * 把 FFI 返回的 JSON 解析回类型安全的 Rust 结构体
//! * 暴露和 Node SDK 对齐的模块化 API（`client.auth()` / `client.ai()`）
//!
//! 版本号独立于 Node 包 `@openloaf-saas/sdk`，详见 `CHANGELOG.md`。

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::{Arc, RwLock};

use serde::{Deserialize, Serialize, de::DeserializeOwned};

/// Wrapper 侧声明的 SDK 版本。如果与 core 静态库中嵌入的版本不一致，
/// `check_abi()` 会返回错误。
pub const SDK_VERSION: &str = "0.3.0";

pub mod realtime;
pub use realtime::{RealtimeClient, RealtimeEvent, RealtimeSession};

// ─── FFI 声明（核心静态库导出） ──────────────────────────────────

unsafe extern "C" {
    fn openloaf_saas_call(input_json: *const c_char) -> *mut c_char;
    fn openloaf_saas_free_string(ptr: *mut c_char);
    fn openloaf_saas_version() -> *const c_char;
}

// ─── 错误类型 ────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum SaaSError {
    /// 网络不可达或传输层错误
    #[error("network error: {0}")]
    Network(String),

    /// HTTP 非 2xx
    #[error("http {status}: {message}")]
    Http {
        status: u16,
        message: String,
        body: Option<serde_json::Value>,
    },

    /// JSON 解析失败或响应体类型不符
    #[error("decode error: {0}")]
    Decode(String),

    /// wrapper 侧输入参数非法（如 NUL 字节）
    #[error("input error: {0}")]
    Input(String),

    /// wrapper 和 core 静态库版本不一致
    #[error("abi mismatch: wrapper={wrapper}, core={core}")]
    AbiMismatch { wrapper: String, core: String },
}

impl From<serde_json::Error> for SaaSError {
    fn from(e: serde_json::Error) -> Self {
        SaaSError::Decode(e.to_string())
    }
}

pub type SaaSResult<T> = Result<T, SaaSError>;

// ─── 共享数据类型 ────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthClientInfo {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extra: Option<HashMap<String, String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthUser {
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub is_admin: Option<bool>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthSession {
    pub access_token: String,
    pub refresh_token: String,
    pub user: AuthUser,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AuthLogoutResponse {
    pub success: bool,
}

// ─── 用户接口类型 ────────────────────────────────────────────────

/// 会员等级枚举，对标服务端 `userMembershipLevelSchema`。
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum UserMembershipLevel {
    Free,
    Lite,
    Pro,
    Premium,
}

/// 当前登录用户信息，对应 `GET /api/user/self` 响应里的 `user` 字段。
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UserSelf {
    pub id: String,
    #[serde(default)]
    pub email: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub avatar_url: Option<String>,
    pub provider: String,
    pub membership_level: UserMembershipLevel,
    #[serde(default)]
    pub is_internal: Option<bool>,
    pub credits_balance: f64,
    pub is_admin: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// 完整响应信封。
#[derive(Debug, Clone, Deserialize)]
pub struct UserSelfResponse {
    pub user: UserSelf,
}

/// 构造 OAuth start URL 时的可选参数。
#[derive(Debug, Clone, Default)]
pub struct OAuthStartOptions {
    /// `"web"` / `"electron"` / `"desktop"` 等。桌面端通常传 `"electron"` 并配合 `port`。
    pub from: Option<String>,
    /// 桌面端本地回调端口。
    pub port: Option<u16>,
    /// 自定义返回路径（Web 场景），默认由服务端决定。
    pub return_to: Option<String>,
}

impl OAuthStartOptions {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn from(mut self, from: impl Into<String>) -> Self {
        self.from = Some(from.into());
        self
    }

    pub fn port(mut self, port: u16) -> Self {
        self.port = Some(port);
        self
    }

    pub fn return_to(mut self, return_to: impl Into<String>) -> Self {
        self.return_to = Some(return_to.into());
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct V3ToolExecuteRequest {
    pub feature: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub variant: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inputs: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

impl V3ToolExecuteRequest {
    pub fn new(feature: impl Into<String>) -> Self {
        Self {
            feature: feature.into(),
            variant: None,
            inputs: None,
            params: None,
        }
    }

    pub fn with_variant(mut self, variant: impl Into<String>) -> Self {
        self.variant = Some(variant.into());
        self
    }

    pub fn with_inputs(mut self, inputs: serde_json::Value) -> Self {
        self.inputs = Some(inputs);
        self
    }

    pub fn with_params(mut self, params: serde_json::Value) -> Self {
        self.params = Some(params);
        self
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3ToolExecuteResponse {
    pub success: bool,
    pub variant_id: String,
    pub credits_consumed: f64,
    pub data: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3SyncToolFeature {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub endpoint: String,
    pub credits_per_call: f64,
    pub billing_type: String,
    pub min_membership_level: String,
    #[serde(default)]
    pub input_slots: serde_json::Value,
    #[serde(default)]
    pub params_schema: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3RealtimeToolFeature {
    pub id: String,
    pub display_name: String,
    pub description: String,
    pub endpoint: String,
    pub credits_per_minute: f64,
    pub billing_type: String,
    pub min_membership_level: String,
    pub min_session_minutes: f64,
    pub max_session_seconds: f64,
    pub audio_format: serde_json::Value,
    #[serde(default)]
    pub input_slots: serde_json::Value,
    #[serde(default)]
    pub params_schema: serde_json::Value,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "executionMode", rename_all = "lowercase")]
pub enum V3ToolFeature {
    Sync(V3SyncToolFeature),
    Realtime(V3RealtimeToolFeature),
}

impl V3ToolFeature {
    pub fn id(&self) -> &str {
        match self {
            V3ToolFeature::Sync(f) => &f.id,
            V3ToolFeature::Realtime(f) => &f.id,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V3ToolsCapabilitiesData {
    pub category: String,
    pub features: Vec<V3ToolFeature>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct V3ToolsCapabilitiesResponse {
    pub success: bool,
    pub data: V3ToolsCapabilitiesData,
}

// ─── 客户端 ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Default)]
pub struct SaaSClientConfig {
    pub base_url: String,
    pub access_token: Option<String>,
    pub locale: Option<String>,
}

pub(crate) struct ClientInner {
    pub(crate) base_url: String,
    pub(crate) access_token: RwLock<Option<String>>,
    pub(crate) locale: Option<String>,
}

#[derive(Clone)]
pub struct SaaSClient {
    inner: Arc<ClientInner>,
}

impl SaaSClient {
    pub fn new(config: SaaSClientConfig) -> Self {
        Self {
            inner: Arc::new(ClientInner {
                base_url: trim_trailing_slash(&config.base_url),
                access_token: RwLock::new(config.access_token),
                locale: config.locale,
            }),
        }
    }

    pub fn with_base_url(base_url: impl Into<String>) -> Self {
        Self::new(SaaSClientConfig {
            base_url: base_url.into(),
            ..Default::default()
        })
    }

    pub fn set_access_token(&self, token: Option<String>) {
        if let Ok(mut guard) = self.inner.access_token.write() {
            *guard = token;
        }
    }

    pub fn access_token(&self) -> Option<String> {
        self.inner
            .access_token
            .read()
            .ok()
            .and_then(|g| g.clone())
    }

    pub fn auth(&self) -> AuthClient {
        AuthClient {
            inner: self.inner.clone(),
        }
    }

    pub fn ai(&self) -> AiClient {
        AiClient {
            inner: self.inner.clone(),
        }
    }

    /// 当前登录用户相关接口（`user.*`）。
    pub fn user(&self) -> UserClient {
        UserClient {
            inner: self.inner.clone(),
        }
    }

    /// 获取 realtime 工具入口（WebSocket），对应服务端 `/api/ai/v3/tools/stream`。
    pub fn realtime(&self) -> RealtimeClient {
        RealtimeClient {
            inner: self.inner.clone(),
        }
    }
}

/// 校验 wrapper 和 core 静态库的版本是否一致。推荐 app 启动时调用一次。
pub fn check_abi() -> SaaSResult<()> {
    let core_ver = core_version();
    if core_ver != SDK_VERSION {
        Err(SaaSError::AbiMismatch {
            wrapper: SDK_VERSION.to_string(),
            core: core_ver,
        })
    } else {
        Ok(())
    }
}

/// 读取 core 静态库里嵌入的版本号
pub fn core_version() -> String {
    // safety: openloaf_saas_version 返回静态字符串，调用方不得 free
    unsafe {
        let ptr = openloaf_saas_version();
        CStr::from_ptr(ptr).to_string_lossy().into_owned()
    }
}

// ─── 子模块 ──────────────────────────────────────────────────────

pub struct AuthClient {
    inner: Arc<ClientInner>,
}

impl AuthClient {
    pub fn exchange(
        &self,
        login_code: &str,
        client_info: Option<&AuthClientInfo>,
    ) -> SaaSResult<AuthSession> {
        let payload = serde_json::json!({
            "loginCode": login_code,
            "clientInfo": client_info,
        });
        call(&self.inner, "auth.exchange", payload)
    }

    pub fn refresh(
        &self,
        refresh_token: &str,
        client_info: Option<&AuthClientInfo>,
    ) -> SaaSResult<AuthSession> {
        let payload = serde_json::json!({
            "refreshToken": refresh_token,
            "clientInfo": client_info,
        });
        call(&self.inner, "auth.refresh", payload)
    }

    pub fn logout(&self, refresh_token: &str) -> SaaSResult<AuthLogoutResponse> {
        let payload = serde_json::json!({ "refreshToken": refresh_token });
        call(&self.inner, "auth.logout", payload)
    }

    /// 构造 Google OAuth start URL。**不发起网络请求** —— 桌面端可直接 open 浏览器。
    pub fn google_start_url(&self, opts: &OAuthStartOptions) -> SaaSResult<String> {
        build_oauth_start_url(&self.inner.base_url, "/api/auth/google/start", opts)
    }

    /// 构造微信 OAuth start URL（不发起网络请求）。
    pub fn wechat_start_url(&self, opts: &OAuthStartOptions) -> SaaSResult<String> {
        build_oauth_start_url(&self.inner.base_url, "/api/auth/wechat/start", opts)
    }

    /// 构造 dev 环境免登 URL（**仅开发环境有效**，生产环境不要使用）。
    pub fn dev_start_url(&self, opts: &OAuthStartOptions) -> SaaSResult<String> {
        build_oauth_start_url(&self.inner.base_url, "/api/auth/dev/start", opts)
    }
}

/// 用户相关接口。
pub struct UserClient {
    inner: Arc<ClientInner>,
}

impl UserClient {
    /// 拉取当前登录用户信息（对应 `GET /api/user/self`）。
    pub fn current(&self) -> SaaSResult<UserSelfResponse> {
        call(&self.inner, "user.self", serde_json::Value::Null)
    }
}

/// 内部工具：把 `base_url + path + opts` 拼成一个 OAuth start URL。
/// 关键逻辑：OAuth start 端点在服务端只是做参数拼接 + 302，SDK 端纯字符串构造即可，
/// 不需要走 FFI 或真实发网络请求。
fn build_oauth_start_url(
    base_url: &str,
    path: &str,
    opts: &OAuthStartOptions,
) -> SaaSResult<String> {
    let mut url = url::Url::parse(base_url)
        .map_err(|e| SaaSError::Input(format!("invalid base_url: {e}")))?;
    url.set_path(path);
    {
        let mut q = url.query_pairs_mut();
        q.clear();
        if let Some(from) = &opts.from {
            q.append_pair("from", from);
        }
        if let Some(port) = opts.port {
            q.append_pair("port", &port.to_string());
        }
        if let Some(return_to) = &opts.return_to {
            q.append_pair("returnTo", return_to);
        }
    }
    // 若没有任何参数，清理尾部 `?`
    if url.query().is_some_and(str::is_empty) {
        url.set_query(None);
    }
    Ok(url.to_string())
}

pub struct AiClient {
    inner: Arc<ClientInner>,
}

impl AiClient {
    pub fn tools_capabilities(&self) -> SaaSResult<V3ToolsCapabilitiesResponse> {
        call(&self.inner, "ai.toolsCapabilities", serde_json::Value::Null)
    }

    pub fn v3_tool_execute(
        &self,
        payload: &V3ToolExecuteRequest,
    ) -> SaaSResult<V3ToolExecuteResponse> {
        let value = serde_json::to_value(payload)?;
        call(&self.inner, "ai.v3ToolExecute", value)
    }
}

// ─── FFI 调度 ────────────────────────────────────────────────────

#[derive(Deserialize)]
enum FfiOutput {
    #[serde(rename = "ok")]
    Ok(serde_json::Value),
    #[serde(rename = "err")]
    Err(FfiError),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct FfiError {
    kind: String,
    message: String,
    #[serde(default)]
    status: Option<u16>,
    #[serde(default)]
    body: Option<serde_json::Value>,
}

impl FfiError {
    fn into_saas_error(self) -> SaaSError {
        match self.kind.as_str() {
            "http" => SaaSError::Http {
                status: self.status.unwrap_or(0),
                message: self.message,
                body: self.body,
            },
            "network" => SaaSError::Network(self.message),
            "decode" => SaaSError::Decode(self.message),
            _ => SaaSError::Input(self.message),
        }
    }
}

fn call<R: DeserializeOwned>(
    inner: &ClientInner,
    method: &str,
    payload: serde_json::Value,
) -> SaaSResult<R> {
    let config = {
        let token = inner.access_token.read().ok().and_then(|g| g.clone());
        serde_json::json!({
            "baseUrl": inner.base_url,
            "accessToken": token,
            "locale": inner.locale,
        })
    };
    let envelope = serde_json::json!({
        "method": method,
        "config": config,
        "payload": payload,
    });
    let input_str = serde_json::to_string(&envelope)?;
    let input_c = CString::new(input_str).map_err(|e| SaaSError::Input(e.to_string()))?;

    // safety: openloaf_saas_call 返回堆分配的 C 字符串，用完必须 free
    let raw = unsafe { openloaf_saas_call(input_c.as_ptr()) };
    if raw.is_null() {
        return Err(SaaSError::Network("FFI returned null".into()));
    }
    let output = unsafe {
        let s = CStr::from_ptr(raw).to_string_lossy().into_owned();
        openloaf_saas_free_string(raw);
        s
    };

    let parsed: FfiOutput = serde_json::from_str(&output)?;
    match parsed {
        FfiOutput::Ok(value) => serde_json::from_value(value).map_err(SaaSError::from),
        FfiOutput::Err(err) => Err(err.into_saas_error()),
    }
}

fn trim_trailing_slash(s: &str) -> String {
    let mut out = s.to_string();
    while out.ends_with('/') {
        out.pop();
    }
    out
}
