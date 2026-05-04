# 云接口接入点 × 供应商能力矩阵

> 状态：实现层快照（实时维护）。每次新增 / 移除 / 改写云接口调用，**必须**同步更新本表。
> 配套规划文档：[speech-providers.md](./speech-providers.md)（业务规则 / Capability 抽象）。
>
> 本文档解决两个问题：
> 1. 项目里**哪些位置在调云接口**——快速定位接入点。
> 2. **每个供应商能提供哪些接口**——新增 vendor 时按表对应。

---

## 1. 项目内云接口接入点（按业务能力）

每行 = 一个独立的"对外发请求"位置。`Tauri Command` 列方便从前端反查。

| # | 业务能力 | Tauri Command / 触发路径 | 文件 : 行 | 当前实现（默认 SaaS） | 协议 |
|---|---|---|---|---|---|
| C1 | 实时听写（边录边出字） | `stt_start` / `stt_finalize` / `stt_cancel` | `src-tauri/src/stt/mod.rs:263` | OpenLoaf SDK `tools_v4().realtime_asr_llm_ol_tl_rt_002` (`OL-TL-RT-002` / Qwen3-ASR-Flash-Realtime) | WebSocket |
| C2 | 短录音文件转写 (≤5min) | `transcribe_recording_file`（duration ≤5min 分支） | `src-tauri/src/transcribe/mod.rs:135` | OpenLoaf SDK `tools_v4().asr_short_ol_tl_003` (`OL-TL-003`) | HTTP / base64 直传 |
| C3 | 长录音 URL 转写 (>5min, 公网 URL) | `transcribe_long_audio_url` + `transcribe_recording_file`（>5min 分支当前未支持本地） | `src-tauri/src/transcribe/mod.rs:190 / :205` | OpenLoaf SDK `tools_v4().asr_long_ol_tl_004*` (`OL-TL-004`) | HTTP submit + 轮询 |
| C4 | AI 文本改写 / 翻译 / 问 AI（流式） | `refine_text_via_chat_stream` | `src-tauri/src/ai_refine/mod.rs:299`（reqwest 直发） | mode=`saas`：SDK `ai().fast_chat_variant()` 选模型 + 直发 `/api/v1/chat/completions`<br>mode=`custom`：用户填的 baseUrl + keyring 中 ApiKey | HTTP SSE |
| C5 | 用户身份 / 余额 / 订阅 | `openloaf_fetch_profile` / `openloaf_fetch_realtime_asr_pricing` | `src-tauri/src/openloaf/mod.rs:648 / :673` | SDK `user().current()` / `ai().tools_capabilities("realtimeAsrLlm")` | HTTP |
| C6 | 登录 / 登出 / token 刷新 | `openloaf_*_login` / `openloaf_logout` / `openloaf_try_recover` | `src-tauri/src/openloaf/mod.rs:226 / :429–456 / :778` | SDK `auth().{google_start_url, wechat_start_url, exchange, bootstrap, family_revoke, logout}` | HTTP |
| C7 | SaaS 健康探针 | `openloaf_health_check` | `src-tauri/src/openloaf/mod.rs:490` | SDK `system().health()` | HTTP |
| C8 | 反馈上报 | `openloaf_send_feedback` | `src-tauri/src/openloaf/feedback.rs:92` | reqwest 直发 SaaS feedback 端点 | HTTP |

**说明**

- C1–C3 是 ASR 类，是本文档主要关注的"可被 vendor 直连替换"的接入点。
- C4 已经有 `saas` / `custom` 双模式，`custom` 路径就是 BYOK 的母版（凭证走 keyring，baseUrl + model 走 settings）。
- C5–C8 是 SaaS 平台自身能力（账户 / 订阅 / 反馈），无 vendor 直连概念，永远走 SaaS。

---

## 2. 供应商能力 × 项目接入点矩阵

> 列：项目接入点 C1–C4。行：供应商。
> 单元格内：该供应商提供的对应原生 API 名称（点击文档链接见后）。`—` 表示该 vendor 不提供 / 项目当前不打算接。

### 2.1 ASR（C1 实时 / C2 短文件 / C3 长文件）

