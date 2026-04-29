> 来源：OpenAI 官方文档（platform.openai.com / developers.openai.com / openai.com）
> 抓取日期：2026-04-28
> 注：openai 域名直接 fetch 受拦截；事实通过 WebSearch 抓取的官方页摘录整理。

# Chat Completions API (`/v1/chat/completions`)

## Endpoint

`POST https://api.openai.com/v1/chat/completions`

- 官方 reference：https://platform.openai.com/docs/api-reference/chat/create
- 官方 guide：https://platform.openai.com/docs/guides/text-generation
- API 总览：https://platform.openai.com/docs/api-reference/introduction
- 流式 guide：https://developers.openai.com/api/docs/guides/streaming-responses

## 主推模型（2026-04 时点）

| 模型 ID | 上下文窗口 | 说明 | 文档 |
|---|---|---|---|
| `gpt-4.1` | 128K（具体见 model 页） | GPT-4.1 主线 | https://platform.openai.com/docs/models/gpt-4.1 |
| `gpt-4.1-mini` | 128K | gpt-4.1 mini | https://platform.openai.com/docs/models/gpt-4.1-mini |
| `gpt-4o` | 128K | 多模态主线 | https://platform.openai.com/docs/models/gpt-4o |
| `gpt-4o-mini` | 128K | 文本+视觉小模型，成本低 | https://developers.openai.com/api/docs/models/gpt-4o-mini |
| `o1` / `o1-mini` | 推理模型 | 不支持 system / developer 消息 | https://platform.openai.com/docs/models/o1 |
| `o3` / `o4-mini` | 推理模型 | 通过 Chat Completions API 与 Responses API 提供 | https://openai.com/index/introducing-o3-and-o4-mini/ |

> Note: `o1-preview` 与 `o1-mini` 不支持 system / developer messages。
> 来源：https://platform.openai.com/docs/models/o1

## 流式输出（SSE）

> Chat Completions API uses HTTP streaming over server-sent events (SSE). Set `stream=true` to stream completions; the API returns data-only server-sent events.
> 来源：https://developers.openai.com/api/docs/guides/streaming-responses

事件 chunk 结构：`data: {choices:[{delta:{content:"..."}}]}\n\n`，结束以 `data: [DONE]` 标记。
来源：https://platform.openai.com/docs/api-reference/chat/streaming

## 鉴权

HTTP Bearer：`Authorization: Bearer <API_KEY>`。可附加 `OpenAI-Organization` / `OpenAI-Project` header 指定组织与项目。
来源：https://platform.openai.com/docs/api-reference/authentication

## 计费

按 token（input / output / cached input）计费，单价随模型不同；详见：
https://openai.com/api/pricing/
https://developers.openai.com/api/docs/pricing

## 受限页面

- https://platform.openai.com/docs/api-reference/chat/create — 403
- https://platform.openai.com/docs/models/* — 403
