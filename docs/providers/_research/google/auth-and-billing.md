> 来源：官方文档
> - https://cloud.google.com/docs/authentication/application-default-credentials
> - https://cloud.google.com/iam/docs/service-account-creds
> - https://cloud.google.com/speech-to-text/docs/v1/authentication
> - https://cloud.google.com/translate/docs/authentication
> - https://cloud.google.com/speech-to-text/pricing
> - https://cloud.google.com/translate/pricing
> - https://ai.google.dev/gemini-api/docs/pricing
> - https://cloud.google.com/speech-to-text/v2/docs/locations
>
> 抓取日期：2026-04-28

# Google Cloud — 通用鉴权 / 计费 / Region

适用：Speech-to-Text V2、Cloud Translation v3、Vertex AI Gemini。
**不适用** Gemini Developer API（ai.google.dev）的 API Key 模式 — 那条单独说明。

## 1. 鉴权方式

### 1.1 Application Default Credentials (ADC)

来源：https://cloud.google.com/docs/authentication/application-default-credentials

- 推荐生产用法。客户端库自动按以下优先级查找凭据：
  1. `GOOGLE_APPLICATION_CREDENTIALS` 环境变量指向的 JSON 文件（service account 或 external account）。
  2. `gcloud auth application-default login` 写入的本地用户凭据 (`~/.config/gcloud/application_default_credentials.json`)。
  3. GCE / GKE / Cloud Run 等 GCP runtime 的 metadata server。
- 默认 token scope：`https://www.googleapis.com/auth/cloud-platform`（覆盖所有 GCP API）。

### 1.2 Service Account Key (JSON)

来源：https://cloud.google.com/iam/docs/service-account-creds

- 在 IAM & Admin 创建 SA → 下载 JSON。
- 设 `GOOGLE_APPLICATION_CREDENTIALS=/path/to/key.json`。
- 客户端库内部自签 JWT → 换 OAuth2 access token (1 小时有效)。
- 需要的角色：
  - Speech-to-Text：`roles/speech.client`（V2: `roles/speech.editor` 用于创建 recognizer）。
  - Translation：`roles/cloudtranslate.user`。
  - Vertex AI：`roles/aiplatform.user`。

### 1.3 API Key

- 仅 **Cloud Translation Basic (v2)** 与 **Gemini Developer API** 支持。
- Speech-to-Text **不支持** API Key（必须 OAuth/ADC）。
- Translation Advanced (v3) 的 batch / glossary / AutoML 不能用 API Key。
- API Key 应配置 referer / IP / API restriction。

### 1.4 OAuth User Token

- 对桌面应用做用户登录可用 OAuth installed app flow，但 OpenSpeech 桌面端为单用户场景，建议绑定到用户的 GCP project + service account。

## 2. Region 列表

来源：https://cloud.google.com/speech-to-text/v2/docs/locations

Speech-to-Text V2 常见可用 region：

- `global`（多区域负载均衡）
- 美洲：`us-central1`, `us-east1`, `us-east4`, `us-west1`, `us-west4`
- 欧洲：`europe-west1`, `europe-west2`, `europe-west3`, `europe-west4`, `europe-west6`
- 亚太：`asia-northeast1` (Tokyo), `asia-northeast3` (Seoul), `asia-southeast1` (Singapore), `asia-south1` (Mumbai), `australia-southeast1`

不同 region 支持的 model × language 子集不同；**chirp_3 当前主要在 `global` + 美洲 region**（请直读 locations 页确认）。

Translation v3 region：默认 `global`；glossary / batch / AutoML 必须指定 region（常用 `us-central1` / `europe-west1`）。

Vertex AI Gemini region：与 GCP region 一致，部分 preview 模型仅 `us-central1`。

## 3. 计费摘要

### 3.1 Speech-to-Text V2

来源：https://cloud.google.com/speech-to-text/pricing

- **免费 tier**：每月 60 minutes 免费（按音频时长，全模型合计）。
- 计费单位：**按秒**（V2 已从 V1 的「按 15s 取整」改为按 1 秒计费）。
- 模型不再区分 standard / enhanced 价格 — 所有模型按 standard 价。
- 具体价格按 region 和模型档浮动，正文见上方 URL。

### 3.2 Cloud Translation

来源：https://cloud.google.com/translate/pricing

- **免费 tier**：500K characters / month。
- NMT / AutoML：按 characters 计费（含空格、标点、不可翻译字符），按 target language 数倍数。
- Translation LLM：input $10 / 1M chars + output $10 / 1M chars。
- Document Translation：另收 page surcharge。

### 3.3 Gemini Developer API

来源：https://ai.google.dev/gemini-api/docs/pricing

- 免费 tier：低 RPM / 日额；输入会被用于改进 Google 模型。生产请用 paid tier。
- 2.5 Flash paid：input $0.50 / 1M tok，output $3.00 / 1M tok，cache $0.05 / 1M tok。
- 2.5 Pro paid：input $4 / 1M tok，output $20 / 1M tok。

### 3.4 Vertex AI Gemini

- 价格独立公布（与 Developer API 不一致），按 region。
- 不会用客户数据训练 Google 模型（合同保障）。

## 4. SDK / 客户端库

来源：https://cloud.google.com/docs/authentication/client-libraries

- Python：`google-cloud-speech` / `google-cloud-translate` / `google-genai`。
- Rust：官方未提供 first-party Rust 客户端。
  - 可选 community：`gcp_auth`（拿 token）+ 自手 gRPC（tonic + prost-build 编译 googleapis .proto）+ `reqwest`（REST）。
  - Rust 直连 streaming 必须自己集成 `tonic` 双向流。
- Node：`@google-cloud/speech` / `@google-cloud/translate` / `@google/genai`。

## 5. Quotas 共性

- 所有产品都支持 console 中按 project 申请增配。
- 默认 RPM / 并发都偏紧（特别 streaming），生产前请提交 quota request。

## 6. 抓取失败 / 待补

- 各产品的最新 per-second / per-token 单价请直读价格页；本文价格信息仅快照式记录。
- region 列表为已知常见值，正式集成时以 `https://cloud.google.com/speech-to-text/v2/docs/locations` 为准。
