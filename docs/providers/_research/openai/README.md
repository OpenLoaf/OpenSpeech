> 来源：OpenAI 官方文档（platform.openai.com / openai.com / help.openai.com）
> 抓取日期：2026-04-28

# OpenAI Provider Research

OpenSpeech provider 适配研究。OpenAI 在我们的设计中走 `byo-rest` 兜底（非流式 Whisper），同时也是常见 LLM provider。

## 索引

- [audio-transcriptions.md](./audio-transcriptions.md) — Whisper / gpt-4o-transcribe（核心）
- [audio-translations.md](./audio-translations.md) — `/v1/audio/translations`
- [realtime-api.md](./realtime-api.md) — Realtime WebSocket（核心）
- [chat-completions.md](./chat-completions.md) — Chat Completions
- [auth-and-billing.md](./auth-and-billing.md) — 鉴权与计费
- [capability-summary.md](./capability-summary.md) — OpenSpeech capability 对照（核心交付物）

## 抓取失败 / 跳过的页面

OpenAI 全部官方域名（`platform.openai.com` / `developers.openai.com` / `openai.com` / `help.openai.com`）以及 `github.com/openai/*` 在本环境下都被 WebFetch 直接拒绝（platform 返回 403，其余返回 "Unable to verify if domain is safe to fetch"）。

实际事实通过 **WebSearch 抓取的官方页摘录** 整理，每条事实在文档中都附了对应官方 URL 以供人工核对。受限的页面包括：

- https://platform.openai.com/docs/guides/speech-to-text
- https://platform.openai.com/docs/api-reference/audio/createTranscription
- https://platform.openai.com/docs/api-reference/audio/createTranslation
- https://platform.openai.com/docs/guides/realtime
- https://platform.openai.com/docs/api-reference/realtime
- https://platform.openai.com/docs/api-reference/realtime-server-events
- https://platform.openai.com/docs/api-reference/realtime-client-events
- https://platform.openai.com/docs/api-reference/chat/create
- https://platform.openai.com/docs/models/*
- https://platform.openai.com/docs/api-reference/authentication
- https://platform.openai.com/docs/guides/rate-limits
- https://platform.openai.com/docs/guides/error-codes
- https://developers.openai.com/api/docs/guides/realtime-websocket
- https://developers.openai.com/api/docs/guides/realtime-vad
- https://developers.openai.com/api/docs/guides/realtime-transcription
- https://developers.openai.com/api/docs/guides/streaming-responses
- https://developers.openai.com/api/docs/pricing
- https://openai.com/api/pricing/
- https://openai.com/index/introducing-the-realtime-api/
- https://openai.com/index/introducing-gpt-realtime/
- https://help.openai.com/en/articles/7031512-audio-api-faq
- https://github.com/openai/openai-cookbook/...
- https://github.com/openai/openai-python/...

完成的产品：Audio Transcriptions、Audio Translations、Realtime、Chat Completions、Auth & Billing、Capability Summary。
跳过的产品：TTS / Responses API（按任务说明属优先级 4，未抓取）。
