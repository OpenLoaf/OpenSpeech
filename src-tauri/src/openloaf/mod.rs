// OpenLoaf SaaS 登录集成。
//
// 流程（参考 OpenLoaf/apps/web/src/components/auth/SaasLoginDialog.tsx）：
//   1. 前端 invoke openloaf_start_login({ provider })
//   2. Rust：生成 state UUID，登记到 pending 表，构造 SaaS 登录 URL 返回
//      `https://<BASE>/api/auth/<provider>/start?returnTo=openloaf-login:<state>&from=electron&port=<port>`
//   3. 前端 openUrl(loginUrl) 打开系统浏览器
//   4. 用户完成 OAuth → SaaS 302 到 http://127.0.0.1:<port>/auth/callback?code=...&returnTo=openloaf-login:<state>
//   5. callback.rs 拿到 code + state → 调用本模块的 handle_login_callback
//   6. handle_login_callback：exchange token → 写 Keychain → emit 事件 openspeech://openloaf-login
//   7. 前端通过 listen(event) 得到最终结果
//
// refresh_token 存系统 Keychain；access_token 在 SaaSClient 内部。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use keyring::Entry;
use openloaf_saas::{
    AuthClientInfo, AuthSession, AuthUser, OAuthStartOptions, SaaSClient, SaaSClientConfig,
    SaaSError, SaaSResult, UserMembershipLevel, UserSelf,
};
use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use tauri::{AppHandle, Emitter, Manager, State};

mod callback;

// OpenLoaf SaaS REST 基址。构建期常量，按 build profile 分岔：
//   - debug（`cargo run` / `cargo build`）  → localhost:5180 本地开发服务
//   - release（`cargo build --release`）    → 线上生产服务
// 两者都可用环境变量 OPENLOAF_BASE_URL 覆盖，例：
//   OPENLOAF_BASE_URL=https://staging.openloaf.hexems.com cargo build --release
// 不在这里放机密（只是 URL，安全）。
#[cfg(debug_assertions)]
const FALLBACK_BASE_URL: &str = "http://localhost:5180";
#[cfg(not(debug_assertions))]
const FALLBACK_BASE_URL: &str = "https://openloaf.hexems.com";

const DEFAULT_BASE_URL: &str = match option_env!("OPENLOAF_BASE_URL") {
    Some(v) => v,
    None => FALLBACK_BASE_URL,
};
const APP_ID: &str = "openspeech-desktop";
const LOGIN_EVENT: &str = "openspeech://openloaf-login";
/// 自动 refresh 彻底失败（refresh token 也无效）时广播给前端，让 UI 切回未登录态。
const AUTH_LOST_EVENT: &str = "openspeech://openloaf-auth-lost";

// Keychain service 与 secrets 模块保持一致，按 bundle identifier 归档。
const KEYCHAIN_SERVICE: &str = "com.openspeech.app";
const REFRESH_TOKEN_KEY: &str = "openloaf_refresh_token";

/// 对前端暴露的用户视图；与 SDK 的 AuthUser 一一对应，但 camelCase 输出。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicUser {
    pub name: Option<String>,
    pub email: Option<String>,
    pub avatar_url: Option<String>,
    pub is_admin: Option<bool>,
}

