# Azure OpenAI（LLM 调用集成）

> 来源：
> - https://learn.microsoft.com/en-us/azure/ai-services/openai/reference
> - https://learn.microsoft.com/en-us/azure/foundry/openai/reference
> - https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models
> - https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/endpoints
> - https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id
>
> 抓取日期：2026-04-28

---

## 1. 与开源 OpenAI API 的核心差异

| 维度 | Azure OpenAI | OpenAI.com |
| --- | --- | --- |
| Base URL | `https://<resource>.openai.azure.com` | `https://api.openai.com` |
| Path 模式 | `/openai/deployments/<deployment-name>/chat/completions` | `/v1/chat/completions` |
| Model 选择 | URL 里 deployment 名 | request body 里 `"model": "..."` |
| API 版本 | **必带** `?api-version=YYYY-MM-DD` | path 内 `/v1` |
| Auth header | `api-key: <KEY>`（首选）/ `Authorization: Bearer <ENTRA>` | `Authorization: Bearer <KEY>` |
| Managed Identity | 支持 | 不支持 |
| Chat Extensions（`data_sources`） | 支持（On Your Data） | 不支持 |
| 内容安全 | 强制 + `content_filter_results` 字段 | 自选 |

> Azure 在 path 里**用 deployment 名**，意味着你必须先在 Azure 控制台部署一个模型并起名（例如 `my-gpt5-prod`），然后客户端用 `my-gpt5-prod` 而非 `gpt-5`。

## 2. Endpoint 形式

### 2.1 Per-resource (deployment-based)
```
POST https://<resource>.openai.azure.com/openai/deployments/<deployment-id>/chat/completions?api-version=2024-10-21
```

### 2.2 v1 API（实验性，与 OpenAI SDK 兼容）
```
https://<resource>.openai.azure.com/openai/v1/
https://<resource>.services.ai.azure.com/openai/v1/
```
v1 API 让 OpenAI 官方 SDK 几乎不用改就能跑，但仍要带 api-version。

## 3. API 版本

| 类别 | 当前 GA | 当前 Preview |
| --- | --- | --- |
| Data plane (inference) | `2024-10-21` | `v1 preview` |
| Control plane | `2025-06-01` | `2025-07-01-preview` |

参考：https://learn.microsoft.com/en-us/azure/foundry/openai/api-version-lifecycle

## 4. 鉴权

### 4.1 API Key
```
api-key: <KEY>
```

### 4.2 Microsoft Entra ID（推荐生产）
```
Authorization: Bearer <ACCESS_TOKEN>
```
- Scope：`https://cognitiveservices.azure.com/.default`
- 角色：`Cognitive Services OpenAI User` 或 `Cognitive Services OpenAI Contributor`
- Managed Identity 在 Azure VM/App Service/Function 上无密钥
- 详见 https://learn.microsoft.com/en-us/azure/foundry/foundry-models/how-to/configure-entra-id

## 5. Chat Completions Body

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "Hello" }
  ],
  "temperature": 0.7,
  "top_p": 1.0,
  "max_tokens": 2048,
  "stream": false,
  "stop": ["</end>"],
  "presence_penalty": 0,
  "frequency_penalty": 0,
  "tools": [...],
  "tool_choice": "auto",
  "response_format": { "type": "json_object" },
  "seed": 12345,
  "user": "<end-user-id>"
}
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `messages` | array | — | role: system/user/assistant/tool |
| `temperature` | num | 1 | 0-2 |
| `top_p` | num | 1 | nucleus sampling |
| `max_tokens` | int | — | 输出上限 |
| `max_completion_tokens` | int | — | 推理 + 输出合计上限（用于 o1/o3 类） |
| `stream` | bool | false | 启用 SSE |
| `presence_penalty` / `frequency_penalty` | num | 0 | -2 到 2 |
| `logit_bias` | obj | — | token_id → -100~100 |
| `seed` | int | — | 决定性 |
| `tools` | array | — | function definitions |
| `tool_choice` | str/obj | auto | none/auto/required/{name} |
| `response_format` | obj | — | JSON mode 或 schema |
| `data_sources` | array | — | Azure 专属：On Your Data |
| `n` | int | 1 | 候选数 |
| `logprobs` / `top_logprobs` | bool/int | false / — | 概率输出 |
| `user` | str | — | 滥用监控 |

