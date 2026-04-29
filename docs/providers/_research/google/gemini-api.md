> 来源：官方文档
> - https://ai.google.dev/api
> - https://ai.google.dev/gemini-api/docs/models
> - https://ai.google.dev/gemini-api/docs/text-generation
> - https://ai.google.dev/gemini-api/docs/pricing
> - https://ai.google.dev/gemini-api/docs/openai
> - https://ai.google.dev/gemini-api/docs/long-context
> - https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference
>
> 抓取日期：2026-04-28

# Gemini API

## 1. 入口

Google 提供两个独立的 Gemini 接口，使用同一类底层模型，但鉴权 / 项目模型 / 定价分别独立：

| 入口 | 域名 | 鉴权 | 适用场景 |
| --- | --- | --- | --- |
| **Gemini Developer API** (AI Studio) | `https://generativelanguage.googleapis.com` | API Key (header `x-goog-api-key` 或 query `?key=`) | 个人 / 快速原型 / 客户端集成。提供免费 tier。 |
| **Vertex AI Gemini** | `https://{region}-aiplatform.googleapis.com` | OAuth/ADC + GCP project + Service Account | 企业生产、与其它 GCP 服务联动、SLA、VPC-SC。 |

来源：https://ai.google.dev/api ; https://docs.cloud.google.com/vertex-ai/generative-ai/docs/model-reference/inference

## 2. 当前推荐模型（2026-04 时点）

来源：https://ai.google.dev/gemini-api/docs/models

| 模型 ID | 用途 | 上下文窗口 |
| --- | --- | --- |
| `gemini-2.5-pro` | 高质量推理 + 工具使用 + 多模态。 | **1,000,000 tokens** input |
| `gemini-2.5-flash` | 速度/成本均衡，多模态。**计划 2026-06 deprecated**，迁移到下一代 flash。 | 1,000,000 tokens |
| `gemini-3-*` 系列 | Gemini 3 已发布，作为 2.5 的替代物（具体型号请查 models 页正文）。 | — |

OpenSpeech 集成建议：默认 `gemini-2.5-flash`（成本/延迟），高质量任务 fallback 到 `gemini-2.5-pro`。同时盯 release notes，2026-06 前切到 Gemini 3 flash。

## 3. 主要 REST 路径（Developer API）

| 方法 | URL | 说明 |
| --- | --- | --- |
| 同步生成 | `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` | 请求-响应。 |
| **流式生成** | `POST .../v1beta/models/{model}:streamGenerateContent?alt=sse` | SSE，逐 chunk push `GenerateContentResponse`。 |
| 列模型 | `GET .../v1beta/models` | 含 `inputTokenLimit` / `outputTokenLimit` / `supportedGenerationMethods`。 |
| Token 计数 | `POST .../v1beta/models/{model}:countTokens` | 估算计费。 |
| Embeddings | `POST .../v1beta/models/{model}:embedContent` | |
| Live (双向 streaming) | WebSocket `wss://generativelanguage.googleapis.com/.../BidiGenerateContent` | 实时语音/视频对话。 |

来源：https://ai.google.dev/api ; https://ai.google.dev/gemini-api/docs/text-generation ; https://ai.google.dev/gemini-api/docs/live-guide

## 4. 流式响应（SSE）

来源：https://ai.google.dev/gemini-api/docs/text-generation

- `streamGenerateContent` 加 `?alt=sse` 后返回 `text/event-stream`，每个 event 的 `data:` 是一个完整的 `GenerateContentResponse` JSON（含 `candidates[].content.parts[].text` 增量片段）。
- 不带 `?alt=sse` 时返回的是 `application/json`，里面是数组形式的多个 response 对象（一次性 flush）。

## 5. OpenAI Compatibility

来源：https://ai.google.dev/gemini-api/docs/openai

- Base URL：`https://generativelanguage.googleapis.com/v1beta/openai/`
- 端点：`/chat/completions`、`/completions`、`/embeddings`、`/models`、`/files`（部分受限）。
- 用 OpenAI SDK 时把 `api_key` 改成 Gemini API Key、`base_url` 改成上面的地址即可。
- 支持 `stream=true`（OpenAI 风格 `data: {...}\n\ndata: [DONE]\n\n`）。
- Vertex AI 也提供 OpenAI 兼容入口：见 https://docs.cloud.google.com/vertex-ai/generative-ai/docs/start/openai

OpenSpeech 集成建议：在 LLM adapter 层用 OpenAI 兼容路径接 Gemini，可以与 OpenAI provider 共用 SSE 解析器。

## 6. 鉴权

| 方式 | 适用 | 说明 |
| --- | --- | --- |
| API Key | Developer API | 简单；可在 Google AI Studio 创建。**禁止在公开客户端长期暴露**。 |
| OAuth2 user token | Developer API | 仅特定 endpoint。 |
| ADC + Service Account | Vertex AI | 标准 GCP 方式；推荐生产用。 |

## 7. 定价（Developer API；2026-04 时点）

来源：https://ai.google.dev/gemini-api/docs/pricing

- **Gemini 2.5 Flash (Standard tier, paid)**：
  - input：$0.50 / 1M tokens（text/image/video）
  - output：$3.00 / 1M tokens
  - context cache：$0.05 / 1M tokens
- **Gemini 2.5 Pro (preview rates)**：
  - input：$4 / 1M tokens
  - output：$20 / 1M tokens
- 免费 tier：仅限低 RPM、低日额，且**输入会被用于改进 Google 模型**。生产请用 paid tier。
- Vertex AI 价格独立，按 region 浮动。

## 8. Capability 速查

| Capability | 支持 | 说明 |
| --- | --- | --- |
| 流式输出 | yes | `streamGenerateContent?alt=sse` 或 OpenAI 兼容 `stream=true`。 |
| 1M context | yes | 2.5 Pro / Flash 均 1,000,000 input tokens。 |
| 工具/Function Calling | yes | `tools[].functionDeclarations`。 |
| 多模态 (image/video/audio) | yes | parts 中 `inlineData{mimeType, data}` 或 `fileData{fileUri, mimeType}`。 |
| 双向语音/视频 (Live API) | yes | WebSocket，低延迟。 |
| Safety settings | yes | `safetySettings[]` 可逐 category 调阈值。 |
| System instruction | yes | request 顶层 `systemInstruction`。 |
| Structured output (JSON schema) | yes | `generationConfig.responseMimeType = "application/json"` + `responseSchema`。 |

## 9. 抓取失败 / 待补

- 当前推荐 ID 与价格随版本快速漂移，正式集成前请直读：
  - https://ai.google.dev/gemini-api/docs/models
  - https://ai.google.dev/gemini-api/docs/pricing
- Gemini 3 系列具体 model id 在搜索摘要中未拿到，留待集成时确认。
