// OpenLoaf SaaS 登录集成。
//
// 流程（参考 OpenLoaf/apps/web/src/components/auth/SaasLoginDialog.tsx）：
//   1. 前端 invoke openloaf_start_login({ provider })
//   2. Rust：生成 state UUID，登记到 pending 表，构造 SaaS 登录 URL 返回
//      `https://<BASE>/api/auth/<provider>/start?returnTo=openloaf-login:<state>&from=electron&port=<port>`
//   3. 前端 openUrl(loginUrl) 打开系统浏览器
//   4. 用户完成 OAuth → SaaS 302 到 http://127.0.0.1:<port>/auth/callback?code=...&returnTo=openloaf-login:<state>
//   5. callback.rs 拿到 code + state → 调用本模块的 handle_login_callback
//   6. handle_login_callback：exchange token（SDK 自动 persist 到注入的 KeyringAuthStorage）→ emit 事件
//   7. 前端通过 listen(event) 得到最终结果
//
// 持久化全部走 SDK 0.3.2 的 `AuthStorage` 抽象（见 `storage.rs`）：
//   - release：keychain，service `"ai.openloaf.saas"` / account `"default"` —— 跟 OpenLoaf
//     自家其他桌面 App 共享同一空间，启动时若已有 family_token 直接 SSO。
//   - debug：普通文件 `$HOME/.openspeech/dev-auth.json`，避开 macOS Keychain 在 dev
//     binary cdhash 频繁变化下反复弹密码框的问题。

use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use openloaf_saas::{
    AuthClientInfo, AuthStorage, AuthUser, OAuthStartOptions, SaaSClient, SaaSClientConfig,
    SaaSError, SaaSResult, UserMembershipLevel, UserSelf, V3ToolFeature,
};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Runtime, State};

mod callback;
mod dev_session;
pub mod feedback;
mod storage;
use dev_session::{clear_dev_session, dump_dev_session};
use storage::{cleanup_legacy_keychain, new_storage, AuthStorageImpl};

// OpenLoaf SaaS REST 基址。构建期常量，按 build profile 分岔：
//   - debug（`cargo run` / `cargo build`）  → localhost:5180 本地开发服务
//   - release（`cargo build --release`）    → 线上生产服务
// 两者都可用环境变量 OPENLOAF_BASE_URL 覆盖，例：
//   OPENLOAF_BASE_URL=https://staging.openloaf.hexems.com cargo build --release
// 不在这里放机密（只是 URL，安全）。
#[cfg(all(debug_assertions, not(feature = "staging")))]
const FALLBACK_BASE_URL: &str = "http://localhost:5180";
#[cfg(all(debug_assertions, feature = "staging"))]
const FALLBACK_BASE_URL: &str = "https://openloaf.hexems.com";
#[cfg(not(debug_assertions))]
const FALLBACK_BASE_URL: &str = "https://openloaf.hexems.com";

const DEFAULT_BASE_URL: &str = match option_env!("OPENLOAF_BASE_URL") {
    Some(v) => v,
    None => FALLBACK_BASE_URL,
};

// OpenLoaf Web 前端地址。订阅/充值走 Web 页面（App 内不内嵌支付流程），
// 前端通过 openloaf_web_url command 拿完整 URL 后 openUrl 到浏览器。
#[cfg(all(debug_assertions, not(feature = "staging")))]
const FALLBACK_WEB_URL: &str = "http://localhost:5180";
#[cfg(all(debug_assertions, feature = "staging"))]
const FALLBACK_WEB_URL: &str = "https://openloaf.hexems.com";
#[cfg(not(debug_assertions))]
const FALLBACK_WEB_URL: &str = "https://openloaf.hexems.com";

pub const DEFAULT_WEB_URL: &str = match option_env!("OPENLOAF_WEB_URL") {
    Some(v) => v,
    None => FALLBACK_WEB_URL,
};