impl From<AuthUser> for PublicUser {
    fn from(u: AuthUser) -> Self {
        Self {
            name: u.name,
            email: u.email,
            avatar_url: u.avatar_url,
            is_admin: u.is_admin,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginProvider {
    Google,
    Wechat,
}

impl LoginProvider {
    fn parse(s: &str) -> Option<Self> {
        match s {
            "google" => Some(Self::Google),
            "wechat" => Some(Self::Wechat),
            _ => None,
        }
    }
}

/// 记录一次进行中的登录流，用于 callback 到达时校验状态未被取消。
struct PendingLogin {
    #[allow(dead_code)] // 目前仅登记，日后日志/重启时会读
    provider: LoginProvider,
    started_at: Instant,
}

pub struct OpenLoafState {
    client: SaaSClient,
    user: Mutex<Option<PublicUser>>,
    pending: Mutex<HashMap<String, PendingLogin>>,
    callback_port: OnceLock<u16>,
    /// 串行化 refresh：并发 401 只会触发一次 refresh，其它调用等它完成后复用新 token。
    refresh_lock: tokio::sync::Mutex<()>,
}

pub type SharedOpenLoaf = Arc<OpenLoafState>;

impl OpenLoafState {
    pub fn new() -> Self {
        let client = SaaSClient::new(SaaSClientConfig {
            base_url: DEFAULT_BASE_URL.into(),
            locale: Some("zh-CN".into()),
            ..Default::default()
        });
        Self {
            client,
            user: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            callback_port: OnceLock::new(),
            refresh_lock: tokio::sync::Mutex::new(()),
        }
    }

    fn set_user(&self, user: Option<PublicUser>) {
        if let Ok(mut g) = self.user.lock() {
            *g = user;
        }
    }

    /// 返回一个已登录状态的 `SaaSClient` 克隆（access_token 已设）。
    /// 未登录返回 None。供 `stt` 等下游模块在不手搓 401 处理的前提下复用同一个客户端
    /// —— SaaSClient 内部 token 是 Arc<RwLock<Option<String>>>，clone 后仍指向同一份，
    /// 所以这里拿到的 client 跟 refresh 线程写入的 token 会自动同步。
    pub fn authenticated_client(&self) -> Option<SaaSClient> {
        self.client.access_token().as_ref()?;
        Some(self.client.clone())
    }

    fn current_user(&self) -> Option<PublicUser> {
        self.user.lock().ok().and_then(|g| g.clone())
    }

    fn insert_pending(&self, state: String, flow: PendingLogin) {
        if let Ok(mut m) = self.pending.lock() {
            m.insert(state, flow);
        }
    }

    fn take_pending(&self, state: &str) -> Option<PendingLogin> {
        self.pending.lock().ok().and_then(|mut m| m.remove(state))
    }

    /// 在 Mutex 内尝试刷新 access token。
    /// - 进入 Mutex 前先记下当前 token，入 Mutex 后再读一次：如果已变化，说明别的任务
    ///   刚刚已经 refresh 成功了，本次直接 true 返回，避免重复请求；
    /// - 否则读 Keychain 里的 refresh_token 发 refresh；成功 → `apply_session` → true；
    /// - Keychain 无 refresh_token 或 refresh 服务端拒绝 → false（由调用方负责清会话）。
    async fn ensure_fresh_token(&self) -> bool {
        let stale = self.client.access_token();
        let _guard = self.refresh_lock.lock().await;

        // Double-check：排队等 Mutex 时别人可能已经 refresh 过。
        let current = self.client.access_token();
        if current.is_some() && current != stale {
            return true;
        }

        let Some(rt) = load_refresh_token() else {
            return false;
        };
        let client = self.client.clone();
        let result = tokio::task::spawn_blocking(move || {
            client.auth().refresh(&rt, Some(&client_info()))
        })
        .await;

        match result {
            Ok(Ok(session)) => {
                apply_session(self, session);
                log::info!("openloaf: access token refreshed");
                true
            }
            Ok(Err(err)) => {
                log::warn!("openloaf: auto-refresh failed: {err}");
                false
            }
            Err(join_err) => {
                log::warn!("openloaf: refresh join error: {join_err}");
                false
            }
        }
    }
}

fn keychain() -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, REFRESH_TOKEN_KEY).map_err(|e| e.to_string())
}

fn load_refresh_token() -> Option<String> {
    keychain().ok()?.get_password().ok()
}

fn save_refresh_token(token: &str) -> Result<(), String> {
    keychain()?.set_password(token).map_err(|e| e.to_string())
}

fn clear_refresh_token() {
    if let Ok(e) = keychain() {
        let _ = e.delete_credential();
    }
}

fn client_info() -> AuthClientInfo {
    AuthClientInfo {
        app_id: Some(APP_ID.into()),
        app_version: Some(env!("CARGO_PKG_VERSION").into()),
        platform: Some(std::env::consts::OS.into()),
        os_version: None,
        extra: None,
    }
}

fn saas_err_to_string(e: SaaSError) -> String {
    e.to_string()
}

/// 把 session 应用到 client + 内存 + Keychain。
fn apply_session(state: &OpenLoafState, session: AuthSession) -> PublicUser {
    state
        .client
        .set_access_token(Some(session.access_token.clone()));
    if let Err(err) = save_refresh_token(&session.refresh_token) {
        log::warn!("openloaf: save refresh token failed: {err}");
    }
    let user: PublicUser = session.user.into();
    state.set_user(Some(user.clone()));
    user
}

fn clear_session(state: &OpenLoafState) {
    state.client.set_access_token(None);
    state.set_user(None);
    clear_refresh_token();
}

// ─── 登录事件 payload ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum LoginEvent {
    Success {
        state: String,
        user: PublicUser,
    },
    Error {
        state: String,
        message: String,
    },
}

