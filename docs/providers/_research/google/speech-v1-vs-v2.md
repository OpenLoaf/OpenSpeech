> 来源：官方文档
> - https://cloud.google.com/speech-to-text/docs/migration
> - https://cloud.google.com/blog/products/ai-machine-learning/google-cloud-speech-to-text-v2-api
> - https://cloud.google.com/speech-to-text/v2/docs/adaptation-model
>
> 抓取日期：2026-04-28

# Speech-to-Text V1 vs V2 — 差异对照

## 1. 总体定位

- V1：原始 `google.cloud.speech.v1` / `v1p1beta1`；按请求里给定 `RecognitionConfig` 即时识别。
- V2：`google.cloud.speech.v2`；引入 **Recognizer 资源**，把 model + language + features + region 固化为持久 resource，所有 sync/streaming/batch 调用都引用一个 recognizer。
- 迁移**不会自动发生**；要主动改代码 + 改 endpoint + 创建 recognizer。

## 2. 主要差异

| 维度 | V1 | V2 |
| --- | --- | --- |
| Endpoint root | `speech.googleapis.com/v1` | `speech.googleapis.com/v2` |
| 资源模型 | 无；每次请求自带 config | **Recognizer**：`projects/{p}/locations/{l}/recognizers/{r}`；可在请求中以 `_` 占位实现 ad-hoc。 |
| 区域 | 主要 global，少数 region 端点 | 必须显式 region；支持 `global` + 多个 region。 |
| 模型 | `default` / `phone_call` / `video` / `medical_*` / `latest_long` / `latest_short` | 同 V1 模型族 + **`chirp` / `chirp_2` / `chirp_3`** 等 USM-based 多语言模型。 |
| 自动检测 encoding/sample-rate/channel | 否，必须显式 | 是，`auto_decoding_config` 即可。 |
| Batch | `LongRunningRecognize` | `BatchRecognize`，支持多文件 + GCS 输出。 |
| Adaptation | inline `SpeechContext` 或 PhraseSet/CustomClass（v1p1beta1） | 一等公民 PhraseSet / CustomClass 资源，可跨请求复用，inline 也支持。 |
| CMEK | 否 | 是，所有资源支持 customer-managed encryption keys。 |
| Logging / Telemetry | 弱 | 在 Cloud Console 有 audit log + metrics。 |
| 流时长上限 | 5 minutes | 5 minutes（一致）。 |
| 单流单消息上限 | 25 KB | **15,360 bytes** |

## 3. 迁移要点

来源：https://cloud.google.com/speech-to-text/docs/migration

1. 启用 V2 API：在 console 启用 `speech.googleapis.com`（与 V1 同一 service，但 v2 路径需要新版客户端）。
2. 客户端：升级到支持 v2 的版本（Python `google-cloud-speech>=2.20`、Java `4.x`、Node `5.x`、Go `v1.20+`、.NET `Google.Cloud.Speech.V2`）。
3. 创建 Recognizer：`projects.locations.recognizers.create`，指定 `model` + `default_recognition_config`。
4. 请求中用 `recognizer = "projects/{p}/locations/{l}/recognizers/{r}"`；亦可用 `_` 占位 + 在请求里塞完整 `config` 实现"无 recognizer"模式。
5. Streaming：把 `StreamingRecognitionConfig` 改成 v2 形态（`config` + `streaming_features`），首条 message 必须含 `recognizer` + `streaming_config`。
6. 注意 streaming 单消息从 25 KB → 15,360 bytes，需要调整客户端 chunk 切分。

## 4. 何时仍可继续用 V1

- 已有大量旧脚本只用 `default` 模型 + 短音频；改造成本 > 收益。
- 某些 region 在 V2 中没有的 model（少见）。
- 否则**新项目一律用 V2**（V1 无 chirp 系列，无 CMEK，无 batch 多文件）。

## 5. 抓取失败 / 待补

- 完整字段级 diff 见 https://cloud.google.com/speech-to-text/docs/migration ；本次抓取该页正文经 301 跳转无法直读，本节信息从迁移指南摘要 + 公开 blog 拼装。
