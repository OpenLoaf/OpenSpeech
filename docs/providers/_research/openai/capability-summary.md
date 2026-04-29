> 来源：OpenAI 官方文档（platform.openai.com / developers.openai.com / openai.com）
> 抓取日期：2026-04-28
> 注：openai 域名直接 fetch 受 403 / 安全策略拦截，事实通过 WebSearch 摘要的官方文档段交叉确认；每条附原始官方深链。

# OpenSpeech Capability Summary — OpenAI

按 OpenSpeech capability 模型逐项给出 OpenAI 的支持情况，**分两条路径**：

- **A 列 = Whisper / Audio Transcriptions API**（`POST /v1/audio/transcriptions`，对应我们的 `byo-rest` 兜底）
- **B 列 = Realtime API**（`wss://api.openai.com/v1/realtime`，作为 OpenAI 路径的 ASR provider）

图例：✅ 支持 / ⚠️ 受限 / ❌ 不支持 / ❓ 官方文档未明确说明

---

## ASR capabilities

### `asr.streaming`（连接到模型时实时推音频，模型增量返回结果）

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ⚠️ 部分 | `whisper-1` 不支持 stream；`gpt-4o-transcribe` / `gpt-4o-mini-transcribe` 支持 `stream=true`（SSE，事件 `transcript.text.delta` / `transcript.text.done`）。本质仍是"上传一个完整文件后边解码边推送"，不是双向音频流。 | https://platform.openai.com/docs/api-reference/audio/createTranscription |
| **B: Realtime** | ✅ | 全双工 WebSocket，client 持续 `input_audio_buffer.append` 推音频。 | https://platform.openai.com/docs/api-reference/realtime |

### `asr.partial`（在 final 之前给出 partial / interim 文本）

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ⚠️ | gpt-4o-transcribe 系列 `stream=true` 时通过 `transcript.text.delta` 增量推送，可视作 interim；whisper-1 仅一次性返回。 | https://platform.openai.com/docs/api-reference/audio/createTranscription |
| **B: Realtime** | ✅ | `conversation.item.input_audio_transcription.completed` 事件给出输入音频的最终转写；增量 delta 通过流式响应事件传递。 | https://developers.openai.com/api/docs/guides/realtime-transcription |

### `asr.server_vad`（服务端 VAD 自动切句 / 端点检测）

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ⚠️ | `chunking_strategy=auto` 时服务端先做响度归一再 VAD 切分；不返回 VAD 事件给客户端。 | https://platform.openai.com/docs/api-reference/audio/createTranscription |
| **B: Realtime** | ✅ | `server_vad` 模式 + `semantic_vad`（基于词义判定说完）。事件：`input_audio_buffer.speech_started` / `.speech_stopped`。 | https://developers.openai.com/api/docs/guides/realtime-vad |

### `asr.word_timestamps`

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ✅（仅 whisper-1） | `timestamp_granularities=["word"]` + `response_format=verbose_json`。**gpt-4o-transcribe 系列只支持 json/text，不输出 word timestamps。** | https://platform.openai.com/docs/api-reference/audio/createTranscription、https://platform.openai.com/docs/guides/speech-to-text |
| **B: Realtime** | ❓ | 官方文档未明确说明 Realtime 输入转写是否返回 word-level timestamp。 | — |

### `asr.speaker_diarization`

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ✅ | 专用模型 `gpt-4o-transcribe-diarize`；输入 > 30 秒时必须设 `chunking_strategy`。 | https://platform.openai.com/docs/api-reference/audio/createTranscription |
| **B: Realtime** | ❌ | "gpt-4o-transcribe-diarize is currently available via /v1/audio/transcriptions only and is not yet supported in the Realtime API." | https://learn.microsoft.com/en-us/answers/questions/5864686/azure-openai-realtime-api-gpt-4o-transcribe-diariz（Azure 镜像 OpenAI 行为） |

### `asr.language_set`（支持的语种集合）

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ✅ | Whisper 训练覆盖 99 语种，guide 中"Supported languages"列出 50+ 通过 WER < 50% 阈值的语种（含中、英、日、韩、德、法、西、葡、俄、阿等）。`language` 参数（ISO-639-1）可手动指定。 | https://platform.openai.com/docs/guides/speech-to-text、https://github.com/openai/whisper |
| **B: Realtime** | ✅ | 同样基于多语种音频模型；具体语种清单未在 Realtime 单独列出，参见模型页。 | https://platform.openai.com/docs/models/gpt-realtime |

