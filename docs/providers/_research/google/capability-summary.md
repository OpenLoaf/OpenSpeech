> 来源：聚合本目录其它文档；每条 capability 给出官方 URL。
> 抓取日期：2026-04-28

# OpenSpeech ↔ Google Cloud Capability Mapping

图例：
- **YES**：官方明确支持。
- **PARTIAL**：支持但有限制（条件、模型、region、额度）。
- **NO**：官方明确不支持，或官方文档无任何对应能力描述。
- **UNKNOWN**：未在官方文档中找到表述。

> 所有「Google」一栏的判断仅针对 OpenSpeech 计划接入的两类 Google 服务：
> - ASR：Cloud Speech-to-Text **V2**（首选 chirp_3 / chirp_2 model）
> - LLM：Gemini API（Developer API + Vertex AI）+ Cloud Translation v3

## ASR Capabilities

### `asr.streaming` — 双向流式音频→文本

- **状态**：YES
- **协议**：仅 gRPC over HTTP/2（无 REST streaming）。
- **限制**：
  - 单 stream ≤ **5 minutes**；超长需「endless streaming」客户端切片。
  - 单条 `StreamingRecognizeRequest` ≤ **15,360 bytes** audio。
  - 默认并发 300 sessions / 5 min，3000 RPM（合计）。
- **依据**：
  - https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize
  - https://cloud.google.com/speech-to-text/v2/quotas

### `asr.partial` — 中间（partial / interim）结果

- **状态**：YES
- **配置**：`StreamingRecognitionFeatures.interim_results = true`。
- **响应字段**：`StreamingRecognitionResult.is_final = false` + `stability` (0..1)。
- **依据**：https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize ; https://cloud.google.com/php/docs/reference/cloud-speech/latest/V2.StreamingRecognitionFeatures

### `asr.server_vad` — 服务端语音活动检测

- **状态**：YES
- **配置**：`StreamingRecognitionFeatures.enable_voice_activity_events = true` + 可选 `voice_activity_timeout { speech_start_timeout, speech_end_timeout }`。
- **响应**：`speech_event_type = SPEECH_ACTIVITY_BEGIN | SPEECH_ACTIVITY_END`；超时则 stream 结束。
- **依据**：https://cloud.google.com/speech-to-text/v2/docs/voice-activity-events

### `asr.word_timestamps` — 词级时间戳

- **状态**：YES
- **配置**：`RecognitionFeatures.enable_word_time_offsets = true`；可同时开 `enable_word_confidence`。
- **限制**：streaming 中仅 `is_final = true` 的 result 携带 word offsets。
- **依据**：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

### `asr.speaker_diarization` — 说话人分离

- **状态**：PARTIAL
- **配置**：`RecognitionFeatures.diarization_config = { min_speaker_count, max_speaker_count }`，1-6 之间，且 `max >= min`；固定人数时 `min == max`。
- **限制**：sync + streaming 都支持，但**不是所有模型**都支持 diarization；chirp 系列支持情况按 model 文档为准。`global` 之外的部分 region 受限。
- **依据**：https://cloud.google.com/speech-to-text/v2/docs/multiple-voices

### `asr.language_set` — 多语种支持

- **状态**：YES
- **覆盖**：`chirp_3` 支持 **85+ languages/locales**；`chirp_2` 各方法支持范围不同（BatchRecognize 最广）；`latest_long` / `latest_short` 沿用 V1 语种集。
- **配置**：`RecognitionConfig.language_codes[]` (BCP-47)；可填多语种触发自动检测（仅部分模型）。
- **依据**：
  - https://cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages
  - https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3
  - https://docs.cloud.google.com/speech-to-text/docs/models/chirp-2

### `asr.custom_vocabulary` — 自定义词表 / 偏置

- **状态**：YES
- **机制**：Model Adaptation：
  - `PhraseSet`：词组列表，每条可设 `boost` (0-20，越大越偏向)。
  - `CustomClass`：可命名的词类（"船名"、"产品代号"），在 PhraseSet 里用 `${classRef}` 引用。
  - 资源化（跨请求复用）或 inline（请求体内传完整对象）二选一。
- **依据**：https://cloud.google.com/speech-to-text/v2/docs/adaptation-model

### `asr.punctuation` — 自动标点

