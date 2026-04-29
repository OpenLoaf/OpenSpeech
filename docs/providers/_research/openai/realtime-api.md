> 来源：OpenAI 官方文档（platform.openai.com / developers.openai.com / openai.com）
> 抓取日期：2026-04-28
> 注：openai 官方域名直接 fetch 受 403 / 安全策略拦截；事实通过 WebSearch 抓取的官方文档摘录整理，每条附原始官方深链。

# Realtime API (`/v1/realtime`)

## Endpoint

`wss://api.openai.com/v1/realtime?model=<model_id>`

- 官方 reference：https://platform.openai.com/docs/api-reference/realtime
- 官方 guide：https://platform.openai.com/docs/guides/realtime
- WebSocket 模式 guide：https://developers.openai.com/api/docs/guides/realtime-websocket
- Realtime 转写 guide：https://developers.openai.com/api/docs/guides/realtime-transcription
- Server-side controls：https://platform.openai.com/docs/guides/realtime-server-controls
- SIP 接入：https://platform.openai.com/docs/guides/realtime-sip

## 模型

| 模型 ID | 说明 | 文档 |
|---|---|---|
| `gpt-realtime` | GA 主推模型，相比 preview 价格降 20% | https://openai.com/index/introducing-gpt-realtime/ |
| `gpt-realtime-mini` | 更小/更便宜版本 | https://developers.openai.com/api/docs/pricing |
| `gpt-4o-realtime-preview` | 早期 preview 模型 | https://platform.openai.com/docs/models/gpt-4o-realtime-preview |
| `gpt-4o-mini-realtime-preview` | gpt-4o realtime 的 mini preview | https://developers.openai.com/api/docs/models/gpt-4o-mini-realtime-preview |

## 协议

WebSocket 全双工，事件驱动；client → server 与 server → client 都是 JSON 事件。

- Client events 列表：https://platform.openai.com/docs/api-reference/realtime-client-events
- Server events 列表：https://platform.openai.com/docs/api-reference/realtime-server-events

> Realtime API 模型直接接收音频；输入端的"转写文本"是独立的 ASR pass，与模型对音频的内部理解可能略有差异，应作为参考。
> 来源：https://developers.openai.com/api/docs/guides/realtime-transcription

## 鉴权

两种方式：

1. **服务器侧**：用标准 API key（Bearer）建立 WebSocket，token 仅暴露在后端。
2. **客户端 / 浏览器**：使用 ephemeral client secret。GA 接口下唯一的密钥生成端点是：
   `POST /v1/realtime/client_secrets`
   返回 client_secret 用于初始化 WebRTC 或 WebSocket。
   来源：https://platform.openai.com/docs/api-reference/realtime / https://developers.openai.com/api/docs/guides/realtime-websocket

> Beta 时期还有多个独立 ephemeral 端点，GA 已统一为 `/v1/realtime/client_secrets`。

## 音频 I/O

支持的格式：`pcm16`、`g711_ulaw`、`g711_alaw`。

| 格式 | 输入要求 | 输出要求 |
|---|---|---|
| `pcm16` | 16-bit PCM, 24 kHz, 单声道 | 24 kHz |
| `g711_ulaw` | audio/pcmu | audio/pcmu |
| `g711_alaw` | audio/pcma | audio/pcma |

来源：https://learn.microsoft.com/en-us/azure/foundry/openai/realtime-audio-reference（Azure 镜像了 OpenAI 官方 schema）；OpenAI 原文：https://platform.openai.com/docs/guides/realtime / https://developers.openai.com/api/docs/guides/realtime-websocket

## 关键事件

### 输入音频缓冲 / VAD

- `input_audio_buffer.append`（client）— 推 PCM 数据
- `input_audio_buffer.commit`（client / server）— 提交一段音频
- `input_audio_buffer.speech_started`（server）— VAD 检测到说话开始
- `input_audio_buffer.speech_stopped`（server）— VAD 检测到说话结束
- `conversation.item.input_audio_transcription.completed`（server）— 输入音频的转写完成
- `conversation.item.input_audio_transcription.failed`（server）— 转写失败

来源：https://platform.openai.com/docs/api-reference/realtime-server-events / https://platform.openai.com/docs/api-reference/realtime-client-events / https://platform.openai.com/docs/api-reference/realtime-client-events/input_audio_buffer/append

### VAD 模式

> The Realtime API supports two main VAD modes:
> - `server_vad`：服务端基于音频检测 end-of-speech，自动触发 response 生成
> - `semantic_vad`：基于词义判断"用户是否说完"，用一个语义分类器打分
>
> 来源：https://developers.openai.com/api/docs/guides/realtime-vad

## 计费

> Realtime API 同时按 **音频时长** 与 **文本 token** 双计量。流式输入 + 输出语音时，要为输入分钟、输出分钟、以及途中的 text tokens 分别计费。
> 来源：https://openai.com/api/pricing/、https://developers.openai.com/api/docs/pricing

参考 token 定价（以官方 pricing 页为准）：

- `gpt-realtime`：audio input $32 / 1M tokens（cached input $0.40）；audio output $64 / 1M tokens
- `gpt-4o-realtime-preview`：audio input ≈ $100 / 1M tokens（≈ $0.06/min）；audio output ≈ $200 / 1M tokens（≈ $0.24/min）
- text input：$5 / 1M tokens；text output：$20 / 1M tokens（cached text input $2.50/1M）

来源：https://openai.com/index/introducing-gpt-realtime/ / https://openai.com/api/pricing/

## 单连接限制 / 会话

- 单连接为一个 WebSocket session，使用 `session.update` 配置 type / instructions / voice / 输入音频格式 / VAD 模式 / 工具等。
- 官方文档未在公开页面给出"每账号最大并发 WebSocket 连接数"具体数字（受 rate limit / tier 控制）。
  来源：https://platform.openai.com/docs/api-reference/realtime / https://platform.openai.com/docs/guides/rate-limits

## 受限页面（fetch 失败，已用 WebSearch 间接核对）

- https://platform.openai.com/docs/api-reference/realtime — 403
- https://platform.openai.com/docs/api-reference/realtime-server-events — 403
- https://platform.openai.com/docs/api-reference/realtime-client-events — 403
- https://platform.openai.com/docs/guides/realtime — 403
- https://developers.openai.com/api/docs/guides/realtime-websocket — 域名安全检查拒绝
- https://openai.com/index/introducing-gpt-realtime/ — 域名安全检查拒绝