// ─── Tauri commands ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StartLoginResult {
    pub login_url: String,
    pub state: String,
}

#[tauri::command]
pub fn openloaf_start_login(
    state: State<'_, SharedOpenLoaf>,
    provider: String,
) -> Result<StartLoginResult, String> {
    let provider = LoginProvider::parse(&provider).ok_or_else(|| "unknown provider".to_string())?;

    let port = state
        .callback_port
        .get()
        .copied()
        .ok_or_else(|| "callback server not ready".to_string())?;

    let login_state = uuid::Uuid::new_v4().to_string();
    state.insert_pending(
        login_state.clone(),
        PendingLogin {
            provider,
            started_at: Instant::now(),
        },
    );

    // SDK 0.3.0 提供了 OAuth start URL 构造器，不发网络请求、纯字符串拼接。
    // returnTo 塞 `openloaf-login:<state>` 让回调 server 从 returnTo 里取回 state。
    let opts = OAuthStartOptions::new()
        .from("electron")
        .port(port)
        .return_to(format!("openloaf-login:{}", login_state));
    let login_url = match provider {
        LoginProvider::Google => state.client.auth().google_start_url(&opts),
        LoginProvider::Wechat => state.client.auth().wechat_start_url(&opts),
    }
    .map_err(saas_err_to_string)?;

    Ok(StartLoginResult {
        login_url,
        state: login_state,
    })
}

#[tauri::command]
pub fn openloaf_cancel_login(state: State<'_, SharedOpenLoaf>, login_state: String) {
    let _ = state.take_pending(&login_state);
}

#[tauri::command]
pub async fn openloaf_logout(state: State<'_, SharedOpenLoaf>) -> Result<(), String> {
    let state = state.inner().clone();
    let token = load_refresh_token();

    // 服务端调用失败也要清本地会话，避免"登不出"。
    if let Some(rt) = token {
        let client = state.client.clone();
        let _ = tokio::task::spawn_blocking(move || client.auth().logout(&rt))
            .await
            .map_err(|e| e.to_string())?;
    }

    clear_session(&state);
    Ok(())
}

#[tauri::command]
pub fn openloaf_current_user(state: State<'_, SharedOpenLoaf>) -> Option<PublicUser> {
    state.current_user()
}

#[tauri::command]
pub fn openloaf_is_authenticated(state: State<'_, SharedOpenLoaf>) -> bool {
    state.client.access_token().is_some()
}

// ─── 用户 profile（含会员等级 / 积分） ──────────────────────────
//
// SDK 0.3.0 封装了 GET /api/user/self，走底层 FFI dispatcher 和 auth 一套路径。

/// 对前端暴露的用户 profile。字段刻意收窄，只吐 UI 需要的部分，
/// 后续要什么再加——避免意外泄露内部状态。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserProfile {
    pub id: String,
    /// 小写字符串：free / lite / pro / premium
    pub membership_level: String,
    pub credits_balance: f64,
    pub avatar_url: Option<String>,
    pub name: Option<String>,
    pub email: Option<String>,
    pub is_admin: bool,
    pub is_internal: Option<bool>,
}

fn membership_level_to_str(level: UserMembershipLevel) -> &'static str {
    match level {
        UserMembershipLevel::Free => "free",
        UserMembershipLevel::Lite => "lite",
        UserMembershipLevel::Pro => "pro",
        UserMembershipLevel::Premium => "premium",
    }
}

