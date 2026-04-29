# Azure — OpenSpeech Capability Summary

> 抓取日期：2026-04-28
> 这是 OpenSpeech 多 provider 适配器系统的核心交付物。把官方文档逐项映射到 OpenSpeech 的 capability key。
>
> 状态约定：
> - ✅ **支持** = 官方文档明确支持，Rust adapter 可直接实现
> - 🟡 **受限** = 有支持但有约束（路径、地区、上限），见说明
> - ❌ **不支持** = 官方文档明确不支持
> - ❓ **未明确说明** = 在官方公开文档里查不到清晰描述

---

## 1. ASR Capabilities

### `asr.streaming` — 流式音频输入

| 状态 | ✅ |
| --- | --- |
| 路径 | Speech SDK / Speech CLI（实时）；REST short-audio 也支持 chunked 上传但只返 final |
| 限制 | SDK 是 WebSocket 长连接；REST short audio 单次 ≤ 60s |
| 来源 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text |

### `asr.partial` — 中间结果 / 实时 partial

| 状态 | 🟡 |
| --- | --- |
| Real-time SDK | ✅ 默认提供（`recognizing` 事件） |
| REST short audio | ❌ 明确"only final results" |
| Fast transcription | ❌ 同步 REST，一次返回 |
| Batch transcription | ❌ 异步 |
| 来源 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short |

### `asr.server_vad` — 服务端 VAD / 自动断句

| 状态 | 🟡 |
| --- | --- |
| 说明 | SDK 内部维护 VAD：单 utterance 静音终止 或 ≤ 15 秒强制切；continuous 模式持续切片 |
| 可调参数 | 只有少数 property（如 `Speech_SegmentationSilenceTimeoutMs`）；REST 文档未列出可调 VAD 参数 |
| 限制 | 行为只在示例代码注释里描述；**官方未给出完整 VAD 调优 API 表**——按"未完全明确"处理 |
| 来源 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-translate-speech 及 SpeechConfig 参考 |

### `asr.word_timestamps` — 词级时间戳

| 状态 | ✅（全路径） |
| --- | --- |
| Real-time SDK | `OutputFormat.Detailed` + `RequestWordLevelTimestamps`，单位 100ns |
| REST short audio | `format=detailed` → NBest[]；offset/duration 单位 100ns |
| Fast transcription | 默认在 `phrases[].words[]`，单位 ms |
| Batch | `wordLevelTimestampsEnabled=true`（Whisper 模型用 `displayFormWordLevelTimestampsEnabled`） |
| 来源 | 上述 4 个文档 |

### `asr.speaker_diarization` — 说话人分离

| 状态 | 🟡 按路径区分 |
| --- | --- |
| Real-time SDK | ✅ 用 `ConversationTranscriber`（不是 `SpeechRecognizer`）；最多 35 speakers；单 session ≤ 240 min；REST **不支持** |
| Fast transcription | ✅ `diarization.enabled=true`，`maxSpeakers` 2-35；启用后单文件 ≤ 2h；mono 通道 |
| Batch | ✅ `diarizationEnabled=true`（≤2 speakers）或 `diarization.speakers.maxCount`（最多 35）；启用后单文件 ≤ 240 min |
| REST short audio | ❌ |
| 来源 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization 等 |

### `asr.language_set` — 多语种支持

| 状态 | ✅ |
| --- | --- |
| 数量 | Real-time / Batch ≥ **100 BCP-47 locales**；Fast transcription default 13 locales + multi-lingual model；LLM speech 支持 9 语言族 |
| 完整列表 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt |
| 自动识别 | 见 `asr.language_set` + Language Identification 子能力（at-start ≤ 4 候选；continuous ≤ 10 候选） |

### `asr.custom_vocabulary` — 自定义词表 / phrase list

| 状态 | 🟡 按路径区分 |
| --- | --- |
| Real-time SDK | ✅ `PhraseListGrammar`，≤ **500 phrases**，weight 0.0-2.0 |
| Fast transcription | ✅ `phraseList.phrases`, `biasing_weight` 1.0-20.0 |
| Batch | ❌ **完全不支持**（强约束） |
| REST short audio | ❌ |
| 复杂场景 | > 500 phrases 应改用 Custom Speech 训练 |
| 来源 | https://learn.microsoft.com/en-us/azure/ai-services/speech-service/improve-accuracy-phrase-list |