| 供应商 | C1 实时听写 | C2 短文件 (≤5MB / ≤60s) | C3 长文件 (URL 或 ≤1GB) | 凭证 |
|---|---|---|---|---|
| **OpenLoaf SaaS**（默认）| `OL-TL-RT-002` (Qwen3-ASR realtime) | `OL-TL-003` (DashScope multimodal) | `OL-TL-004` (Qwen3 filetrans) | SaaS access_token（OAuth 登录后由 SDK 持有）|
| **腾讯云 ASR** | [实时语音识别 WebSocket](../../Tenas-All/OpenLoaf-saas/docs/tencent-asr/websocket-realtime-asr.md)（`wss://asr.cloud.tencent.com/asr/v2/<appid>`，HMAC-SHA1 签名） | [录音文件识别（一句话）](../../Tenas-All/OpenLoaf-saas/docs/tencent-asr/file-recognition-request.md)（`SourceType=1` 本地 base64，**≤5MB**，注意：腾讯无独立"短"接口，统一是 `CreateRecTask` 异步） | 同左：[`CreateRecTask`](../../Tenas-All/OpenLoaf-saas/docs/tencent-asr/file-recognition-request.md) + [`DescribeTaskStatus`](../../Tenas-All/OpenLoaf-saas/docs/tencent-asr/file-recognition-query.md)（URL 或本地，URL ≤5h、≤1GB；签名 [TC3-HMAC-SHA256](../../Tenas-All/OpenLoaf-saas/docs/tencent-asr/common-signature-v3.md)）| `AppID + SecretId + SecretKey` |
| **阿里云 ASR (DashScope)** | Qwen3-ASR-Flash-Realtime（同 OL-TL-RT-002 上游）/ Paraformer Realtime | DashScope `multimodal-generation`（同 OL-TL-003 上游）| Qwen3-ASR-Flash-Filetrans（同 OL-TL-004 上游；本地音频走 OSS 上传，详见 §4.3）| `DashScope ApiKey`（Bearer）|
| Azure / Google / OpenAI Whisper / byo-rest | 见 [speech-providers.md §6.5](./speech-providers.md) | 同左 | 同左 | 见各 vendor 文档 |

### 2.2 LLM（C4 文本改写 / 翻译 / 问 AI）