const APP_ID: &str = "openspeech-desktop";
const LOGIN_EVENT: &str = "openspeech://openloaf-login";
/// 启动时（bootstrap）凭 keychain 里的 refresh_token 自动恢复成功后广播。
/// 前端在初始化时拿到的 `is_authenticated` 可能早于 bootstrap 网络往返完成，
/// 所以这里再补一次推送，让 UI 把恢复出来的用户写回 store。
const RESTORED_EVENT: &str = "openspeech://openloaf-restored";
/// 自动 refresh 彻底失败（refresh token 也无效）时广播给前端，让 UI 切回未登录态。
const AUTH_LOST_EVENT: &str = "openspeech://openloaf-auth-lost";

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
    /// SDK 内部对同一个 `Arc<dyn AuthStorage>` 也持有一份 —— 这里多保留一个 owned 句柄
    /// 是为了在不走 SDK auth 路径时（例如 401 主动清场 / 一次性诊断）也能直接 `clear()`。
    storage: Arc<AuthStorageImpl>,
    user: Mutex<Option<PublicUser>>,
    pending: Mutex<HashMap<String, PendingLogin>>,
    callback_port: OnceLock<u16>,
    /// 串行化 refresh：并发 401 只会触发一次 refresh，其它调用等它完成后复用新 token。
    refresh_lock: tokio::sync::Mutex<()>,
}

pub type SharedOpenLoaf = Arc<OpenLoafState>;