### `asr.punctuation` — 自动标点

| 状态 | ✅ |
| --- | --- |
| 默认行为 | 全部 STT 路径默认开启（含标点+大小写+ITN） |
| Real-time SDK | 可通过 property 关闭 |
| Batch | `punctuationMode = None / Dictated / Automatic / DictatedAndAutomatic` |
| Whisper | 不适用此参数 |

### `asr.profanity_filter` — 脏话过滤

| 状态 | ✅ 三档 |
| --- | --- |
| REST short audio | query `profanity=masked / removed / raw`，默认 `masked` |
| Fast / Batch | `profanityFilterMode = None / Masked / Removed / Tags`（多一档 Tags），默认 `Masked` |
| SDK | `SpeechConfig.SetProfanity(ProfanityOption)` |
| 边角 | 整段都是脏话 + `removed` → 服务返回空结果 |

---

## 2. LLM Capabilities

OpenSpeech 期望的 LLM capability 在 Azure 上由两个产品组合：
- `Translator` 服务（机翻；text）
- `Azure OpenAI`（LLM 通用；含翻译/润色/QA）

### `llm.translate` — 翻译

| 状态 | ✅ 多路径 |
| --- | --- |
| Translator REST v3 `/translate` | 50,000 字符/请求；同时多目标语种；100+ 语对 |
| Speech Translation SDK | ASR + 翻译同流，要走 Speech SDK；详见 `speech-translation.md` |
| Azure OpenAI Chat | 通用 LLM 翻译，质量更好但贵 |
| 选择 | 桌面端实时听写翻译用 Speech Translation SDK；事后翻译用 Translator REST |

### `llm.qa` — 问 AI / 问答

| 状态 | ✅ |
| --- | --- |
| 路径 | Azure OpenAI Chat Completions |
| 文档 | https://learn.microsoft.com/en-us/azure/ai-services/openai/reference |

### `llm.polish` — 润色 / 改写

| 状态 | ✅ |
| --- | --- |
| 路径 | Azure OpenAI Chat Completions（自定义 system prompt） |
| 备注 | Azure 没有专门的"polish API"，靠 prompt engineering 在 LLM 上实现 |

### `llm.context_style` — 上下文风格控制

| 状态 | ✅ |
| --- | --- |
| 路径 | Azure OpenAI：通过 `system` message + few-shot user/assistant；`response_format` 控结构 |
| Speech 路径 | LLM Speech (preview) 支持 prompt 控转写风格，但 GA 版 Fast transcription 不支持 |

### `llm.streaming` — LLM 流式输出

| 状态 | ✅（OpenAI）/ ❓（Translator） |
| --- | --- |
| Azure OpenAI | `"stream": true` → SSE，`data: {...}` chunks，`data: [DONE]` 收尾，与 OpenAI.com 完全兼容 |
| Translator REST | ❓ 公开文档**未明确说明**支持 streaming 翻译响应；按"批量返回"使用 |
| Translator preview LLM 模式 | ❓ 文档没说协议形式，按"未明确说明" |

---

## 3. 协议 / 鉴权 / 部署

### `protocol.streaming` — 客户端流式上传协议

| 状态 | ✅ |
| --- | --- |
| Real-time STT | WebSocket（SDK 抽象）；docs 不把 raw WS 帧格式作为稳定契约 |
| REST short audio | HTTP chunked transfer 可减少延迟，但仍只返 final |
| Fast / Batch | HTTP multipart / JSON，全部一次性上传 |

### `auth.api_key`

| 状态 | ✅ |
| --- | --- |
| Header | `Ocp-Apim-Subscription-Key` (Speech/Translator) / `api-key` (OpenAI) |

### `auth.token`

| 状态 | ✅ |
| --- | --- |
| 路径 | issueToken 端点换 10 分钟 JWT |

### `auth.entra_id` (OAuth)

| 状态 | ✅ |
| --- | --- |
| 要求 | Speech 必须开 custom subdomain（一次性）；分配 RBAC 角色 |
| Scope | `https://cognitiveservices.azure.com/.default` |
| 限制 | `ConversationTranslator` 不支持；Python `VoiceProfileClient` 不可用 |

---

## 4. 输入 / 输出格式

### Audio 输入