- **状态**：YES
- **配置**：`RecognitionFeatures.enable_automatic_punctuation = true`。可叠加 `enable_spoken_punctuation`（口述「逗号」转 `,`）。
- **依据**：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

### `asr.profanity_filter` — 脏话过滤

- **状态**：YES
- **配置**：`RecognitionFeatures.profanity_filter = true`，命中词替换为首字母 + `*`。
- **依据**：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

### `asr.endpointing` (额外，OpenSpeech 用 server VAD 的子能力) — 自动断句结束

- **状态**：YES
- **机制**：`voice_activity_timeout.speech_end_timeout` 触发后 stream 自动收尾，配合 `enable_voice_activity_events`。
- **依据**：https://cloud.google.com/speech-to-text/v2/docs/voice-activity-events

### `asr.confidence` — 置信度

- **状态**：YES
- **响应**：`SpeechRecognitionAlternative.confidence` (0..1)。
- **依据**：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

### `asr.alternatives` — N-best 备选

- **状态**：YES
- **配置**：`RecognitionFeatures.max_alternatives` (1-30)。
- **依据**：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

## LLM Capabilities

### `llm.translate` — 翻译

- **状态**：YES（**两条独立路径**）
  - **Cloud Translation v3 / v2**：专用翻译 API；同步、batch、glossary、document。
  - **Gemini**：通用 LLM 提示翻译；可控风格。
- **限制**：Cloud Translation **不支持 streaming**；Gemini 支持 SSE 流式。
- **依据**：
  - https://cloud.google.com/translate/docs/intro-to-v3
  - https://ai.google.dev/gemini-api/docs/text-generation

### `llm.qa` — 问答

- **状态**：YES（仅 Gemini，Translation API 不适用）
- **接口**：`generateContent` / `streamGenerateContent`，可附 `systemInstruction` 与多轮 `contents[]`。
- **依据**：https://ai.google.dev/api/generate-content

### `llm.polish` — 文本润色 / 改写

- **状态**：YES（Gemini）
- **机制**：通过 prompt + system instruction 实现。无专用 endpoint。
- **依据**：https://ai.google.dev/gemini-api/docs/text-generation

### `llm.context_style` — 风格 / 上下文控制

- **状态**：YES
- **机制**：
  - `systemInstruction`（顶层）。
  - `generationConfig`（temperature / topK / topP / maxOutputTokens / responseMimeType / responseSchema）。
  - 多轮 `contents[]` 中包含 user + model 角色历史。
- **依据**：https://ai.google.dev/api/generate-content

### `llm.streaming` — token-by-token 流式

- **状态**：YES
- **机制**：
  - 原生：`POST .../models/{model}:streamGenerateContent?alt=sse`，SSE event 的 `data:` 是完整 `GenerateContentResponse` JSON（含增量 `parts[].text`）。
  - OpenAI 兼容：`POST .../v1beta/openai/chat/completions` + `stream=true`，OpenAI 风格 `data:` chunk + `data: [DONE]`。
  - Live API（双向 audio/video stream）：WebSocket。
- **依据**：
  - https://ai.google.dev/gemini-api/docs/text-generation
  - https://ai.google.dev/gemini-api/docs/openai
  - https://ai.google.dev/gemini-api/docs/live-guide

## 缺失 / 弱项

| 能力 | 说明 |
| --- | --- |
| Cloud Translation 流式 | 整个 Translation API 没有 streaming/SSE；要"打字时翻译"必须走 Gemini。 |
| Speech-to-Text 单 stream > 5 min | 必须客户端拆流；官方提供 endless streaming 模板。 |
| chirp_3 + diarization 同时启用 | 官方文档未明确所有 chirp 变体都支持 diarization；接入前需在目标 region 实测。 |
| Rust first-party SDK | 不存在；需自行用 tonic + googleapis proto。 |

## 整体定位

- Google 在 OpenSpeech ASR 维度覆盖**最完整**（含 chirp_3 多语言、VAD 事件、word offsets、PhraseSet/CustomClass、diarization）。
- 唯一痛点是 **Rust SDK 缺位** + **streaming 5 min 上限** + **Cloud Translation 无 streaming**。
- LLM 维度建议直接走 **OpenAI 兼容入口**接 Gemini，可与 OpenAI provider 共用 SSE 解析层。
