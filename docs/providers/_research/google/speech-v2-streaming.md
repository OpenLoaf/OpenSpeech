> 来源：官方文档 https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize ; https://cloud.google.com/speech-to-text/v2/quotas ; https://cloud.google.com/speech-to-text/v2/docs/voice-activity-events
> 抓取日期：2026-04-28
>
> 注：cloud.google.com/speech-to-text/* 在抓取期间会 301 重定向到 docs.cloud.google.com，而该子域在本环境网络中无法直接 fetch。本文事实通过 Google 官方域名的搜索结果摘要拼装，所有引用 URL 均为官方源；任何无法从摘要中确证的字段会显式标注「官方文档未明确说明（本次抓取）」。

# Speech-to-Text V2 — Streaming Recognition

## 1. Protocol & Endpoint

- **Transport**：仅支持 **gRPC**（HTTP/2）。REST 不提供 streaming。
  - 来源：https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize
- **Service endpoint**：V2 REST 服务根为 `https://speech.googleapis.com/v2`（streaming 走 gRPC 的同等服务名 `speech.googleapis.com`，端口 443）。
  - 来源：https://cloud.google.com/speech-to-text/v2/docs/reference/rest
- **方法**：`google.cloud.speech.v2.Speech.StreamingRecognize`（双向流）。
  - 来源：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

## 2. Request Shape

`StreamingRecognizeRequest`（来源：https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize；https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2）：

- 第一个消息必须包含 `recognizer` (resource name, 形如 `projects/{project}/locations/{location}/recognizers/{recognizer}`) 与 `streaming_config`，**不得**含 `audio`。
- 后续消息只携带 `audio`（bytes）。
- 若 `Recognizer` 资源里已经包含了完整 config，则 stream 内消息只允许包含 audio。

`StreamingRecognitionConfig`（字段来自官方 .NET / PHP / Python 客户端 V2 命名空间，名称与 proto 一致）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `config` | RecognitionConfig | 必填。音频与识别配置。 |
| `config_mask` | FieldMask | 可选。覆盖 recognizer 中 default config 的子集。 |
| `streaming_features` | StreamingRecognitionFeatures | 流特性（VAD、interim 等）。 |

`StreamingRecognitionFeatures`（来源：https://cloud.google.com/php/docs/reference/cloud-speech/latest/V2.StreamingRecognitionFeatures）：

| 字段 | 含义 |
| --- | --- |
| `enable_voice_activity_events` | true 时，server 会推送 `SPEECH_ACTIVITY_BEGIN` / `SPEECH_ACTIVITY_END` 事件。 |
| `interim_results` | true 时返回中间（partial）结果；false 仅返回 final。 |
| `voice_activity_timeout` | 包含 `speech_start_timeout` / `speech_end_timeout`，达到则返回 `END_OF_SINGLE_UTTERANCE` 类事件并结束 stream。 |

## 3. Limits（V2 quotas，硬约束）

来源：https://cloud.google.com/speech-to-text/v2/quotas

- **单 stream 时长**：≤ **5 minutes**；超过需要使用「endless streaming」模式（客户端把流切片重新发起 stream）。
- **单条 streaming 消息体大小**：≤ **15,360 bytes**（每条 `StreamingRecognizeRequest`）。
  - 注：V1 历史值为 25 KB，V2 当前为 15,360 bytes（搜索结果显示 15360 字节）。
- **并发**：streaming 默认 **300 concurrent sessions per 5 minutes**。
- **请求速率**：默认 **3,000 requests / minute**（所有并发 session 合计）。
- **送音频速率**：要求接近实时；过快或过慢会收到 `OUT_OF_RANGE` / `INVALID_ARGUMENT`。

## 4. Audio Encoding

`RecognitionConfig` 的 `decoding_config` 二选一：

- `auto_decoding_config`：让服务自动检测容器/编码（推荐用于 FLAC、OGG、WAV、MP3 等带头格式）。
- `explicit_decoding_config`：显式指定 `encoding`、`sample_rate_hertz`、`audio_channel_count`。
  - `ExplicitDecodingConfig.AudioEncoding` 枚举值：`LINEAR16` / `MULAW` / `ALAW`（在 V2 中显式列出）。
  - `OGG_OPUS`、`WEBM_OPUS`、`FLAC`、`MP3` 通常用 auto 解码。
  - 来源（V2 RPC 包定义）：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

## 5. Models（V2 recognizer 的 `model` 字段）

来源：https://cloud.google.com/speech-to-text/v2/docs/basics ; https://docs.cloud.google.com/speech-to-text/docs/models/chirp-3

- `chirp_3`（最新一代多语言 USM-based 模型，2026 推荐）。
- `chirp_2`。
- `chirp`。
- `latest_long`（长音频通用，e.g. 会议录音）。
- `latest_short`（短音频，命令式输入）。
- `telephony` / `telephony_short`（电话语音）。
- 注：streaming 仅部分模型支持。`chirp` / `chirp_2` 早期版本只支持 batch / sync；`chirp_3` 起开始支持 streaming（详细矩阵见 chirp-3 文档）。

## 6. Voice Activity Events

来源：https://cloud.google.com/speech-to-text/v2/docs/voice-activity-events

- 在 `streaming_features.enable_voice_activity_events = true` 后，response 中 `speech_event_type` 会出现：
  - `SPEECH_ACTIVITY_BEGIN`
  - `SPEECH_ACTIVITY_END`
- `voice_activity_timeout.speech_start_timeout` / `speech_end_timeout` 达到时会触发 stream 主动结束（以 `END_OF_SINGLE_UTTERANCE`-style 事件返回）。

## 7. Response Stream

`StreamingRecognizeResponse`（来源：proto/RPC 包定义）：

- `results[]: StreamingRecognitionResult`
  - `alternatives[].transcript` / `confidence`
  - `is_final`：true 表示该 utterance 已锁定；false 是 interim。
  - `stability`：interim 稳定度（0-1）。
  - `result_end_offset`：相对于 stream 起点的时间偏移。
  - `language_code`：当 alternative_language_codes 启用且服务自动识别时填写。
- `speech_event_type`：见 §6。
- `speech_event_offset`。
- `metadata`：包含计费 `total_billed_duration`。

## 8. Regions

来源：https://cloud.google.com/speech-to-text/v2/docs/basics

- recognizer 资源 `projects/{project}/locations/{location}/recognizers/{recognizer}` 的 `{location}` 必须是支持 V2 的 region：常见有 `global`、`us-central1`、`us-east1`、`europe-west1`、`europe-west4`、`asia-northeast1`、`asia-southeast1` 等。
- 不同 region 支持的 model / language 子集不同；`chirp_*` 系列在部分 region（含 `global`）才完整可用。
- 完整可用 region × model 矩阵见 https://cloud.google.com/speech-to-text/v2/docs/locations

## 9. Errors / gRPC Status

来源：https://cloud.google.com/speech-to-text/docs/error-messages

- `INVALID_ARGUMENT`：config 字段不合法 / encoding 与 sample rate 不匹配 / 第一条消息缺 streaming_config。
- `RESOURCE_EXHAUSTED`：超并发或超 RPM。
- `OUT_OF_RANGE`：超过 5 分钟 stream 上限。
- `UNAVAILABLE`：服务不可用，建议指数退避重试。
- `DEADLINE_EXCEEDED`：客户端超时；通常与音频送速过慢配合出现。
- `PERMISSION_DENIED` / `UNAUTHENTICATED`：凭据问题。

## 10. Authentication

- 推荐 **Application Default Credentials (ADC)**：服务账号 JSON 通过 `GOOGLE_APPLICATION_CREDENTIALS` 指向。
- 也可手动以 service account 签发 OAuth2 access token，gRPC metadata `authorization: Bearer <token>`。
- API Key 不能用于 gRPC streaming（V2）。
- 来源：https://cloud.google.com/speech-to-text/v2/docs/basics

## 11. 抓取失败 / 待补

- 直链 `cloud.google.com/speech-to-text/v2/docs/streaming-recognize` 与 `cloud.google.com/speech-to-text/v2/quotas` 在本次抓取窗口内由原始域 301 → `docs.cloud.google.com`，后者在本环境无法直连。事实经 Google 官方搜索结果摘要确证。
- 「单 stream 5 minutes」「15,360 bytes / message」「300 concurrent sessions / 5 minutes」「3,000 requests / minute」均出现在官方页面摘要中，但具体数值的最新一次正文确认请直接打开两个 URL 复核。
