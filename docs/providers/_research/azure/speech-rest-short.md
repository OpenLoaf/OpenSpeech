# Azure Speech — REST API for Short Audio

> 来源：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/rest-speech-to-text-short
> 抓取日期：2026-04-28

---

## 1. 何时使用

文档原文（必读警告）：
> Use the Speech to text REST API for short audio **only in cases where you can't use the Speech SDK or fast transcription API**.

主要限制：
- 单次请求 **音频 ≤ 60 秒**（pronunciation assessment 时 ≤ 30 秒）
- **只返回 final result，不提供 partial**
- 输入音频格式更受限（见下表）
- ❌ 不支持 Speech Translation
- ❌ 不支持 Batch Transcription
- ❌ 不支持 Custom Speech 部署 endpoint（但可以指向 base model）

## 2. Endpoint

```
https://<REGION_IDENTIFIER>.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1
```

例如 West US：
```
https://westus.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=en-US
```

> 注：`language` query 必须给，否则 4xx。

Sovereign clouds（Azure Government / 21Vianet）的 endpoint 见 https://learn.microsoft.com/en-us/azure/ai-services/speech-service/sovereign-clouds。

## 3. 鉴权

| Header | 必填 |
| --- | --- |
| `Ocp-Apim-Subscription-Key: <KEY>` | 二选一 |
| `Authorization: Bearer <ACCESS_TOKEN>` | 二选一 |

**issueToken 端点**（用 key 换 10 分钟 JWT）：
```
POST https://<REGION>.api.cognitive.microsoft.com/sts/v1.0/issueToken
Ocp-Apim-Subscription-Key: <KEY>
Content-type: application/x-www-form-urlencoded
Content-Length: 0
```

返回 body 即为 JWT。建议每 9 分钟刷新一次。

**Microsoft Entra ID** 模式：构造 `aad#<RESOURCE_ID>#<ENTRA_TOKEN>` 形式，作为 `Authorization: Bearer` 的值。

## 4. 音频格式（短音频 REST 路径）

| Format | Codec | Bit rate | Sample rate |
| --- | --- | --- | --- |
| WAV | PCM | 256 kbps | 16 kHz, mono |
| OGG | OPUS | 256 kbps | 16 kHz, mono |

`Content-Type` 必填，可选值：
- `audio/wav; codecs=audio/pcm; samplerate=16000`
- `audio/ogg; codecs=opus`

> 短音频 REST 比 SDK 路径支持的格式少很多——SDK 通过 GStreamer 还能吃 MP3/FLAC 等。

## 5. Headers

| Header | 说明 | 必填 |
| --- | --- | --- |
| `Ocp-Apim-Subscription-Key` 或 `Authorization` | 鉴权 | 必填 |
| `Content-type` | 见上节 | 必填 |
| `Pronunciation-Assessment` | Base64 JSON，见下节 | 可选 |
| `Transfer-Encoding: chunked` | 启用流式上传 | 可选 |
| `Expect: 100-continue` | 用 chunked 时必填 | 条件 |
| `Accept: application/json` | 推荐显式指定 | 可选但推荐 |

## 6. Query 参数

| 参数 | 说明 | 取值 |
| --- | --- | --- |
| `language` | 必填，BCP-47 locale | 如 `en-US`, `zh-CN` |
| `format` | 结果详细度 | `simple`（默认）/ `detailed` |
| `profanity` | 脏话处理 | `masked`（默认）/ `removed` / `raw` |

## 7. 响应

### 7.1 simple 格式

```json
{
  "RecognitionStatus": "Success",
  "DisplayText": "Remind me to buy 5 pencils.",
  "Offset": "1236645672289",
  "Duration": "1236645672289"
}
```

字段：
- `Offset` / `Duration` 单位 100 纳秒
- `DisplayText` 已含标点、大小写、ITN 和 profanity masking
- `SNR`（仅在某些情况下出现）信噪比

### 7.2 detailed 格式

返回 `NBest[]`（多候选），每条含：

| 字段 | 含义 |
| --- | --- |
| `Confidence` | 0.0 - 1.0 |
| `Lexical` | 词法形（原始词序，无 ITN） |
| `ITN` | inverse text normalization 形（"two hundred"→"200"） |
| `MaskedITN` | ITN + profanity masking |
| `Display` | 最终展示形（含标点） |

## 8. RecognitionStatus 取值

| 值 | 含义 |
| --- | --- |
| `Success` | 识别成功 |
| `NoMatch` | 检测到语音但未匹配到该 locale 的词（往往是语种不对） |
| `InitialSilenceTimeout` | 开头全静音超时 |
| `BabbleTimeout` | 开头全噪声超时 |
| `Error` | 服务内部错误 |

## 9. HTTP 状态码

| 码 | 说明 |
| --- | --- |
| 100 | Continue（chunked 用） |
| 200 | OK |
| 400 | 缺 language / 不支持的 language / 无效音频 |
| 401 | Key/token 在该 region 无效 / endpoint 错 |
| 403 | 缺 key/token |

## 10. Pronunciation Assessment（额外能力）

通过 `Pronunciation-Assessment` header（Base64 编码的 JSON）启用。参数：

| 参数 | 说明 |
| --- | --- |
| `ReferenceText` | 必填，被评估的目标文本 |
| `GradingSystem` | `FivePoint`（默认）/ `HundredMark` |
| `Granularity` | `Phoneme`（默认）/ `Word` / `FullText` |
| `Dimension` | `Basic` / `Comprehensive` |
| `EnableMiscue` | `True` / `False`（默认 False） |
| `EnableProsodyAssessment` | 启用韵律评分 |
| `ScenarioId` | 自定义评分体系的 GUID |

仅对 OpenSpeech 当前用途无关，列出供未来语言学习场景参考。

## 11. Chunked transfer 优化

文档原文：
> Chunked transfer (`Transfer-Encoding: chunked`) can help reduce recognition latency. It allows the Speech service to begin processing the audio file while it's transmitted.

但即便使用 chunked，REST short audio **仍只返回 final result**，没有 partial。如果想要 partial 必须用 SDK。

## 12. OpenSpeech 适配建议

- 短音频 REST 适合："上传录好的一句话音频做转写"——但我们桌面端是流式听写，更适合 SDK / WebSocket 路径。
- 如果要用 REST short：录完一个 utterance（≤60s），用 chunked transfer 边写边发，等 final。
- 不要把它当成 partial 流的廉价替代——延迟其实不低（必须等到尾包才返回）。
