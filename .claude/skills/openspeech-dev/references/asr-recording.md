# 录音 / realtime ASR 协作约定

> 何时读：改录音、改 STT、调 SaaS realtime ASR 集成、改触发录音的 gate 逻辑、加新 provider、**新增任何直连 SaaS（realtime / file 转写 / chat completions / V4 tools）的链路**。
> 真相来源：`src-tauri/src/stt/mod.rs` + `src-tauri/src/audio/` + `src-tauri/src/transcribe/mod.rs` + `src-tauri/src/ai_refine/mod.rs` + `src-tauri/src/openloaf/mod.rs` + `src/lib/stt.ts` + `src/stores/recording.ts`。事件名 / 命令名 / payload 直接读源码。
> 用法权威 = 同目录软链 `openloaf-saas-sdk-rust` skill。

---

## SaaS access_token 续期协作（栽过坑，2026-05-06）

**任何"直连 SaaS"的链路（realtime ASR、saas-file 转写、ai_refine chat、未来新增的 V4 tool）都必须满足两条契约**，否则会把用户从登录态踢出：

1. **B / 请求前预检**：进入 SDK / reqwest 之前 `await OpenLoafState::ensure_access_token_fresh()`。返回 false 才走 `handle_session_expired`。
2. **C / 401 → refresh & retry**：第一次 401 不要立刻清场；先 `await OpenLoafState::ensure_fresh_token()` 续期，用新 token 重发一次；重发还 401 / refresh 本身失败才 `handle_session_expired`。

**为什么不能省**：access_token TTL 1 小时，正常期间 SDK 后台定时器自动 `/auth/family/exchange` 续期。**电脑睡眠时定时器不跑** —— 唤醒后第一次请求带的 JWT 必然过期，服务端返 401，如果直接 `handle_session_expired` 用户就被踢登录了。日志中表现是：`session applied exp=…` 之后接近 1 小时没有 `access token refreshed via Family`，唤醒后第一次 `transcribe dispatch` 后没有对应 `ai_refine done`，且 UI 弹回未登录态。

**走 `call_authed` 的 SDK 调用已自带 C** —— 包到 `op` 闭包里直接用。`reqwest` 直连（如 ai_refine 的 SSE 流）、裸 SDK 调用（如 `tools_v4().asr_short_ol_tl_003`）需要自己实现 B+C。

**长 polling 路径（asr_long）**：polling 循环时间 ≤ 24 min < TTL，polling 期间过期概率极小；只在入口做 B 即可，循环内单次 401 仍允许走原清场路径。

**调试关键日志**（在 `src-tauri/src/openloaf/mod.rs`、`transcribe/mod.rs`、`ai_refine/mod.rs` 内）：
- `access token near/past exp, kicking off pre-flight refresh` — B 触发
- `call_authed got 401, attempting refresh + retry` / `retry after refresh succeeded` — C 走通
- `retry still 401 after refresh; clearing session` — 真正的会话失效

排查"用户莫名被登出"：先看日志窗口内有没有 `access token refreshed via Family`，再看最后一次请求是不是接到了 B/C 链路。

---

## realtime ASR 协作约定（OpenLoaf SaaS）

### 线程模型
- `RealtimeSession` 内含 `std::sync::mpsc::Receiver`（!Sync），**不能 Arc 跨线程**。
- 必须"session 单所有者 + worker 线程独占 + `mpsc::Sender<Control>` 进 worker"模式。

### close 不显式调
- `close(mut self)` 吃所有权 —— **不要显式调**。
- 让 Drop 自动发 Close 帧。

### 类型标注
- `send_start` 第二参数 `None` 时显式标类型：`None::<serde_json::Value>`。

### PCM 格式（栽过坑，2026-04-25）
- PCM 帧 = **PCM16 LE bytes**，channels = **1**。
- cpal 默认 f32 多 ch，必须在 audio callback 里就地下混 mono + 量化。
- `stt_start` 的 `send_start` 也必须报 `channels:1`，否则服务端按 2ch 解析全错位。

### 采样率
- 不重采样，跟随设备原生 sr 透传给服务端。

### feature ID 大小写（栽过坑，2026-04-25）
- **是 `realtimeAsr`（小写 sr），不是 `realtimeASR`** —— 错了 WS 握手直接 500。

### 未登录路径
- `stt_start` 返 `"not authenticated"`。
- 前端只 `warn`，**录音继续**，history 落占位文字。
- 不要因 SaaS 未登录禁录音。

### 离线快速测试
- debug build 在 `apply_session` 时 dump session 到 `~/.openspeech/dev_session.json`（chmod 600，release 编译掉）。
- 配套 `cargo run --example test_realtime_asr` 绕开 audio/hotkey 直测 SDK ↔ SaaS。

---

## 触发录音 Gate（`recording.ts::start`）

按顺序拦截，任一命中即放弃本次录音：

1. **未登录且未配 BYO endpoint** → `useUIStore.openLogin()`。
2. **SAAS 路径 + `navigator.onLine === false`** → 同步拦截 + `openNoInternet()`。
3. **SAAS 路径乐观启动后异步 `invoke("openloaf_health_check")`**，false 且仍在 preparing/recording → 回滚 + 弹无网络。

---

## 隐私边界（呼应 `docs/privacy.md`）

- 录音仅落盘本机：`app_data_dir/recordings/<id>.wav`。
- 除登录态下的 SaaS realtime ASR 外不发任何服务器。
