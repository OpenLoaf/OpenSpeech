> 抓取日期：2026-04-28
> 来源约束：仅 cloud.google.com / ai.google.dev / docs.cloud.google.com / google.com / googleapis.com / GitHub googleapis|GoogleCloudPlatform。

# Google Cloud Provider — Research Index

OpenSpeech 多 provider 适配器系统的 Google Cloud 部分。本目录把 Google 的 ASR / Translation / LLM 三类官方能力按 OpenSpeech 视角整理，作为后续 Rust adapter 的依据。

## 抓取产物

| 文件 | 范围 |
| --- | --- |
| [README.md](./README.md) | 本索引 + 抓取失败列表。 |
| [speech-v2-streaming.md](./speech-v2-streaming.md) | **核心**。Speech-to-Text V2 streaming 识别（gRPC）。 |
| [speech-v2-recognize.md](./speech-v2-recognize.md) | V2 同步 Recognize（短音频 ≤60s）。 |
| [speech-v2-batch.md](./speech-v2-batch.md) | V2 BatchRecognize（GCS 异步）。 |
| [speech-v1-vs-v2.md](./speech-v1-vs-v2.md) | V1 → V2 迁移要点。 |
| [translation.md](./translation.md) | Cloud Translation Basic (v2) + Advanced (v3)。 |
| [gemini-api.md](./gemini-api.md) | Gemini Developer API + Vertex AI Gemini。 |
| [auth-and-billing.md](./auth-and-billing.md) | 通用 ADC / Service Account / API Key + 计费 + region。 |
| [capability-summary.md](./capability-summary.md) | **核心交付物**。OpenSpeech capability 清单逐项 ↔ Google 支持情况。 |

## 抓取失败 / 跳过的页面列表

> 严格按任务 §抗 stall 规则记录。

### 网络 / 重定向问题（系统性）

- 所有 `https://cloud.google.com/speech-to-text/...` 与 `https://cloud.google.com/translate/...` 在抓取期间 **301 重定向到 `docs.cloud.google.com/...`**，而 `docs.cloud.google.com` 子域在本环境的 WebFetch 中无法直连（"Unable to verify if domain is safe to fetch" 或 socket close）。
- `https://github.com/googleapis/googleapis/...` 同样无法 WebFetch（"Unable to verify domain"）。
- 因此**所有 cloud.google.com 与 docs.cloud.google.com 的页面正文均未直接拉取**。事实通过 Google 官方域名内的 WebSearch 摘要拼装；每条字段都引用了原始官方 URL（即便 fetch 没能打开）。

### 具体未能直接抓取的页面（仅依赖搜索摘要）

| URL | 用途 |
| --- | --- |
| https://cloud.google.com/speech-to-text/v2/docs/basics | V2 概览 |
| https://cloud.google.com/speech-to-text/v2/docs/streaming-recognize | V2 streaming |
| https://cloud.google.com/speech-to-text/v2/docs/sync-recognize | V2 sync |
| https://cloud.google.com/speech-to-text/v2/docs/batch-recognize | V2 batch |
| https://cloud.google.com/speech-to-text/v2/docs/voice-activity-events | VAD 事件 |
| https://cloud.google.com/speech-to-text/v2/docs/multiple-voices | Diarization |
| https://cloud.google.com/speech-to-text/v2/docs/adaptation-model | PhraseSet/CustomClass |
| https://cloud.google.com/speech-to-text/v2/docs/locations | Region 列表 |
| https://cloud.google.com/speech-to-text/v2/quotas | 配额 |
| https://cloud.google.com/speech-to-text/pricing | 价格 |
| https://cloud.google.com/speech-to-text/docs/migration | V1→V2 迁移 |
| https://cloud.google.com/translate/docs/intro-to-v3 | Translation v3 概览 |
| https://cloud.google.com/translate/docs/editions | Basic vs Advanced |
| https://cloud.google.com/translate/quotas | Translation 配额 |
| https://cloud.google.com/translate/pricing | Translation 价格 |
| https://cloud.google.com/translate/docs/languages | Translation 语种 |
| https://ai.google.dev/api | Gemini API reference |
| https://ai.google.dev/gemini-api/docs/models | Gemini 模型清单 |
| https://ai.google.dev/gemini-api/docs/text-generation | Gemini 流式 |
| https://ai.google.dev/gemini-api/docs/openai | Gemini OpenAI 兼容 |
| https://ai.google.dev/gemini-api/docs/pricing | Gemini 价格 |
| https://ai.google.dev/gemini-api/docs/live-guide | Live API |

### 完全跳过的内容

- `cloud_speech.proto` 原始定义文件（github.com 不可达）。文中字段名称基于 Google 公开的 V2 .NET / PHP / Python 客户端引用文档（命名与 proto 一致）。
- 完整 Speech-to-Text 支持语种 BCP-47 列表（>200 行的表格内容），仅给出**入口 URL**：https://cloud.google.com/speech-to-text/docs/speech-to-text-supported-languages
- 完整 Translation 支持语言矩阵，同上：https://cloud.google.com/translate/docs/languages

## 后续行动建议

1. 接入 Rust 时直接打开上述 URL 复核字段名 / 数值（特别是单价与 quota）。
2. 把 `capability-summary.md` 作为 OpenSpeech provider matrix 的 Google 列源数据。
3. Rust adapter 第一步：拿 `googleapis/googleapis` 的 `cloud_speech.proto` 用 `tonic-build` 生成 client；ADC 走 `gcp_auth` crate。