### 5.1 多模态（vision）

```json
{
  "role": "user",
  "content": [
    { "type": "text", "text": "What's in this image?" },
    { "type": "image_url", "image_url": { "url": "https://...", "detail": "auto" } }
  ]
}
```

## 6. 流式（SSE）

`"stream": true` 时返回 `text/event-stream`，每行 `data: {...}`，最后一行 `data: [DONE]`：

```
data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1686676106,"model":"gpt-4o","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}

data: {"id":"chatcmpl-...","object":"chat.completion.chunk","created":1686676106,"model":"gpt-4o","choices":[{"index":0,"delta":{"content":" there"},"finish_reason":null}]}

data: [DONE]
```

要点：
- 与 OpenAI.com 完全兼容的 SSE 格式
- `choices[].delta.content` 是增量文本
- `finish_reason` 在最后一个 chunk 给（`stop` / `length` / `tool_calls` / `content_filter`）
- Tool calls 流式：`delta.tool_calls[]` 增量拼

## 7. 非流式响应

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1686676106,
  "model": "gpt-4o",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "..." },
      "finish_reason": "stop"
    }
  ],
  "usage": { "prompt_tokens": 33, "completion_tokens": 557, "total_tokens": 590 },
  "system_fingerprint": "fp_..."
}
```

## 8. 错误结构（含内容过滤）

```json
{
  "error": {
    "code": "ResponsibleAIPolicyViolation",
    "message": "...",
    "type": "invalid_request_error",
    "param": "messages",
    "inner_error": {
      "code": "ResponsibleAIPolicyViolation",
      "content_filter_results": {
        "hate":      { "severity": "high", "filtered": true },
        "sexual":    { "severity": "safe", "filtered": false },
        "violence":  { "severity": "safe", "filtered": false },
        "self_harm": { "severity": "safe", "filtered": false }
      }
    }
  }
}
```

`content_filter_results` 是 Azure 独有的。

## 9. 可用模型

完整列表与 region 矩阵在 https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/models 和 `models-sold-directly-by-azure.md`（文件较大，已 persist 到 tool-results 但未在此处展开）。

主要支持：

| 模型族 | 备注 |
| --- | --- |
| GPT-5 / GPT-5-mini / GPT-5-nano / GPT-5-chat | 最新一代 |
| GPT-5.1 / 5.2 / 5.3-chat / 5.4 | 增强变体 |
| GPT-4.1 / 4.1-mini / 4.1-nano | |
| GPT-4o / GPT-4o-mini | 多模态 |
| o1 / o3 系列 | reasoning |
| GPT-3.5 Turbo | 旧版仍可用 |
| Whisper | STT (vs Speech 服务的 Whisper batch) |
| text-embedding-3-* | embeddings |
| DALL-E 3 / GPT-image | 图像 |

## 10. 部署类型 (Deployment Types)

| 类型 | 说明 |
| --- | --- |
| **Standard** | 单 region，按需付费 |
| **Global Standard** | 全球容量池，最高可用性 |
| **Data Zone Standard** | 数据驻留在指定 zone（如 eu, us） |
| **Provisioned Throughput Units (PTU)** | 预留容量，可保 SLA |
| **Batch** | 异步批量，价格折扣 |

详见 https://learn.microsoft.com/en-us/azure/ai-foundry/openai/concepts/deployment-types

## 11. 计费

按 token 计费，input / output 两档定价；不同模型差距巨大。
官方价目表：https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/

## 12. OpenSpeech 适配建议

- **"问 AI / 润色"功能**：Chat Completions API，用 deployment 名直连，启用 `stream=true`。
- **deployment 名拿 from config**：用户在自己的 Azure 控制台部署，OpenSpeech 让用户填 `endpoint + deployment + api-version + key`。
- **流式协议与 OpenAI 完全兼容**——可以复用同一份 SSE 解析逻辑，只换 base URL 与 auth header。
- 内容过滤可能让某些 prompt 直接返回 `400 ResponsibleAIPolicyViolation`，需要 UI 上能区分"网络错误"与"内容被拦截"。
- 想最大化 SDK 兼容性 → 用 v1 endpoint：`https://<resource>.openai.azure.com/openai/v1/`，OpenAI Python SDK 几乎不用改。
