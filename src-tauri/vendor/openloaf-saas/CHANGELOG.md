# openloaf-saas (Rust SDK) Changelog

Rust SDK 的版本独立于 Node 包 `@openloaf-saas/sdk`。下表维护 Rust 版本 ↔ 对标 Node 版本的覆盖对照：

| Rust | 发布日期 | 对齐 Node | 覆盖接口 |
|------|---------|-----------|---------|
| 0.3.0 | 2026-04-24 | @openloaf-saas/sdk@0.2.5 | 0.2.0 全量 + `user.self` + Google / WeChat / dev OAuth start URL 构造器 |
| 0.2.0 | 2026-04-24 | @openloaf-saas/sdk@0.2.5 | 0.1.0 全量 + realtime 工具 WebSocket（`/api/ai/v3/tools/stream`） |
| 0.1.0 | 2026-04-24 | @openloaf-saas/sdk@0.2.5 | `auth.exchange` / `auth.refresh` / `auth.logout` / `ai.toolsCapabilities` / `ai.v3ToolExecute` |

---

## 0.3.0 — 2026-04-24

补齐用户资料接口，并新增 OAuth start URL 构造能力（面向 desktop / CLI 场景）。

### 新增

- `client.user().current()` → `UserSelfResponse` —— 拉取当前登录用户完整档案（`GET /api/user/self`）
- `client.auth().google_start_url(&opts)` —— 纯字符串构造，返回 Google OAuth 起点 URL
- `client.auth().wechat_start_url(&opts)` —— 微信 OAuth 起点 URL
- `client.auth().dev_start_url(&opts)` —— 开发环境免登 URL
- 新类型：`UserClient` / `UserSelf` / `UserSelfResponse` / `UserMembershipLevel`（`Free` / `Lite` / `Pro` / `Premium`）
- 新类型：`OAuthStartOptions`（含 `from` / `port` / `return_to` 的 builder）

### 实现要点

- `user.self` 走 FFI（GET，需 access token），和其他 REST 接口一致
- OAuth start URL **不发起任何网络请求** —— 纯字符串拼接，直接供调用方丢给浏览器。服务端在收到请求后会做 302 到真正的 Google/微信授权页。
- 一个典型 desktop 登录流程：
  1. `let url = client.auth().google_start_url(&OAuthStartOptions::new().from("electron").port(P))?;`
  2. 本地起一个 HTTP server 监听 `P`，在浏览器中打开 `url`
  3. Google 授权完成后服务端 302 到 `http://localhost:P/callback?loginCode=...`
  4. desktop 侧从 query 取 `loginCode` → `client.auth().exchange(&login_code, ...)` 换取 token

### ABI

- wrapper `SDK_VERSION` = `"0.3.0"`
- core `Cargo.toml` version = `"0.3.0"`
- bundle `VERSION` = `0.3.0`
- FFI 新增 method：`"user.self"`（GET /api/user/self，无 payload）。FFI 函数签名未变，**ABI 仍稳定**。

### 预编译

- [x] aarch64-apple-darwin
- [ ] x86_64-apple-darwin（需跑 `scripts/build-sdk-rust-bundle.sh --target x86_64-apple-darwin`）
- [ ] aarch64-unknown-linux-gnu
- [ ] x86_64-unknown-linux-gnu
- [ ] x86_64-pc-windows-msvc

---

## 0.2.0 — 2026-04-24

realtime 工具 WebSocket 支持。

### 新增

- `client.realtime().connect(feature)` → `RealtimeSession` —— 打开一条 WebSocket 会话
- `RealtimeSession::send_start(params, inputs)` —— 发送 `start` 控制帧
- `RealtimeSession::send_audio(bytes)` —— 发送 PCM16 二进制音频帧
- `RealtimeSession::send_finish()` —— 通知服务端 drain upstream
- `RealtimeSession::recv_event()` / `recv_event_timeout(Duration)` / `try_recv_event()`
- `RealtimeSession::close()` —— 主动关闭，等待 worker 退出
- 强类型事件 `RealtimeEvent::{Ready, Partial, Final, Credits, Error, Closed}`

### 实现要点

- WebSocket 逻辑完全在开源 wrapper（tungstenite 0.24 + rustls-tls-webpki-roots），不走 FFI
- worker 线程在后台轮询底层 TcpStream（nonblocking）；用户通过 mpsc channel 发送/接收，send 与 recv 可跨线程并发调用
- `RealtimeSession` 实现 `Drop`，丢失时自动给 worker 发 Close 帧

### 依赖

新增 `tungstenite 0.24`（handshake + rustls-tls-webpki-roots）、`url 2`。
链接后的 release 二进制从约 2.5MB 增加到约 4MB。

### 分发

- 预编译静态库版本随 wrapper 一起 bump 到 0.2.0（`check_abi()` 要求两端一致）
- 已刷新：
  - [x] aarch64-apple-darwin
  - [ ] x86_64-apple-darwin（需跑 `scripts/build-sdk-rust-bundle.sh --target x86_64-apple-darwin`）
  - [ ] aarch64-unknown-linux-gnu
  - [ ] x86_64-unknown-linux-gnu
  - [ ] x86_64-pc-windows-msvc

---

## 0.1.0 — 2026-04-24

首个版本。

### 新增

- `SaaSClient::new(SaaSClientConfig { base_url, access_token?, locale? })` — 创建同步客户端
- `client.auth().exchange(login_code, client_info?)` — 登录码换 token
- `client.auth().refresh(refresh_token, client_info?)` — 刷新 token
- `client.auth().logout(refresh_token)` — 撤销刷新令牌
- `client.ai().tools_capabilities()` — 拉取 v3 工具能力列表（sync / realtime discriminated union）
- `client.ai().v3_tool_execute(&V3ToolExecuteRequest)` — 同步执行 v3 工具（如 webSearch）
- `check_abi()` / `core_version()` — wrapper 和静态库版本一致性校验
- 错误类型 `SaaSError::{Network, Http, Decode, Input, AbiMismatch}`

### 分发

- 核心 crate 产物为 `libopenloaf_saas_core.a` / `.lib`，放在 `libs/{target}/` 目录下
- wrapper crate 通过 C ABI 单函数 `openloaf_saas_call(json) → json` 调度，ABI 为"永久稳定"设计（新增接口不会改 FFI 签名）
- 首发预编译支持 target：
  - [x] aarch64-apple-darwin
  - [ ] x86_64-apple-darwin（待在 CI 矩阵补齐）
  - [ ] aarch64-unknown-linux-gnu
  - [ ] x86_64-unknown-linux-gnu
  - [ ] x86_64-pc-windows-msvc

### 对齐 Node 0.2.5 的点

- `auth.exchange / auth.refresh` 支持可选 `AuthClientInfo`（appId / appVersion / platform / osVersion / extra）
- `ai.v3ToolExecute` 的 `variant` 字段为 `Option<String>`，服务端按 feature 自动解析
- 字段命名全量 `rename_all = "camelCase"`，和服务端 JSON 契约对齐