| 供应商 | C4 OpenAI 兼容 chat/completions | 凭证 |
|---|---|---|
| **OpenLoaf SaaS**（默认）| `<saas_base>/api/v1/chat/completions` + 必带 `variant: <variantId>`，model 由 SDK `fast_chat_variant()` 选 | SaaS access_token |
| **OpenAI / 阿里云 DashScope / 自部署 vLLM / etc.** | 用户在 settings 配 `baseUrl` + `model` + `apiKey`，统一拼 `<baseUrl>/chat/completions` | 用户填 ApiKey（keyring）|
| **腾讯云**（机器翻译 TMT）| 不是 OpenAI 兼容；走 [TMT API](https://cloud.tencent.com/document/product/551/15619) 独立端点 | `SecretId + SecretKey` |

> C4 的 `custom` 路径（`ai_refine/mod.rs:122 resolve_custom`）已经实现了"任意 OpenAI 兼容 endpoint"的接入。腾讯 TMT 因为非 OpenAI 协议，要接的话需要新加一类 `mode`，**当前不计划做**。

---

## 3. 凭证管理表（keyring service / account 命名约定）

| 凭证 | 用途 | 存储位置 | 命名约定 |
|---|---|---|---|
| OpenLoaf access_token / refresh_token / family_token | C5–C8 / C1–C4 SaaS 模式 | macOS Keychain（release）/ `$HOME/.openspeech/dev-auth.json`（debug）| service=`ai.openloaf.saas` / account=`default` |
| AI Refine 自定义 provider apiKey | C4 custom 模式 | macOS Keychain | service=`ai_provider_<provider.id>` |
| **腾讯云 SecretId** | C1–C3 BYOK 腾讯（**未实现**） | 待定（建议同 keyring 复用 secrets/ 模块）| 提议：service=`asr_provider_<id>` / account=`tencent_secret_id` |
| **腾讯云 SecretKey** | 同上 | 同上 | 提议：service=`asr_provider_<id>` / account=`tencent_secret_key` |
| **腾讯云 AppID** | 同上（实时 WS URL `wss://...asr/v2/<appid>` 必填）| 非 secret，可放 `tauri-plugin-store` | settings.providers.asr.config.tencent.appId |
| **阿里 DashScope ApiKey** | C1–C3 BYOK 阿里 | macOS Keychain | service=`asr_provider_<id>` / account=`dashscope_api_key` |

---

## 4. 接入点 × 替换映射（"临时全替换为腾讯"实施切片）

> 这是用户当前要求的过渡方案：**先把所有 ASR 接入点硬切到腾讯**，跑通后再做 settings 切换 UI。
> 切换粒度：每个接入点一个独立 PR / 独立 commit，便于回滚。

### 4.1 实施前提（必须先决策）

凭证从哪儿来？三选一：

| 选项 | 凭证来源 | 适合场景 | 改动量 |
|---|---|---|---|
| **A. 环境变量** | 启动时读 `TENCENT_APPID` / `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY` | 仅本机开发 / 短期验证 | 最小，不动 UI |
| **B. dev-only settings 入口** | 复用 `secrets/` keyring；隐藏在 `#[cfg(debug_assertions)]` 设置面板里 | 团队内灰度 | 中（加表单 + invoke）|
| **C. 正式 settings UI** | 完整的 ASR provider 切换器 + 测试连接 | 公开发版前提 | 大（含 i18n / 三态预览，见 speech-providers.md §9）|

**推荐**：先 A 跑通技术细节（实时 WS 鉴权、文件签名），再升 B/C。

### 4.2 各接入点替换契约

#### C1 实时听写 → 腾讯实时 WebSocket

| 项 | 当前（SaaS） | 替换后（腾讯）|
|---|---|---|
| URL | SDK 内部走 OL-TL-RT-002 | `wss://asr.cloud.tencent.com/asr/v2/<appid>?<params>&signature=<sig>` |
| 鉴权 | SDK 注入 access_token | URL query 内 `secretid` + `signature` (HMAC-SHA1 + base64 + URL-encode；签名原文 = host+path+按字典序排好的 query 串，**不含 `wss://`**) |
| 引擎模型 | `qwen3-asr-flash-realtime` | `engine_model_type=16k_zh` (默认) / `16k_zh_en` (中英粤+9 方言大模型) / `16k_multi_lang` (多语种)；前端 lang 选择需映射到这套枚举 |
| 音频格式 | PCM16 16k mono（不变）| `voice_format=1` (PCM)，PCM16 16k mono；建议每 200ms 发 6400 字节（与现有 cpal 重采样兼容）|
| 帧 / 控制 | SDK 抽象 `RealtimeAsrSession::send_audio` / `finish` | 二进制 frame = 音频；text frame `{"type":"end"}` 表 finish；服务端发 `final:1` 后断开 |
| 事件解析 | `RealtimeEvent::{Partial, Final, Credits, Closed, Error, Ready}` | 统一 JSON：`{code, message, voice_id, message_id, result?, final?}`；`result.slice_type` 0/1=partial、2=final |
| sentence_id | SDK 给 i64 | 用 `result.index`（一段话序号，从 0 递增）|
| 鉴权失败码 | `Http 401` | `code=4002` / `code=4003` / `code=4005`，按 §3 错误模型映射到 `provider.unauthenticated` / `provider.insufficient_credits` |
| Idle 超时 | SaaS 60s | 腾讯 15s 未发音频自动断（`code=4008`），需要前端持续发帧或 silent PCM |
| 文件 | `src-tauri/src/stt/mod.rs` | 建议新增 `src-tauri/src/asr/tencent_realtime.rs`，stt_start 内按 `cfg!(feature="tencent_only")` 或 settings 分发 |

#### C2 短录音文件 → 腾讯 `CreateRecTask` (SourceType=1)

| 项 | 当前（SaaS） | 替换后（腾讯）|
|---|---|---|
| URL | SDK 内部 | `https://asr.tencentcloudapi.com/`（POST，公共参数走 header）|
| 鉴权 | SDK 注入 token | TC3-HMAC-SHA256；header：`X-TC-Action: CreateRecTask`、`X-TC-Version: 2019-06-14`、`X-TC-Timestamp`、`X-TC-Region`、`Authorization: TC3-HMAC-SHA256 Credential=<id>/<date>/asr/tc3_request, SignedHeaders=content-type;host, Signature=<hex>` |
| 请求体 | base64 + media_type | JSON `{ "EngineModelType":"16k_zh", "ChannelNum":1, "ResTextFormat":0, "SourceType":1, "Data":"<base64>", "DataLen":<bytes> }` |
| 大小限制 | SaaS ≤5min（duration check）| **本地 base64 ≤5MB**（注意：和现有 `SHORT_AUDIO_LIMIT_MS=5min` 不是同一维度，要按 byte 重新约束）|
| 同步 vs 异步 | SaaS 同步返回文本 | **腾讯异步**：返回 `{"Data":{"TaskId":<int>}}` → 必须**轮询** `DescribeTaskStatus`（与 C3 同一接口）|
| 轮询字段 | — | `Status`：0 waiting / 1 doing / 2 success / 3 failed；成功时 `Result` 是字符串（含时间戳），结构化数据在 `ResultDetail[].FinalSentence` |
| 文件 | `src-tauri/src/transcribe/mod.rs:104-128` | 替换为 `tencent_file_recognition::create_task` + 复用 C3 的轮询 |

> ⚠️ **重大语义差异**：腾讯**没有"短文件同步返回"接口**——`一句话识别` 也是 base64 但需轮询。当前 OL-TL-003 是同步返回，迁移到腾讯后 C2 用户会看到"等几秒再出字"。前端可能要加 loading spinner。

#### C3 长录音 URL → 腾讯 `CreateRecTask` (SourceType=0)

| 项 | 当前（SaaS） | 替换后（腾讯）|
|---|---|---|
| URL | SDK 内部 | 同 C2，统一走 `CreateRecTask` |
| 请求体 | `Input::from_url(url)` | `{ "EngineModelType":"16k_zh", "ChannelNum":1, "ResTextFormat":0, "SourceType":0, "Url":"<https://...>" }` |
| URL 限制 | DashScope 无明确公开 | 腾讯：URL ≤5h、≤1GB |
| 轮询 | `asr_long_ol_tl_004_task` 4s × 360 次 | `DescribeTaskStatus` 同样轮询；建议 4s 间隔，最长 24min |
| 结果字段 | `r.text.unwrap_or_default()` | `Data.Result`（带时间戳前缀的整段文本）+ `Data.ResultDetail[].FinalSentence` 拼接 |
| 计费字段 | `r.credits_consumed.unwrap_or(0.0)` | 腾讯无统一 credits 字段，需要按 `Data.AudioDuration` × 单价折算（单价见 [pricing.md](../../Tenas-All/OpenLoaf-saas/docs/tencent-asr/pricing.md)）|
| 文件 | `src-tauri/src/transcribe/mod.rs:150-211` | 改写整段；提取公共"轮询 helper" 给 C2 共用 |

#### C4 LLM 改写

**保持不变**——用户已经有 custom provider 入口（`ai_refine/mod.rs::resolve_custom`），让用户在 settings 里配自己的 OpenAI 兼容 endpoint 即可。腾讯 TMT 不是 OpenAI 协议，本期不接。

### 4.3 阿里 DashScope BYOK 文件转写（C2 / C3，PR-7 已落地）

> 阿里百炼 filetrans **不接 base64**，必须给公网 URL；本地音频要先上传到百炼自带的 OSS 临时存储拿 `oss://` URL，再交给 filetrans 任务接口。
>
> 实现：
> - `src-tauri/src/asr/aliyun/oss_upload.rs` — getPolicy + multipart 上传
> - `src-tauri/src/asr/aliyun/file.rs` — submit / 轮询 + 结果合并
> - 接入点：`src-tauri/src/transcribe/mod.rs` 的 `DictationBackend::AliyunFile` 分支

**步骤 1：getPolicy（拿临时上传凭证）**

```
GET https://dashscope.aliyuncs.com/api/v1/uploads?action=getPolicy&model=qwen3-asr-flash-filetrans
Header: Authorization: Bearer <ApiKey>
```

返回 `data.{policy, signature, upload_dir, upload_host, oss_access_key_id, x_oss_object_acl, x_oss_forbid_overwrite, expire_in_seconds, max_file_size_mb, capacity_limit_mb}`。policy 默认 48 小时有效，本地缓存 / 重用风险低，每次走 filetrans 都重新请求一次。

**步骤 2：multipart 上传到 OSS**

```
POST {upload_host}
Content-Type: multipart/form-data
Form fields（顺序敏感）:
  OSSAccessKeyId: <oss_access_key_id>
  Signature:      <signature>
  policy:         <policy>
  x-oss-object-acl:        <x_oss_object_acl>
  x-oss-forbid-overwrite:  <x_oss_forbid_overwrite>
  key:            <upload_dir>/<file_name>
  success_action_status: 200
  file:           <binary file>     # 必须最后
```

成功 200 → OSS URL：`oss://<bucket>/<upload_dir>/<file_name>`，bucket 取 upload_host 的二级域名（如 `dashscope-instant`）。

403 + body 含 `expired/Expired` → policy 过期，重新走步骤 1 然后 retry 一次（实现里走完一次重试不再循环）。

**步骤 3：提交 filetrans 任务**

```
POST https://dashscope.aliyuncs.com/api/v1/services/audio/asr/transcription
Header:
  Authorization: Bearer <ApiKey>
  Content-Type: application/json
  X-DashScope-OssResourceResolve: enable    # 必须！告诉服务端 file_urls 是 oss:// 私有
Body:
{
  "model": "qwen3-asr-flash-filetrans",
  "input": { "file_urls": ["oss://<bucket>/<upload_dir>/<file_name>"] }
}
```

返回 `{ "output": { "task_id": "...", "task_status": "PENDING" }, "request_id": "..." }`。

**步骤 4：轮询任务**

```
GET https://dashscope.aliyuncs.com/api/v1/tasks/{task_id}
Header: Authorization: Bearer <ApiKey>
```

`task_status`: `PENDING | RUNNING | SUCCEEDED | FAILED`。终态 SUCCEEDED 时 `output.results[*].transcription` 是文本，多 url 合并；FAILED 时 `output.{code, message}` 是失败原因。轮询间隔 3s、deadline 24min（与腾讯文件转写口径对齐）。

**错误码 ↔ overlay i18n（前缀 `aliyun_`）：**

| Rust 端错误 | 前端 i18n key | 说明 |
|---|---|---|
| `aliyun_unauthenticated` | `overlay:error.aliyun_unauthenticated` | 401/403：ApiKey 无效或权限不够 |
| `aliyun_file_too_large` | `overlay:error.aliyun_file_too_large` | 文件大小超过 `policy.max_file_size_mb`（默认 100MB），上传前短路 |
| `aliyun_upload_failed` | `overlay:error.aliyun_upload_failed` | OSS 上传非 200（含 PolicyExpired 重试后仍失败）|
| `aliyun_filetrans_failed` | `overlay:error.aliyun_filetrans_failed` | submit 或终态 FAILED |
| `aliyun_filetrans_timeout` | `overlay:error.aliyun_filetrans_timeout` | 24 分钟内未返回终态 |
| `aliyun_rate_limited` | `overlay:error.aliyun_rate_limited` | 429 |
| `aliyun_network_error` | `overlay:error.stt_network` | 网络层 / 非以上分类 |

---

## 5. 实施顺序建议（凭证决策落地后）

1. **新建 `src-tauri/src/asr/`**（与 `stt/` `transcribe/` 同级），先放 `tencent/` 子目录
   - `tencent/signature.rs`：导出 `sign_ws(query: &BTreeMap<&str,String>, secret_key: &str) -> String`（HMAC-SHA1 + base64）和 `sign_v3(...) -> Authorization header`（TC3-HMAC-SHA256）
   - `tencent/realtime.rs`：实现 C1，封装与 `RealtimeAsrSession` 等价的接口（`send_audio` / `finish` / `next_event`）
   - `tencent/file.rs`：实现 C2 + C3 的 `CreateRecTask` + `DescribeTaskStatus`
2. **`stt/mod.rs` / `transcribe/mod.rs` 改为分发器**：按 settings.providers.mode 分到 SaaS or Tencent；过渡阶段 `mode` 默认强制 `tencent`（"临时全替换"）
3. **secrets 模块支持双字段凭证**：当前 `secrets/mod.rs` 只支持单 string，加 `secret_get_struct`/`secret_set_struct` helper
4. **前端 settings UI**：先做最小切换器（CLOUD / Tencent BYOK），后续按 [speech-providers.md §9](./speech-providers.md) 演进

每步落地后跑：`cargo check --all-targets`、`cargo test --lib`、手动跑 `examples/test_tencent_realtime_asr.rs`（待新建）。

---

## 6. 维护规则

新增 / 修改云接口调用时按以下流程：

1. **加新接入点**：在 §1 表里加一行（业务能力 / Command / 文件 : 行 / 当前实现 / 协议）。
2. **加新 vendor**：在 §2 矩阵相应列加一格；同时在 [speech-providers.md §6.5](./speech-providers.md) Capability 矩阵里给值。
3. **改凭证形态**：更新 §3 keyring 命名约定；通过 schema migration 平滑迁移老用户。
4. **删除接入点**：保留行 + 标 ~~strikethrough~~ 一个 release，下个版本删除。

腾讯文档原始抓取见 `Tenas-All/OpenLoaf-saas/docs/tencent-asr/`（仓外路径）。