impl OpenLoafState {
    pub fn new() -> Self {
        let storage = new_storage();
        let client = SaaSClient::new(SaaSClientConfig {
            base_url: DEFAULT_BASE_URL.into(),
            locale: Some("zh-CN".into()),
            auth_storage: Some(storage.clone()),
            client_name: Some(APP_ID.into()),
            client_version: Some(env!("CARGO_PKG_VERSION").into()),
            ..Default::default()
        });
        Self {
            client,
            storage,
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

    /// 一次性独立 SaaSClient：每次调用都新建 ureq Agent → 新连接池。
    /// Why: 长录音（>60s）期间共享 client 的 idle keep-alive 连接会被对端 RST
    /// （localhost 本地代理 / 上游网关），下一次 OL-TL-005 复用旧连接就吃
    /// `Connection reset by peer (os error 54)`，回退原文，跳过 AI 优化。
    /// How to apply: 仅给 OL-TL-005 / refine stream 这种"长 STT 之后才发请求"
    /// 的链路使用；常规 call 继续用 `authenticated_client()` 复用连接池。
    /// token 是 snapshot，调用方应在拿之前先 `ensure_access_token_fresh()`。
    pub fn fresh_authenticated_client(&self) -> Option<SaaSClient> {
        let token = self.client.access_token()?;
        Some(SaaSClient::new(SaaSClientConfig {
            base_url: DEFAULT_BASE_URL.into(),
            access_token: Some(token),
            locale: Some("zh-CN".into()),
            auth_storage: Some(self.storage.clone()),
            client_name: Some(APP_ID.into()),
            client_version: Some(env!("CARGO_PKG_VERSION").into()),
        }))
    }

    /// 返回 SaaSClient 克隆（无论是否登录）。供"网络健康探针"等公开端点调用复用。
    /// 不强制登录态，因为 `system().health()` 等公开端点本身不需要 token。
    pub fn client_clone(&self) -> SaaSClient {
        self.client.clone()
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

    /// 给不走 `call_authed` 的链路（realtime WebSocket 等）连接前用：
    /// 解 access_token 的 JWT exp，已过期 / 距离过期 ≤ 30s 才走 ensure_fresh_token。
    /// 没 token 直接 false，调用方自己决定清场策略。
    pub async fn ensure_access_token_fresh(&self) -> bool {
        let Some(token) = self.client.access_token() else {
            return false;
        };
        if access_token_still_fresh(&token, 30) {
            return true;
        }
        self.ensure_fresh_token().await
    }

    /// 在 Mutex 内尝试刷新 access token。
    /// - 进入 Mutex 前先记下当前 token，入 Mutex 后再读一次：如果已变化，说明别的任务
    ///   刚刚已经 refresh 成功了，本次直接 true 返回，避免重复请求；
    /// - 否则调 SDK `auth.bootstrap` —— SDK 内部从注入的 storage 读 family/refresh
    ///   token，挑首选路径调 `/auth/family/exchange` 或 `/auth/refresh`，成功就自动
    ///   把新 access_token 写进 client + 把新 session persist 回 storage。
    /// - SDK 明确判失效（在 bootstrap 内部接住）→ storage 已被 SDK 清，返回 false
    ///   由调用方负责清场（emit auth-lost）。
    async fn ensure_fresh_token(&self) -> bool {
        let stale = self.client.access_token();
        let _guard = self.refresh_lock.lock().await;

        // Double-check：排队等 Mutex 时别人可能已经 refresh 过。
        let current = self.client.access_token();
        if current.is_some() && current != stale {
            return true;
        }

        let client = self.client.clone();
        let result =
            tokio::task::spawn_blocking(move || client.auth().bootstrap(Some(&client_info())))
                .await;

        match result {
            Ok(Ok(Some(restored))) => {
                // SDK 已写好 access_token + storage；这里只补 user 缓存 + dev_session dump。
                let user: PublicUser = restored.user.into();
                self.set_user(Some(user));
                dump_dev_session(&restored.access_token, &restored.refresh_token);
                log::info!(
                    "openloaf: access token refreshed via {:?}, jwt {}",
                    restored.via,
                    summarize_jwt_claims(&restored.access_token)
                );
                true
            }
            Ok(Ok(None)) => {
                log::warn!("openloaf: refresh aborted — storage empty or token rejected");
                false
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

/// 登录 / refresh 成功后的本地补偿：SDK 已经把 access_token 设进 client、把 StoredAuth 写进
/// keychain；这里只补 SDK 不管的两件事——前端用的 user 缓存 + debug 旁路 dump。
///
/// 入参用 `&AuthSession` / `&BootstrapResult` 都不方便（两者字段不一样），干脆解构成裸字段。
fn apply_session_local(
    state: &OpenLoafState,
    access_token: &str,
    refresh_token: &str,
    user: AuthUser,
) -> PublicUser {
    dump_dev_session(access_token, refresh_token);
    log::info!(
        "openloaf: session applied, base_url={DEFAULT_BASE_URL}, jwt {}",
        summarize_jwt_claims(access_token)
    );
    let public: PublicUser = user.into();
    state.set_user(Some(public.clone()));
    public
}

/// 把 access_token 的 JWT payload 解出来，挑 iss/aud/sub/exp/iat 5 个 claim 输出成单行
/// 字符串，**不**输出整个 payload（避免 PII / 角色 / scope 等敏感字段泄进日志）。
///
/// 用途：401 排错时跟服务端 `.env` 的 JWT_ISSUER / JWT_AUDIENCE 对照，5 秒就能定位
/// "签发 / 验签端配置不一致"。所有解析错误都不抛——只回退成 `<...>` 占位字符串，
/// 不影响登录主路径。
fn summarize_jwt_claims(token: &str) -> String {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return "<malformed jwt>".into();
    }
    use base64::Engine;
    let payload_bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(parts[1]));
    let payload_bytes = match payload_bytes {
        Ok(b) => b,
        Err(e) => return format!("<base64 decode failed: {e}>"),
    };
    let claims: serde_json::Value = match serde_json::from_slice(&payload_bytes) {
        Ok(v) => v,
        Err(e) => return format!("<json parse failed: {e}>"),
    };
    let pick = |k: &str| -> String {
        claims
            .get(k)
            .map(|v| v.to_string())
            .unwrap_or_else(|| "null".into())
    };
    format!(
        "iss={} aud={} sub={} exp={} iat={}",
        pick("iss"),
        pick("aud"),
        pick("sub"),
        pick("exp"),
        pick("iat"),
    )
}

/// 解 JWT 的 `exp` 判 access_token 是否还在有效期内。带 `skew_secs` 余量避免临界点
/// 起飞时正好踩 401。无法解析的 token（base64/json/exp 缺失）一律视作"不新鲜"，
/// 让调用方走 refresh 路径兜底。
fn access_token_still_fresh(token: &str, skew_secs: i64) -> bool {
    let parts: Vec<&str> = token.split('.').collect();
    if parts.len() != 3 {
        return false;
    }
    use base64::Engine;
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(parts[1])
        .or_else(|_| base64::engine::general_purpose::URL_SAFE.decode(parts[1]));
    let payload = match payload {
        Ok(b) => b,
        Err(_) => return false,
    };
    let claims: serde_json::Value = match serde_json::from_slice(&payload) {
        Ok(v) => v,
        Err(_) => return false,
    };
    let Some(exp) = claims.get("exp").and_then(|v| v.as_i64()) else {
        return false;
    };
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    exp > now + skew_secs
}

/// 把会话清干净。SDK 的 `auth.logout` / `auth.family_revoke` 已经会自动清 storage；
/// 这个函数是给"无服务端协作"的强清场用的（401 主动清 / 用户取消 / refresh 彻底失败）。
fn clear_session(state: &OpenLoafState) {
    state.client.set_access_token(None);
    state.set_user(None);
    if let Err(e) = state.storage.clear() {
        log::warn!("openloaf: storage.clear failed: {e}");
    }
    clear_dev_session();
}

/// 任何业务路径（实时 ASR / 文件转写 / 其他直接调 SaaS 的 command）拿到 401 后调一次。
/// 等价于 `call_authed` 路径里 refresh 失败后的清场动作：清本地 session + 广播
/// `AUTH_LOST_EVENT`，前端 auth store 监听到后切未登录态并由 UI 决定弹登录框。
pub fn handle_session_expired<R: Runtime>(app: &AppHandle<R>, state: &OpenLoafState) {
    clear_session(state);
    if let Err(e) = app.emit(AUTH_LOST_EVENT, ()) {
        log::warn!("openloaf: emit auth-lost failed: {e}");
    }
}

// ─── 登录事件 payload ────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
enum LoginEvent {
    Success { state: String, user: PublicUser },
    Error { state: String, message: String },
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

    // 0.3.2 引入 family token：优先 family_revoke（机器级登出，所有 OpenLoaf 桌面 App 一起踢），
    // 没有 family 就回退 logout(refresh_token)；都没有就只清本地。
    let stored = state.storage.load().ok().flatten();
    if let Some(stored) = stored {
        let client = state.client.clone();
        tokio::task::spawn_blocking(move || {
            if let Some(family_token) = stored.family_token.as_deref() {
                let _ = client.auth().family_revoke(family_token);
            } else if let Some(refresh_token) = stored.refresh_token.as_deref() {
                let _ = client.auth().logout(refresh_token);
            }
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    // SDK 的 logout / family_revoke 内部已经清 storage + access_token；这里 clear_session
    // 兜底确保 user 缓存 + dev_session 也跟上（即便服务端调用失败）。
    clear_session(&state);
    Ok(())
}

#[tauri::command]
pub fn openloaf_current_user(state: State<'_, SharedOpenLoaf>) -> Option<PublicUser> {
    state.current_user()
}

/// 网络健康探针：调用 SDK 的 `system().health()` —— 对应公开端点
/// `GET /api/public/health`，不需要 access token，返回轻量 `{status, sdkVersion}`。
/// 能拿到响应即视为"网络通且 SaaS 可达"。任何错误（DNS 失败 / connect refused /
/// 5xx / 解析失败）都返回 false，恰好覆盖"完全没网"以及"链路通但服务不可用"两类
/// 情况——比 `navigator.onLine` 更可靠（后者只检系统层链路）。
///
/// 该调用是 SDK 的同步阻塞调用，包在 `spawn_blocking` 里 + 5s tokio timeout
/// 兜底，避免 health 检测自己卡住影响快捷键响应。
#[tauri::command]
pub async fn openloaf_health_check(state: State<'_, SharedOpenLoaf>) -> Result<bool, String> {
    use std::time::Duration;
    let client = state.client_clone();
    let task = tokio::task::spawn_blocking(move || client.system().health());
    match tokio::time::timeout(Duration::from_secs(5), task).await {
        Ok(Ok(Ok(_resp))) => Ok(true),
        Ok(Ok(Err(e))) => {
            log::warn!("[health] health probe failed: {e:?}");
            Ok(false)
        }
        Ok(Err(join_err)) => {
            log::warn!("[health] spawn_blocking join error: {join_err}");
            Ok(false)
        }
        Err(_elapsed) => {
            log::warn!("[health] timeout after 5s");
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn openloaf_is_authenticated(state: State<'_, SharedOpenLoaf>) -> bool {
    state.client.access_token().is_some()
}

/// 主动调一次 SDK `auth.bootstrap` 静默恢复登录态。
///
/// 调用时机：
///   - 用户按下听写快捷键、recording gate 发现未登录 → await 这个命令再判 gate；
///   - 浏览器 `online` 事件触发（网络从断到通）；
///   - 任何"我现在想用 SaaS、但内存里 access_token 是空的"场景。
///
/// 行为：
///   - 已登录（内存有 access_token）→ 直接返回 true，不动网络；
///   - 否则调 SDK `bootstrap` —— 内部从 keychain 读 StoredAuth，命中 family_token 优先调
///     `/auth/family/exchange`，否则 fallback `/auth/refresh`。
///     成功 → SDK 自动 set_access_token + 写 storage；这里再 emit `RESTORED_EVENT`，返回 true；
///     storage 为空 / token 已被服务端 reject → 返回 false；
///     网络瞬时错误 → SDK 保留 storage 不清，下次再调时还能试，返回 false。
#[tauri::command]
pub async fn openloaf_try_recover(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
) -> Result<bool, String> {
    let ol = state.inner().clone();

    if ol.client.access_token().is_some() {
        return Ok(true);
    }

    let client = ol.client.clone();
    let result = tokio::task::spawn_blocking(move || client.auth().bootstrap(Some(&client_info())))
        .await
        .map_err(|e| format!("join error: {e}"))?;

    match result {
        Ok(Some(restored)) => {
            let user = apply_session_local(
                &ol,
                &restored.access_token,
                &restored.refresh_token,
                restored.user,
            );
            log::info!(
                "openloaf: session recovered on demand via {:?}",
                restored.via
            );
            if let Err(e) = app.emit(RESTORED_EVENT, user) {
                log::warn!("openloaf: emit restored event failed: {e}");
            }
            Ok(true)
        }
        Ok(None) => Ok(false),
        Err(err) => {
            log::warn!("openloaf: on-demand bootstrap failed: {err}");
            Ok(false)
        }
    }
}

/// 拼出 OpenLoaf Web 的页面 URL（订阅 / 充值等）。前端拿到后用 openUrl 打开。
///
/// 例：`path = "/pricing"` → `https://openloaf.hexems.com/pricing`
#[tauri::command]
pub fn openloaf_web_url(path: String) -> String {
    // 兼容前端不小心传了完整 URL 的情况：以 http 开头就原样返回。
    if path.starts_with("http://") || path.starts_with("https://") {
        return path;
    }
    let sep = if path.starts_with('/') { "" } else { "/" };
    format!("{DEFAULT_WEB_URL}{sep}{path}")
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

// ⚠️ 计费换算的隐性耦合：
// 客户端 sidebar 拿这里返回的 `credits_per_minute` 把"剩余积分"折算成"剩余分钟"。
// 我们调的是 V3 capabilities 端点的 `realtimeAsrLlm`，但 OpenSpeech 实际跑的是
// V4 通道 `OL-TL-RT-002`（Qwen3-ASR-Flash-Realtime, 见 src/stt/mod.rs）。
// 假设服务端 V3 realtimeAsrLlm 与 V4 OL-TL-RT-002 走相同 credits/min 单价。
//
// **若 V4 OL-TL-RT-002 改了计费规则（换模型 / 换通道 / 改单价 / 改成按字符 /
// 按秒分档），必须立刻把这里换成正确的来源**：
//   - 优先方案：SDK 暴露 V4 capabilities 接口直接拉真单价；
//   - 兜底方案：在客户端从 `credits` 事件里 `consumed_credits / consumed_seconds`
//     反推出实际单价并缓存。
// 否则 sidebar 的"剩余分钟"会与真实扣费偏离，误导用户。
#[tauri::command]
pub async fn openloaf_fetch_realtime_asr_pricing(
    app: AppHandle,
    state: State<'_, SharedOpenLoaf>,
) -> Result<f64, String> {
    let ol = state.inner().clone();
    let resp = call_authed(&app, &ol, |client| {
        client.ai().tools_capabilities(Some("realtimeAsrLlm"))
    })
    .await
    .map_err(saas_err_to_string)?;

    log::info!(
        "openloaf: V3 capabilities response (realtimeAsrLlm): category={}, features={}",
        resp.data.category,
        serde_json::to_string(&resp.data.features).unwrap_or_else(|_| "<unserializable>".into())
    );

    let credits_per_minute = resp.data.features.iter().find_map(|f| match f {
        V3ToolFeature::Realtime(rt) => Some(rt.credits_per_minute),
        V3ToolFeature::Sync(_) => None,
    });

    match credits_per_minute {
        Some(cpm) => {
            log::info!(
                "openloaf: V3 realtimeAsrLlm.credits_per_minute = {cpm} (used as proxy for V4 OL-TL-RT-002)"
            );
            Ok(cpm)
        }
        None => {
            log::warn!(
                "openloaf: V3 realtimeAsrLlm capability has no Realtime feature with credits_per_minute; sidebar will fall back to raw credits"
            );
            Err(
                "realtimeAsrLlm capability missing realtime feature with credits_per_minute"
                    .to_string(),
            )
        }
    }
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

async fn call_authed<T, F>(app: &AppHandle, ol: &SharedOpenLoaf, op: F) -> SaaSResult<T>
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
        emit_login(app, &state_str, Err("AUTH_LOGIN_TIMEOUT".into()));
        return;
    }

    let client = ol.client.clone();
    let exchange = tokio::task::spawn_blocking(move || {
        client.auth().exchange(&login_code, Some(&client_info()))
    })
    .await;

    match exchange {
        Ok(Ok(session)) => {
            // SDK 内部已经 set_access_token + 写 storage（含 family_token / refresh_token）；
            // 这里只补 SDK 不管的 user 缓存 + dev_session dump。
            let user = apply_session_local(
                &ol,
                &session.access_token,
                &session.refresh_token,
                session.user,
            );
            emit_login(app, &state_str, Ok(user));
        }
        Ok(Err(err)) => {
            log::warn!("openloaf: exchange failed: {err}");
            emit_login(app, &state_str, Err(saas_err_to_string(err)));
        }
        Err(join_err) => {
            log::warn!("openloaf: exchange join error: {join_err}");
            emit_login(app, &state_str, Err("AUTH_INTERNAL".into()));
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
    let shared: SharedOpenLoaf = app.state::<SharedOpenLoaf>().inner().clone();

    // 启动本地回调 server。
    match callback::start(app.clone()) {
        Ok(port) => {
            let _ = shared.callback_port.set(port);
            log::info!("openloaf: callback server at http://127.0.0.1:{port}/auth/callback");
        }
        Err(e) => {
            log::error!("openloaf: failed to start callback server: {e}");
            // 不 return：即使回调服务起不来，keychain 里已有的凭据仍可用于恢复会话。
        }
    }

    // 一次性清理老命名空间的 keychain 条目（v0.2.6 之前用的 `com.openspeech.app /
    // openloaf_refresh_token`）。0.3.2 起改用 SDK 推荐的 `ai.openloaf.saas / default`，
    // 老条目对新版本无意义，留着只是噪音。`NoEntry` 静默忽略。
    cleanup_legacy_keychain();

    // SDK 自身的 bootstrap：从注入的 storage 读 family/refresh token，
    // 命中 family → `/auth/family/exchange`（首选，跨 App SSO），
    // 否则 fallback `/auth/refresh`，都失败 → SDK 自动清 storage。
    //
    // 30s 硬超时：bootstrap 内部走 ureq 同步 HTTP，base_url 不可达时（典型场景：
    // dev keychain 污染导致 base_url=localhost:5180 但 dev server 已关，或网络
    // 大面积故障）默认超时叠加重试可能堆到几分钟，前端启动直接挂死在 Loading。
    // 这里超时只 warn，不清 storage——下一次启动还能再试。
    let client = shared.client.clone();
    let bootstrap_fut =
        tokio::task::spawn_blocking(move || client.auth().bootstrap(Some(&client_info())));
    let result = match tokio::time::timeout(std::time::Duration::from_secs(30), bootstrap_fut).await
    {
        Ok(joined) => joined,
        Err(_) => {
            log::warn!(
                "openloaf: bootstrap timeout (>30s); base_url unreachable? skipping restore, UI will require manual login"
            );
            return;
        }
    };

    match result {
        Ok(Ok(Some(restored))) => {
            let user = apply_session_local(
                &shared,
                &restored.access_token,
                &restored.refresh_token,
                restored.user,
            );
            log::info!(
                "openloaf: session restored from keychain via {:?}",
                restored.via
            );
            if let Err(e) = app.emit(RESTORED_EVENT, user) {
                log::warn!("openloaf: emit restored event failed: {e}");
            }
        }
        Ok(Ok(None)) => {
            // 无凭据或凭据被服务端 reject：SDK 已自动 clear storage。无需任何动作，UI 走 OAuth。
        }
        Ok(Err(err)) => {
            log::warn!("openloaf: bootstrap failed transiently: {err}");
        }
        Err(join_err) => {
            log::warn!("openloaf: bootstrap join error: {join_err}");
        }
    }
}
