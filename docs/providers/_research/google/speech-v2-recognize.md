> 来源：官方文档 https://cloud.google.com/speech-to-text/v2/docs/sync-recognize ; https://cloud.google.com/speech-to-text/v2/docs/reference/rest/v2/projects.locations.recognizers/recognize ; https://cloud.google.com/speech-to-text/v2/quotas
> 抓取日期：2026-04-28

# Speech-to-Text V2 — Synchronous Recognize (短音频)

## 1. Endpoint

- **REST**：`POST https://speech.googleapis.com/v2/projects/{project}/locations/{location}/recognizers/{recognizer}:recognize`
- **gRPC**：`google.cloud.speech.v2.Speech.Recognize`
- 推荐根据 recognizer 所在 region 选择对应区域端点（例：`us-central1-speech.googleapis.com`）。完整 region 表：https://cloud.google.com/speech-to-text/v2/docs/locations
- 来源：https://cloud.google.com/speech-to-text/v2/docs/reference/rest

## 2. Limits

来源：https://cloud.google.com/speech-to-text/v2/quotas

- **单请求音频时长**：≤ **60 秒**。
- **单请求音频体积**：≤ **10 MB**（inline `content` 或 GCS `uri` 指向的文件）。
- 超过任一上限请走 `BatchRecognize`（异步）。

## 3. RecognizeRequest

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `recognizer` | string (required) | `projects/{project}/locations/{location}/recognizers/{recognizer}`。可使用占位 `_`（V2 中允许 inline 配置）。 |
| `config` | RecognitionConfig | 与 recognizer 默认 config 合并，受 `config_mask` 控制覆盖范围。 |
| `config_mask` | FieldMask | 指定 `config` 中要覆盖默认配置的字段子集。 |
| `content` | bytes (oneof audio_source) | 内联音频；JSON 上 base64。 |
| `uri` | string (oneof audio_source) | 仅支持 `gs://bucket/object`。**不能 gzip**。 |

`content` 与 `uri` 二选一；同时给或都不给会返回 `INVALID_ARGUMENT`。

## 4. RecognitionConfig 主要字段

| 字段 | 说明 |
| --- | --- |
| `auto_decoding_config` (oneof) | 自动检测带头格式（FLAC / WAV / MP3 / OGG_OPUS）。 |
| `explicit_decoding_config` (oneof) | 显式 `encoding` (`LINEAR16` / `MULAW` / `ALAW`) + `sample_rate_hertz` + `audio_channel_count`。 |
| `model` | recognizer model：`chirp_3` / `chirp_2` / `chirp` / `latest_long` / `latest_short` / `telephony` 等。 |
| `language_codes[]` | BCP-47 列表，最多 1 个主语种 + 若干 alternative。Chirp 3 支持 85+ 语种。 |
| `features` | RecognitionFeatures，见下表。 |
| `adaptation` | SpeechAdaptation：引用 `phrase_sets` / `custom_classes` 资源。 |

`RecognitionFeatures`：

| 字段 | 含义 |
| --- | --- |
| `profanity_filter` | bool，开启时脏话首字母保留 + 用 `*` 替换其余。 |
| `enable_word_time_offsets` | bool，每个 word 返回 start/end offset。 |
| `enable_word_confidence` | bool，每个 word 返回 confidence。 |
| `enable_automatic_punctuation` | bool，自动加标点（`.`, `,`, `?`）。 |
| `enable_spoken_punctuation` | bool，把口述「逗号」转成 `,` 等。 |
| `enable_spoken_emojis` | bool，识别口述 emoji。 |
| `multi_channel_mode` | enum，多声道处理。 |
| `diarization_config` | SpeakerDiarizationConfig：`min_speaker_count` / `max_speaker_count`。 |
| `max_alternatives` | int (1-30)，备选数量。 |

来源：https://docs.cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v2

## 5. RecognizeResponse

- `results[]: SpeechRecognitionResult`
  - `alternatives[].transcript` / `confidence`
  - `channel_tag`
  - `result_end_offset`
  - `language_code`
- `metadata.total_billed_duration`：用于计费校验。

## 6. 错误码

来源：https://cloud.google.com/speech-to-text/docs/error-messages

- `INVALID_ARGUMENT`：encoding/sample_rate 不一致；`content` 与 `uri` 同时设置；超过 60s/10MB；语言代码不支持。
- `NOT_FOUND`：recognizer 资源不存在或 model 不支持当前 region。
- `PERMISSION_DENIED`：service account 缺 `roles/speech.client`。
- `RESOURCE_EXHAUSTED`：超 RPM。

## 7. 抓取失败 / 待补

- 各页面正文均经 301 → docs.cloud.google.com，本环境无法直连；事实通过官方搜索摘要 + V2 proto 包定义页摘要交叉确认。
