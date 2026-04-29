# Azure Speech — Real-time Speech to Text

> 来源：
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-sdk
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/get-started-stt-diarization
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/improve-accuracy-phrase-list
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-identification
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-use-codec-compressed-audio-input-streams
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
>
> 抓取日期：2026-04-28

---

## 1. 概览

Real-time STT 是 Azure 推荐的"流式听写"路径。提供 **partial result（intermediate）** 和 **final result**，最低延迟基本随说话停顿即返回。可通过：

- **Speech SDK**（推荐；C#/C++/Java/JS/Python/Objective-C/Swift/Go）
- **Speech CLI**（`spx recognize`）
- **Speech to text REST API for short audio**（≤ 60s，无 partial，仅 final）

> Real-time 走的是底层 WebSocket，但 Microsoft 官方建议通过 SDK 调用而非自己实现 WebSocket 协议。docs 没有公开发布 WebSocket 帧格式作为支持契约。

## 2. Endpoint

每个 region 有独立 host。SDK 用 region 标识符（如 `eastus`），自己发 raw WebSocket 时 host 是：

```
wss://<REGION>.stt.speech.microsoft.com/speech/universal/v2     # 推荐 v2 endpoint
wss://<REGION>.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
```

完整 region 列表见 [`auth-and-billing.md`](./auth-and-billing.md)。

## 3. 鉴权

支持三种：

| 方式 | header / 配置 | 备注 |
| --- | --- | --- |
| Subscription key | `Ocp-Apim-Subscription-Key: <KEY>` | 最简单；SDK 可直接传 |
| Bearer Token (issueToken) | `Authorization: Bearer <JWT>`，10 分钟过期 | 通过 `https://<REGION>.api.cognitive.microsoft.com/sts/v1.0/issueToken` 用 key 换取 |
| Microsoft Entra ID | OAuth scope `https://cognitiveservices.azure.com/.default`；构造 `aad#<resourceId>#<token>` 形式的 authorization token | 必须先开 custom domain；分配 *Cognitive Services Speech User* 角色 |

## 4. 音频格式

### 4.1 SDK / 原生 PCM

默认：**WAV 容器，16kHz / 16-bit / mono PCM**。也支持 8kHz。

### 4.2 SDK 通过 GStreamer 解码的压缩格式

| 容器/编码 | 备注 |
| --- | --- |
| MP3 | |
| OPUS in OGG | |
| FLAC | |
| ALAW in WAV container | |
| MULAW in WAV container | |
| ANY (MP4 容器或未知) | 用 `AudioStreamContainerFormat.ANY` |

**重要约束**：GStreamer 不被链接到 Speech SDK 二进制里，需自行安装运行时库（Linux 通过 apt 装 `gstreamer1.0-plugins-{base,good,bad,ugly}`；Windows 装 MSI 并配 PATH；Android 需要预编译 `libgstreamer_android.so`）。

**JavaScript / Objective-C / Swift SDK 不支持压缩输入**——必须先解码成 PCM。

## 5. 高级能力

### 5.1 Partial / intermediate result

✅ Real-time SDK 默认提供。事件名：`recognizing`（partial）/ `recognized`（final）。
❌ 短音频 REST 不提供 partial。

### 5.2 服务端 VAD / 自动切句

SDK 内置：单次 utterance "is determined by listening for silence at the end or until a maximum of 15 seconds of audio is processed"（见 LID 文档示例注释）。Continuous recognition 会持续切片。**官方文档未给出可调的 VAD threshold 参数**——只有 `Speech_SegmentationSilenceTimeoutMs` 等少数 property 可调（见 SpeechConfig API 参考）。

### 5.3 词级时间戳 (word-level timestamps)

通过 `format=detailed` 在 NBest[].Display 之外得到 token 级。SDK 可设 `OutputFormat.Detailed` 并打开 `RequestWordLevelTimestamps`。返回字段含 `Offset` 和 `Duration`（单位：100-纳秒，即 1 = 100ns）。

### 5.4 Diarization（说话人分离）

实时 diarization 用专门的类 `ConversationTranscriber`（**不是** `SpeechRecognizer`）。

- 最多 35 speakers（超过会报错）
- 单 session ≤ 240 分钟
- speaker id 形如 `Guest-1`, `Guest-2`, `Unknown`
- 通过 property `SpeechServiceResponse_DiarizeIntermediateResults=true` 在 partial 阶段也输出 speakerId
- ❌ REST 不支持实时 diarization；只能用 SDK

### 5.5 Phrase List

```csharp
var phraseList = PhraseListGrammar.FromRecognizer(recognizer);
phraseList.AddPhrase("Contoso");
phraseList.SetWeight(weight);  // 0.0-2.0, default 1.0
```