impl From<UserSelf> for UserProfile {
    fn from(u: UserSelf) -> Self {
        Self {
            id: u.id,
            membership_level: membership_level_to_str(u.membership_level).to_string(),
            credits_balance: u.credits_balance,
            avatar_url: u.avatar_url,
            name: u.name,
            email: u.email,
            is_admin: u.is_admin,
            is_internal: u.is_internal,
        }
    }
}

#[tauri::command]
pub async fn openloaf_fetch_profile(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
) -> Result<UserProfile, String> {
    let ol = state.inner().clone();
    let resp = call_authed(&app, &ol, |client| client.user().current())
        .await
        .map_err(saas_err_to_string)?;
    Ok(UserProfile::from(resp.user))
}

// ─── 自动 refresh 包装器 ─────────────────────────────────────────
//
// 调 SDK 的任意 REST 方法时，若收到 401：
//   1. 进 ensure_fresh_token：Mutex 内按需发 auth.refresh
//   2. 成功 → 用新 token 重试一次原调用
//   3. refresh 失败 → clear_session + emit AUTH_LOST_EVENT，让前端切未登录态
//
// 业务代码直接 `call_authed(&app, &ol, |client| client.xxx().yyy()).await?`，
// 不再每个 command 手搓 401 处理。

async fn call_authed<T, F>(
    app: &AppHandle,
    ol: &SharedOpenLoaf,
    op: F,
) -> SaaSResult<T>
where
    F: Fn(SaaSClient) -> SaaSResult<T> + Send + Sync + Clone + 'static,
    T: Send + 'static,
{
    if ol.client.access_token().is_none() {
        return Err(SaaSError::Input("not authenticated".into()));
    }

    // 第一次尝试
    let client = ol.client.clone();
    let op_first = op.clone();
    let first = tokio::task::spawn_blocking(move || op_first(client))
        .await
        .map_err(|e| SaaSError::Input(format!("join error: {e}")))?;

    match first {
        Err(SaaSError::Http { status: 401, .. }) => {
            if ol.ensure_fresh_token().await {
                // 成功续期，重试一次
                let client = ol.client.clone();
                tokio::task::spawn_blocking(move || op(client))
                    .await
                    .map_err(|e| SaaSError::Input(format!("join error: {e}")))?
            } else {
                // refresh 也失败 → 登录彻底失效
                clear_session(ol);
                if let Err(e) = app.emit(AUTH_LOST_EVENT, ()) {
                    log::warn!("openloaf: emit auth-lost failed: {e}");
                }
                Err(SaaSError::Http {
                    status: 401,
                    message: "session expired".into(),
                    body: None,
                })
            }
        }
        other => other,
    }
}

// ─── REST JSON helper（未进 SDK 的接口直连，同样带 401 auto-refresh） ───
//
// 目前 payment 模块还在 Node SDK v0.2.x，Rust SDK 0.3.0 还没移植；这些 command
// 先直接用 reqwest 打 REST，等 Rust SDK 补齐后再切回 SDK 调用。调用链和 call_authed
// 同构：401 → ensure_fresh_token → 重试；refresh 失败 → clear_session + auth-lost。

