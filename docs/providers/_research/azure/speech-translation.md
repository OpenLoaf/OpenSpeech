# Azure Speech — Speech Translation（重点）

> 来源：
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-translate-speech
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=speech-translation
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions
>
> 抓取日期：2026-04-28

---

## 1. 是什么

Azure 把"ASR + 翻译 + （可选）TTS"做成**单条流**返回。优势：
- 比"先 ASR → 再调 Translator REST"延迟低
- partial 阶段就给翻译预览
- 一个 SDK 调用搞定

⚠️ **仅 SDK 路径**——通过 `TranslationRecognizer`（C#/C++/Java/JS/Python/Objective-C/Swift）。Speech Translation 在所有 REST API 中都不可用：
- Short audio REST：明确"speech translation isn't supported via REST API"
- Fast transcription：能力矩阵显示 ❌（要 translation 用 LLM Speech）
- Batch：同样不支持

## 2. 核心特性

| 特性 | 说明 |
| --- | --- |
| Speech to text translation | 输入语音 → 输出目标语种文本 |
| Speech to speech translation | 同上，再用 Neural TTS 朗读 |
| Multi-lingual translation | 不指定 source language，自动识别 + 实时切换 |
| Live Interpreter | 持续 ID + 低延迟 S2S，保留说话人风格音色（personal voice） |
| 多目标语种 | 一次 API 同时输出 ≤ 2 个目标语；超过 2 个需多次调用或独立 Translator 服务 |

## 3. SDK 用法（Python 示例）

```python
import azure.cognitiveservices.speech as speechsdk

translation_config = speechsdk.translation.SpeechTranslationConfig(
    subscription=speech_key, region=service_region)
translation_config.speech_recognition_language = "en-US"
translation_config.add_target_language("de")
translation_config.add_target_language("fr")

audio_config = speechsdk.audio.AudioConfig(use_default_microphone=True)
recognizer = speechsdk.translation.TranslationRecognizer(
    translation_config=translation_config,
    audio_config=audio_config)

def on_partial(evt):
    print(f"Source partial: {evt.result.text}")
    for lang, t in evt.result.translations.items():
        print(f"  {lang}: {t}")

recognizer.recognizing.connect(on_partial)
recognizer.start_continuous_recognition()
```

事件：
- `recognizing`：partial（含 partial source + partial translations）
- `recognized`：final
- `synthesizing`：如果设了 `voice_name`，会回调 PCM 音频块（S2S）

## 4. Multi-lingual（不指定 source）

```csharp
speechTranslationConfig.AddTargetLanguage("de");
var autoDetectConfig = AutoDetectSourceLanguageConfig
    .FromLanguages(new[] { "en-US", "zh-CN" });   // 候选 ≤ 10
var recognizer = new TranslationRecognizer(
    speechTranslationConfig, autoDetectConfig, audioConfig);
```

支持：
- 单 session 内换语言（句间）
- 不需要重启 session
- 注意：**source 语种的转写文本不可用**——只输出 target 语种。原文档：*"Source language transcription isn't available yet."*

## 5. Live Interpreter

```csharp
var v2Endpoint = new Uri("wss://<REGION>.stt.speech.microsoft.com/speech/universal/v2");
var config = SpeechTranslationConfig.FromEndpoint(v2Endpoint, subscriptionKey);
config.AddTargetLanguage("fr");
config.VoiceName = "personal-voice";
var autoDetect = AutoDetectSourceLanguageConfig.FromOpenRange();   // 全开放
```

Live Interpreter 用 personal voice，需提前申请 personal voice 访问。Region 限制：仅 `eastus / japaneast / southeastasia / westeurope / westus2`。

## 6. Custom Translator 集成

```csharp
config.SetProperty(PropertyId.SpeechServiceConnection_TranslationCategory, "yourCategoryId");
```

`categoryId` 来自 Custom Translator portal 训练后部署的模型。

## 7. 支持语种

### 7.1 Source（输入）

与 [STT supported locales](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=stt) 一致（100+ locales）。

### 7.2 Target（输出文本）

与 Translator 服务的 100+ 语种集合一致。完整表：
https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=speech-translation

### 7.3 Target（输出语音 / S2S）

由 Neural TTS 提供的 voice 决定。每个目标语种至少有一个 neural voice。
完整列表：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/language-support?tabs=tts

## 8. Region 支持（Real-time Translation）

来源：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions（"Speech translation" tab）

**所有支持 Speech 的 33 个 region 都支持 Real-time Translation**。但子能力收紧：
- Video translation（≠ real-time）：仅 9 个 region
- Live Interpreter：仅 `eastus / japaneast / southeastasia / westeurope / westus2`

## 9. 计费规则（Real-time Translation）

来源：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-translation#multiple-target-languages-translation-pricing

- Speech translation 标价 **$2.50/小时**，覆盖 ≤ 2 个 target language
- 第 3 个及以后 target 语种：按 Translator 计费 **$10/百万字符**，**有 ~3x 中间流量加权系数**
  - 即 1 小时音频 / 10000 字符 / 3 个目标语 ≈ $0.30 额外
- 价格随时变；以 https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/ 为准

> ⚠️ 文档明确警示：speech translation 是 real-time，会对 partial 也做翻译，**实际计费字符数 > 输入音频对应字符数**。

## 10. 配额

Speech Translation 与 Real-time STT **共享并发配额**——例如 100 限额下，60 个 STT + 40 个 Translation 就到顶（详见 quotas-and-limits 文档）。

## 11. OpenSpeech 适配建议

- **OpenSpeech 的"边说边翻"功能**：用 Speech Translation SDK，最快、最便宜（不用走两次 API）。
- **不想绑 SDK**：折中方案 = Real-time STT (REST/WS) → Translator REST，要多至少 50ms 网络往返 + 字符计费两遍。
- **Source 转写也要展示**：multi-lingual 模式下拿不到 source 文本，得退回到"指定 source language"模式。
- **注意 partial 翻译会涨账单**——可考虑只在 final 时调 Translator，自己控制。