| 路径 | 支持的格式 |
| --- | --- |
| REST short audio | WAV/PCM 16k mono；OGG/Opus 16k mono |
| Real-time SDK (PCM) | WAV PCM 16k 或 8k mono |
| Real-time SDK (压缩) | MP3 / OPUS-OGG / FLAC / ALAW / MULAW / MP4-ANY，需 GStreamer |
| Real-time SDK (JS / Objective-C / Swift) | **仅 PCM**，不支持压缩 |
| Fast transcription | 11 种：WAV / MP3 / OPUS-OGG / FLAC / WMA / AAC / ALAW-WAV / MULAW-WAV / AMR / WebM / SPEEX |
| Batch | Fast 同集合（具体格式表见 batch docs） |

### 输出形

- **Lexical**：原始词法（无标点） — 只在 short audio detailed / batch 提供
- **ITN**：inverse text normalization（"two hundred" → "200"）
- **Display**：标点 + 大小写 + ITN（最常用）
- Fast transcription **仅返回 Display 形**

---

## 5. 关键限制速查（容易误判）

| 误判点 | 真实情况 |
| --- | --- |
| "Batch 应该最强大" | Batch **不支持 phrase list**，且 LID + 自定义模型组合会**静默降级** |
| "Speech Translation 走 REST" | **错**，仅 SDK；REST 都不支持 translation |
| "Whisper 全 region 可用" | 仅 7 个 region，且仅 batch 路径 |
| "Diarization 全路径一致" | 实时用 `ConversationTranscriber`；REST short 不支持；Fast/Batch 启用后有时长降级 |
| "Phrase list 100k" | 上限 **500**；超过应改 Custom Speech |
| "Real-time STT region = 33 个就 OK" | Fast transcription 只有 22 个 region，LLM speech 只有 5 个 |
| "Custom Speech + LID 可以组合" | Batch 模式下 LID + custom 会降级到 base |
| "Speech key 跨 region 用" | ❌ key 只在创建 region 有效 |
| "Custom subdomain 可改" | ❌ 一次性，不可逆 |

---

## 6. 官方文档"语焉不详"的项

按上面任务说明，列出查不到清晰答案的能力项：

1. **服务端 VAD 阈值的可调 API**：只在示例注释里看到"silence terminates utterance" 和 "≤15s 强制切"，没有完整的可调参数表。需要在实施时翻 SpeechConfig API 参考找 property name。
2. **Real-time WebSocket 帧协议契约**：Microsoft 不把 raw WebSocket 协议作为公开契约文档。逆向实现风险高。
3. **Translator 文本翻译的 SSE / streaming 响应**：v3.0 GA 文档完全没提；preview 文档也没明确给协议。
4. **LLM Speech 与 Fast Transcription 的精确性能对比**：文档只说"shares ultra-fast inference performance"，没有 latency benchmark。
5. **Speech Translation 的 partial latency 数字**：文档说"interim results returned as speech is detected"，但没给典型 ms 值。
6. **Azure OpenAI 各 deployment type 在 Speech 资源耦合时的配额行为**：跨产品 quota 关系未文档化。
7. **Batch transcription 单 region 的 sequential 处理具体并发数**：文档只说 sequential，未说同 region 同 resource 的并行 worker 数。

---

## 7. OpenSpeech Adapter 实施清单

为 `azure` provider 实现时建议覆盖：

- [ ] Real-time STT：用 official Speech SDK 或自实现 WebSocket + STT v2 endpoint（推荐前者）
- [ ] Phrase list：500 phrases 上限；用户超额自动截断 + UI 警告
- [ ] LID：at-start ≤ 4，continuous ≤ 10；同 base language 不能给两个变体
- [ ] Diarization：用 `ConversationTranscriber`；240 min session 上限到点重连
- [ ] Profanity filter：暴露三档（masked / removed / raw）
- [ ] Translation：默认走 Speech Translation SDK，partial 也翻译；UI 提示"会被多算字符"
- [ ] LLM：走 Chat Completions，必须配 deployment name + api-version
- [ ] 鉴权：默认 key；UI 暴露 Entra ID 高级选项（要 custom domain）
- [ ] Region：用户在配置时选 region，根据 region 自动屏蔽不支持的能力（Fast / LLM speech / Whisper / Live Interpreter）
- [ ] 计费监控：跟踪 STT 时长、TTS 字符、Translator 字符、OpenAI tokens 四档
- [ ] 错误处理：429 backoff（1-2-4-4 min 模式）；区分 `ResponsibleAIPolicyViolation` 与网络错