async fn rest_json<Req, Resp>(
    app: &AppHandle,
    ol: &SharedOpenLoaf,
    method: reqwest::Method,
    path: &str,
    body: Option<&Req>,
) -> Result<Resp, String>
where
    Req: Serialize + ?Sized,
    Resp: DeserializeOwned,
{
    let url = format!("{}{}", DEFAULT_BASE_URL, path);
    // JSON 序列化一次，两次尝试共用。
    let body_value = match body {
        Some(b) => Some(serde_json::to_value(b).map_err(|e| e.to_string())?),
        None => None,
    };

    async fn one_shot<T: DeserializeOwned>(
        token: &str,
        url: &str,
        method: reqwest::Method,
        body_value: Option<&serde_json::Value>,
    ) -> Result<Option<T>, String> {
        // Ok(Some) 正常；Ok(None) 401；Err 其他错误。
        let mut req = reqwest::Client::new()
            .request(method, url)
            .bearer_auth(token)
            .header("Accept-Language", "zh-CN");
        if let Some(v) = body_value {
            req = req.json(v);
        }
        let resp = req.send().await.map_err(|e| e.to_string())?;
        if resp.status() == reqwest::StatusCode::UNAUTHORIZED {
            return Ok(None);
        }
        if !resp.status().is_success() {
            let s = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(format!("HTTP {s}: {text}"));
        }
        let parsed: T = resp.json().await.map_err(|e| e.to_string())?;
        Ok(Some(parsed))
    }

    let token = ol
        .client
        .access_token()
        .ok_or_else(|| "not authenticated".to_string())?;
    let first: Option<Resp> =
        one_shot(&token, &url, method.clone(), body_value.as_ref()).await?;
    if let Some(val) = first {
        return Ok(val);
    }

    // 401：尝试 refresh 后再试一次。
    if !ol.ensure_fresh_token().await {
        clear_session(ol);
        if let Err(e) = app.emit(AUTH_LOST_EVENT, ()) {
            log::warn!("openloaf: emit auth-lost failed: {e}");
        }
        return Err("session expired".into());
    }
    let token2 = ol
        .client
        .access_token()
        .ok_or_else(|| "not authenticated".to_string())?;
    let second: Option<Resp> = one_shot(&token2, &url, method, body_value.as_ref()).await?;
    second.ok_or_else(|| "still 401 after refresh".into())
}

// ─── 支付 / 订阅 ────────────────────────────────────────────────