### `asr.custom_vocabulary`（自定义词典 / 术语提示）

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ⚠️（通过 prompt 实现，非真正词典） | 用 `prompt` 传入正确拼写 / 术语；**whisper-1 只考虑 prompt 最后 224 token**，太长会被截。gpt-4o-transcribe 系列借 LLM context 处理，效果更稳。**没有持久化词典 / 词汇表概念。** | https://platform.openai.com/docs/guides/speech-to-text、https://platform.openai.com/docs/api-reference/audio/createTranscription |
| **B: Realtime** | ⚠️ | 通过 `session.update` 的 instructions / 转写 prompt 传 hints；同样没有持久化词典。 | https://platform.openai.com/docs/api-reference/realtime |

### `asr.punctuation`

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ✅ | Whisper 默认输出带标点；可通过 prompt 影响风格（例如要求口语化、要求保留 filler）。 | https://platform.openai.com/docs/guides/speech-to-text |
| **B: Realtime** | ✅ | 输入转写默认带标点。 | https://developers.openai.com/api/docs/guides/realtime-transcription |

### `asr.profanity_filter`（脏话过滤）

| 路径 | 支持 | 说明 | 依据 |
|---|---|---|---|
| **A: Transcriptions** | ❌ | 官方 API 没有专门的 profanity filter 开关；只能通过 `prompt` 风格指令间接引导，或事后 LLM 过滤。 | 官方文档未明确说明 |
| **B: Realtime** | ❌ | 同上。 | 官方文档未明确说明 |

---

## LLM capabilities（用 Chat Completions / Responses 实现）

> 这一节两路径合并 — LLM 能力由 `/v1/chat/completions` 或 Responses API 提供，与 ASR 路径正交。

### `llm.translate`（翻译）

✅ 通过 chat completions 让 LLM 翻译；`/v1/audio/translations` 端点也直接支持音频 → 英文。
来源：https://platform.openai.com/docs/guides/text-generation、https://platform.openai.com/docs/api-reference/audio/createTranslation

### `llm.qa`（问答 / 上下文问答）

✅ 标准 chat completions 用法。
来源：https://platform.openai.com/docs/api-reference/chat/create

### `llm.polish`（润色）

✅ 通过 prompt engineering 让模型重写 / 校对。无专用 endpoint。
来源：https://platform.openai.com/docs/guides/text-generation

### `llm.context_style`（基于上下文 / 指令风格生成）

✅ 通过 system / developer message 设置风格。注：**o1 / o1-mini 不支持 system 与 developer messages**，需把指令塞进 user message。
来源：https://platform.openai.com/docs/models/o1

### `llm.streaming`（SSE 流式）

✅ Chat Completions `stream=true` → SSE。
来源：https://developers.openai.com/api/docs/guides/streaming-responses、https://platform.openai.com/docs/api-reference/chat/streaming

---

## 受限 / 文档未明确说明项

- `asr.word_timestamps` 在 Realtime 路径下未在官方公开文档中给出明确结论 → 标 ❓
- `asr.profanity_filter` 两路径都没有专门 API → 标 ❌（需后处理）
- 单 WebSocket session 的并发上限受 rate limit / tier 控制，公开文档未给确切并发数

## 参考索引

- Speech-to-text guide: https://platform.openai.com/docs/guides/speech-to-text
- createTranscription reference: https://platform.openai.com/docs/api-reference/audio/createTranscription
- createTranslation reference: https://platform.openai.com/docs/api-reference/audio/createTranslation
- Realtime guide: https://platform.openai.com/docs/guides/realtime
- Realtime reference: https://platform.openai.com/docs/api-reference/realtime
- Realtime VAD: https://developers.openai.com/api/docs/guides/realtime-vad
- Realtime transcription: https://developers.openai.com/api/docs/guides/realtime-transcription
- Models 总表: https://platform.openai.com/docs/models
- Pricing: https://openai.com/api/pricing/、https://developers.openai.com/api/docs/pricing
- Rate limits: https://developers.openai.com/api/docs/guides/rate-limits