- 上限：**≤ 500 phrases**（超过应改用 Custom Speech）
- weight：`0.0` = 关闭，`1.0` = 默认，`2.0` = 最高
- 支持的字符：locale-specific 字母/数字、空白，特殊字符 `+ - $ : ( ) { } _ . ? @ \ ' & # % ^ * \` < > ; /`
- 支持模式：real-time + fast transcription；**batch transcription 不支持**
- 适用于 standard model 和 custom speech model

### 5.6 自动标点 (auto punctuation)

REST short audio 默认在 `DisplayText` 中已包含标点、大小写、ITN（inverse text normalization：把"two hundred"→"200"，"doctor smith"→"Dr. Smith"）。
Batch 通过 `punctuationMode` 控制：`None | Dictated | Automatic | DictatedAndAutomatic`（默认 `DictatedAndAutomatic`）。
SDK 可通过对应 property 关闭。

### 5.7 Profanity filter

REST short audio：query param `profanity=masked|removed|raw`，默认 `masked`。
Batch / Fast：`profanityFilterMode = None | Masked | Removed | Tags`，默认 `Masked`。
SDK：`SpeechConfig.SetProfanity(ProfanityOption)`。

注意：如果整段音频只有脏话且 `profanity=remove`，服务返回空结果。

### 5.8 Language Identification (LID)

通过 `AutoDetectSourceLanguageConfig` 配置 candidate locales。

| 模式 | 候选数上限 | 行为 |
| --- | --- | --- |
| At-start LID | ≤ 4 候选 locale | 前几秒确定后锁定；< 5s 内返回 |
| Continuous LID | ≤ 10 候选 locale | 句间切换；不支持句内（同一 utterance 内）切换 |

- 必须给完整 locale（带 `-`），且**同一 base language 不能给多个变体**（不能同时 `en-US` 和 `en-GB`）
- Continuous LID 需要 `SpeechServiceConnection_LanguageIdMode=Continuous`，默认 `AtStart`
- 即便音频里说的不在候选里，服务**仍会返回某个候选**（不会 fallback 到"未知"）
- Continuous LID 支持的 SDK：C# / C++ / Java / JS / Python（不含 Objective-C/Swift）
- Continuous LID 必须用 `SpeechConfig.FromEndpoint`（v2 endpoint）
- 完整支持 LID 的 locale 列表：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=language-identification

### 5.9 Speech Translation

详见 [`speech-translation.md`](./speech-translation.md)。在 real-time 路径下与 ASR 同流返回。

### 5.10 自定义模型 (Custom Speech)

设置 `SpeechConfig.EndpointId = "<custom-endpoint-id>"`。由 Custom Speech portal 训练后部署得到的 ID。详见 https://learn.microsoft.com/en-us/azure/ai-services/speech-service/custom-speech-overview。

## 6. 语种 / Locale

- 实时 STT 支持 **100+ locales**（覆盖欧亚美非中东全部主要语言 + 多区域变体，如 20+ Arabic、15+ Spanish、10+ English）
- 完整列表（必须信任）：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt

## 7. 限制 / Quotas

来源：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits

| 项 | F0 | S0 |
| --- | --- | --- |
| 实时 STT + Speech Translation 并发请求（合并计算） | 1（不可调） | 100 默认（可申请提升） |
| 自定义 endpoint 并发请求 | 1 | 100 默认（可申请提升） |
| 实时 diarization 单 session 时长 | n/a | 240 分钟 |
| Custom 模型部署数 | 1 | 50 |

如果命中 429 应做指数 backoff（官方推荐 1-2-4-4 分钟模式）。

## 8. 错误处理

REST short audio HTTP 状态码：100/200/400/401/403。
SDK 走 `CancellationDetails.Reason` + `ErrorCode`（如 `AuthenticationFailure`, `ConnectionFailure`, `ServiceTimeout`, `ServiceUnavailable`）。
RecognitionStatus 字段（REST + SDK 共用）：`Success | NoMatch | InitialSilenceTimeout | BabbleTimeout | Error`。

## 9. OpenSpeech 适配建议

- **应用内置麦克风听写**：用 Speech SDK，PCM 16k mono 直接喂；事件 `recognizing` → partial UI；`recognized` → final 落 history。
- **不想绑 SDK**：可以自己实现 WebSocket 协议但不推荐；docs 不把 WebSocket 帧格式当成稳定契约。
- **想做"问 AI"**：Real-time STT 拿到 final → 转交 Azure OpenAI（见 `azure-openai.md`）。
- **想做"翻译输出"**：Real-time STT + Translator REST（中等延迟）；或直接 Speech Translation SDK（更低延迟，单流）。
