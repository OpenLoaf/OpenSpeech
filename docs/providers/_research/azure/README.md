# Azure AI Speech / Translator / OpenAI 调研索引

> 抓取日期：2026-04-28
> 数据源约束：仅 `learn.microsoft.com` / `azure.microsoft.com` / `microsoft.com` 官方域名
> 用途：OpenSpeech 多 provider 适配器 Rust 后端的实现依据

---

## 文档清单

| 文件 | 主题 | 主要官方源 |
| --- | --- | --- |
| [`speech-realtime.md`](./speech-realtime.md) | 实时 STT（Speech SDK / WebSocket） | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text |
| [`speech-rest-short.md`](./speech-rest-short.md) | 短音频 REST（≤60s） | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short |
| [`speech-batch.md`](./speech-batch.md) | 批量异步转写（≤1GB / 文件） | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription |
| [`speech-fast-transcription.md`](./speech-fast-transcription.md) | 同步快速转写（≤500MB / ≤5h） | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create |
| [`speech-translation.md`](./speech-translation.md) | Speech Translation（ASR + 翻译同流） | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation |
| [`translator.md`](./translator.md) | 独立 Azure Translator（文本/文档翻译） | https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/overview |
| [`azure-openai.md`](./azure-openai.md) | Azure OpenAI（LLM 调用集成） | https://learn.microsoft.com/en-us/azure/ai-services/openai/reference |
| [`auth-and-billing.md`](./auth-and-billing.md) | 鉴权 + 区域 + 计费 + 配额 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions |
| [`capability-summary.md`](./capability-summary.md) | **核心交付物**：按 OpenSpeech capability 模型逐项核对 | 多源汇总 |

## 关键发现速览

1. **品牌名变化**：Azure Cognitive Services → Azure AI Services → Microsoft Foundry。同一资源在 2026 年 docs 里被叫做 "Foundry resource for Speech"，但 region/endpoint host 名 `*.stt.speech.microsoft.com` 与 `*.api.cognitive.microsoft.com` 仍然有效。
2. **Speech 有 4 条 STT 路径**：Real-time SDK / Real-time REST short audio / Fast transcription（同步 REST）/ Batch transcription（异步 REST）。功能矩阵差异很大，**短音频 REST 不支持 partial result、不支持 translation**。
3. **Speech Translation 仅 SDK**：通过 WebSocket 协议提供。短音频 REST 和 Fast/Batch 都不支持 ASR + 同流翻译；要做翻译必须用 Speech SDK 的 `TranslationRecognizer`。
4. **Diarization**：实时 SDK 用 `ConversationTranscriber`（最多 35 speakers，单 session ≤ 240 min）；Fast transcription 支持但启用 diarization 后单文件 ≤ 2h；Batch 支持但启用 diarization 后单文件 ≤ 240 min。
5. **Phrase list 有硬上限**：≤ 500 phrases，仅 real-time + fast transcription 支持，**Batch 不支持 phrase list**。
6. **Word-level timestamps**：real-time 通过 `format=detailed`；Batch 通过 `wordLevelTimestampsEnabled=true`；Fast transcription 默认就在 phrases[].words 里返回。
7. **鉴权三套**：`Ocp-Apim-Subscription-Key`（key-based）/ `Authorization: Bearer <token>`（10 分钟 issueToken）/ Microsoft Entra ID（OAuth；scope `https://cognitiveservices.azure.com/.default`，要求 custom domain + Cognitive Services Speech User 角色）。
8. **Azure OpenAI 与开源 OpenAI API 差异**：endpoint 必须用 deployment 名，必须带 `?api-version=YYYY-MM-DD`，body 里没有 model 字段；header 是 `api-key:` 而不是 `Authorization: Bearer`（除非走 Entra）。SSE 流式同 OpenAI 兼容。
9. **官方文档语焉不详项**（在 capability-summary 中标注）：
   - LLM speech / Speech Translation 的精确 partial latency 数字
   - Translator 文本翻译是否有真正的 streaming（公开文档未提供）
   - Speech 服务端 VAD 的明确开关参数（只在 SDK 行为里描述，未在 REST 文档列出）