/// 响应统一是 `{ success, data: {...} }`。
#[derive(Debug, Deserialize)]
struct ApiEnvelope<T> {
    #[serde(default)]
    #[allow(dead_code)]
    success: Option<bool>,
    data: T,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawProviderData {
    #[serde(default)]
    code_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawOrderResult {
    order_id: String,
    #[serde(default)]
    provider_data: Option<RawProviderData>,
    #[serde(default)]
    upgrade_payable: Option<f64>,
}

/// 扁平结构吐给前端，避免前端再扒 providerData。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentOrder {
    pub order_id: String,
    pub code_url: Option<String>,
    /// 仅 upgrade 接口会填：补差价金额（元）。
    pub upgrade_payable: Option<f64>,
}

impl From<RawOrderResult> for PaymentOrder {
    fn from(r: RawOrderResult) -> Self {
        Self {
            order_id: r.order_id,
            code_url: r.provider_data.and_then(|p| p.code_url),
            upgrade_payable: r.upgrade_payable,
        }
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentOrderStatus {
    pub order_id: String,
    /// "pending" | "paid" | "refunded" | "closed" | "failed"
    pub status: String,
    /// "subscription" | "recharge" | "upgrade"
    #[serde(default)]
    pub r#type: Option<String>,
    #[serde(default)]
    pub amount: Option<f64>,
    #[serde(default)]
    pub paid_at: Option<String>,
}

#[tauri::command]
pub async fn openloaf_payment_subscribe(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
    plan_code: String,
    period: String,
) -> Result<PaymentOrder, String> {
    let ol = state.inner().clone();
    let body = serde_json::json!({ "planCode": plan_code, "period": period });
    let env: ApiEnvelope<RawOrderResult> = rest_json(
        &app,
        &ol,
        reqwest::Method::POST,
        "/api/payment/subscribe",
        Some(&body),
    )
    .await?;
    Ok(env.data.into())
}

#[tauri::command]
pub async fn openloaf_payment_recharge(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
    amount: f64,
) -> Result<PaymentOrder, String> {
    let ol = state.inner().clone();
    let body = serde_json::json!({ "amount": amount });
    let env: ApiEnvelope<RawOrderResult> = rest_json(
        &app,
        &ol,
        reqwest::Method::POST,
        "/api/payment/recharge",
        Some(&body),
    )
    .await?;
    Ok(env.data.into())
}

#[tauri::command]
pub async fn openloaf_payment_upgrade(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
    new_plan_code: String,
) -> Result<PaymentOrder, String> {
    let ol = state.inner().clone();
    let body = serde_json::json!({ "newPlanCode": new_plan_code });
    let env: ApiEnvelope<RawOrderResult> = rest_json(
        &app,
        &ol,
        reqwest::Method::POST,
        "/api/payment/upgrade",
        Some(&body),
    )
    .await?;
    Ok(env.data.into())
}

#[tauri::command]
pub async fn openloaf_payment_order_status(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
    order_id: String,
) -> Result<PaymentOrderStatus, String> {
    let ol = state.inner().clone();
    let path = format!("/api/payment/order/{order_id}");
    // GET，无 body；Req 类型给个 unit 占位。
    let env: ApiEnvelope<PaymentOrderStatus> = rest_json::<(), _>(
        &app,
        &ol,
        reqwest::Method::GET,
        &path,
        None,
    )
    .await?;
    Ok(env.data)
}

// ─── 本地回调 handler（callback.rs 调入） ─────────────────────────

/// 收到 /auth/callback 后：exchange token → apply session → emit 事件。
pub async fn handle_login_callback(app: &AppHandle, state_str: String, login_code: String) {
    let ol: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();

    // 校验 state：不存在 / 已取消 → 静默丢弃。
    let Some(flow) = ol.take_pending(&state_str) else {
        log::warn!("openloaf: callback with unknown state={state_str}, ignoring");
        return;
    };
    // 5 分钟超时：SaaS 通常 state 签名有更短的 TTL，这层做兜底。
    if flow.started_at.elapsed().as_secs() > 5 * 60 {
        emit_login(app, &state_str, Err("登录超时，请重试".into()));
        return;
    }

    let client = ol.client.clone();
    let exchange = tokio::task::spawn_blocking(move || {
        client.auth().exchange(&login_code, Some(&client_info()))
    })
    .await;

    match exchange {
        Ok(Ok(session)) => {
            let user = apply_session(&ol, session);
            emit_login(app, &state_str, Ok(user));
        }
        Ok(Err(err)) => {
            log::warn!("openloaf: exchange failed: {err}");
            emit_login(app, &state_str, Err(saas_err_to_string(err)));
        }
        Err(join_err) => {
            log::warn!("openloaf: exchange join error: {join_err}");
            emit_login(app, &state_str, Err("内部错误".into()));
        }
    }
}

fn emit_login(app: &AppHandle, state: &str, result: Result<PublicUser, String>) {
    let payload = match result {
        Ok(user) => LoginEvent::Success {
            state: state.to_string(),
            user,
        },
        Err(message) => LoginEvent::Error {
            state: state.to_string(),
            message,
        },
    };
    if let Err(e) = app.emit(LOGIN_EVENT, payload) {
        log::warn!("openloaf: emit login event failed: {e}");
    }
}

// ─── 启动时自动恢复 + 启动回调 server ─────────────────────────────

/// 在 setup 中调用。
pub async fn bootstrap(app: &AppHandle) {
    // 启动本地回调 server。
    let shared: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();
    match callback::start(app.clone()) {
        Ok(port) => {
            let _ = shared.callback_port.set(port);
            log::info!("openloaf: callback server at http://127.0.0.1:{port}/auth/callback");
        }
        Err(e) => {
            log::error!("openloaf: failed to start callback server: {e}");
            // 不 return：即使回调服务起不来，Keychain 里已有的 refresh token
            // 仍可用于恢复会话。
        }
    }

    // Keychain 恢复：
    let Some(refresh_token) = load_refresh_token() else {
        return;
    };

    let client = shared.client.clone();
    let result = tokio::task::spawn_blocking(move || {
        client.auth().refresh(&refresh_token, Some(&client_info()))
    })
    .await;

    match result {
        Ok(Ok(session)) => {
            apply_session(&shared, session);
            log::info!("openloaf: session restored from Keychain");
        }
        Ok(Err(err)) => {
            log::warn!("openloaf: refresh failed, clearing stored token: {err}");
            clear_refresh_token();
        }
        Err(join_err) => {
            log::warn!("openloaf: bootstrap join error: {join_err}");
        }
    }
}
