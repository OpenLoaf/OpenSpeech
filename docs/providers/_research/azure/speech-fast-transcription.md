# Azure Speech — Fast Transcription

> 来源：
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/fast-transcription-create
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-to-text
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
>
> 抓取日期：2026-04-28

---

## 1. 定位

Fast Transcription 是 **同步 REST**：上传文件 → 一次 HTTP POST → 直接拿 JSON 结果，比 real-time 还快（"faster than real-time audio"），延迟可预测。介于 real-time 和 batch 之间的"小批量同步"路径。

适合：
- 视频/音频文件快速生成字幕
- 会议笔记
- 语音邮件
- 用户上传后期望"几秒到几十秒"内出结果

GA 状态。当前 API 版本：**`2025-10-15`**。

## 2. Endpoint

```
POST https://<REGION>.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15
```

支持 region 见 [`auth-and-billing.md`](./auth-and-billing.md)（Fast Transcription 支持的 region 比 Real-time STT 少，约 22 个 region）。

## 3. 鉴权

| 方式 | header |
| --- | --- |
| Key | `Ocp-Apim-Subscription-Key: <KEY>` |
| Microsoft Entra ID（推荐） | `Authorization: Bearer <ENTRA_TOKEN>` |

## 4. 音频限制

| 项 | 限制 |
| --- | --- |
| 单文件大小 | < **500 MB** |
| 单文件时长 | < **5 小时**（启用 diarization 时 < **2 小时**） |
| 每分钟请求数 | 600（默认；可申请提升） |

## 5. 支持的音频格式

> 这是 4 条 STT 路径中**容器/编码最宽松**的：

- WAV
- MP3
- OPUS / OGG
- FLAC
- WMA
- AAC
- ALAW in WAV container
- MULAW in WAV container
- AMR
- WebM
- SPEEX

## 6. 请求格式

`multipart/form-data` 上传：

```
--form 'audio=@"YourAudioFile.wav"'
--form 'definition="<JSON_OPTIONS>"'
```

或者通过 URL：
```
--form 'definition="{\"audioUrl\": \"https://crbn.us/hello.wav\"}"'
```

### 6.1 `definition` JSON

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `locales` | string[] | 期望语种 BCP-47；为空则启用多语种自动识别 |
| `channels` | int[] | 0-based；最多 2 通道；不可与 stereo diarization 组合 |
| `diarization.enabled` | bool | 启用说话人分离 |
| `diarization.maxSpeakers` | int | 2-35 |
| `phraseList.phrases` | string[] | 短语列表 |
| `phraseList.biasing_weight` | float | 1.0-20.0 |
| `profanityFilterMode` | string | `None / Masked / Removed / Tags`，默认 Masked |

### 6.2 完整 cURL

```bash
curl --location 'https://<REGION>.api.cognitive.microsoft.com/speechtotext/transcriptions:transcribe?api-version=2025-10-15' \
--header 'Content-Type: multipart/form-data' \
--header 'Ocp-Apim-Subscription-Key: <KEY>' \
--form 'audio=@"YourAudioFile.wav"' \
--form 'definition={
    "locales": ["en-US"],
    "diarization": { "enabled": true, "maxSpeakers": 2 },
    "phraseList": { "phrases": ["Contoso", "Jessie", "Rehaan"] },
    "profanityFilterMode": "Masked"
}'
```

## 7. 响应

```json
{
  "durationMilliseconds": 182439,
  "combinedPhrases": [
    { "channel": 0, "text": "Full transcription text..." }
  ],
  "phrases": [
    {
      "channel": 0,
      "speaker": 0,
      "offsetMilliseconds": 960,
      "durationMilliseconds": 640,
      "text": "Good afternoon.",
      "words": [
        { "text": "Good", "offsetMilliseconds": 960, "durationMilliseconds": 240 }
      ],
      "locale": "en-US",
      "confidence": 0.93554276
    }
  ]
}
```

字段：
- `combinedPhrases[]`：每 channel 完整文本
- `phrases[]`：分句细节（含时间、speaker、word-level timestamps、locale、confidence）
- 时间单位 **毫秒**（注意：跟 short audio REST 的"100ns"不同）

## 8. 能力支持矩阵

| 能力 | 支持 |
| --- | --- |
| 转写 | ✅ |
| 说话人分离 | ✅（启用后单文件 ≤ 2h，仅 mono） |
| 多通道 stereo | ✅（最多 2 channel；与 diarization 互斥） |
| Profanity filter | ✅ |
| 指定 locale | ✅ |
| 多语种自动识别（不指定 locales） | ✅ |
| Phrase list | ✅ |
| **Translation** | ❌（用 LLM Speech 或 Speech SDK） |
| Custom prompting | ❌（要 prompting 用 LLM Speech） |
| Word-level timestamps | ✅（默认就在 phrases[].words） |
| 输出 lexical 形 | ❌（**only display form**——含标点大小写，无原始词法） |

## 9. 支持的 Locale

**Default Model**：`de-DE, en-GB, en-IN, en-US, es-ES, es-MX, fr-FR, hi-IN, it-IT, ja-JP, ko-KR, pt-BR, zh-CN`

**Multi-lingual Model**：上述子集；省略 `locales` 即启用 auto-detect

完整最新列表通过 API：`Transcriptions - List Supported Locales`（v2024-11-15+）：
https://learn.microsoft.com/en-us/rest/api/speechtotext/transcriptions/list-supported-locales

## 10. 与 LLM Speech 对比

LLM Speech（preview）共享 Fast Transcription 的同一引擎，但：
- ✅ 支持 translation
- ✅ 支持 custom prompting
- ❌ 不能精确指定 locale（用 prompt 控制）
- ❌ 不能用 phrase list（用 prompt 控制）

如果需要"按 prompt 指导转写风格"或"边转边翻"，用 LLM Speech；如果要确定性 locale + phrase list 控制，用 Fast Transcription。

## 11. OpenSpeech 适配建议

- **本地短音频转写**（< 5h）：Fast Transcription 是唯一同步 REST 路径，最方便集成。
- **支持的 codec 多**，不用强制 PCM——OPUS/OGG 直传可显著省带宽。
- 如果要 partial / streaming，**用不了**——它是同步一次性返回。
- 想要"用户词典"：phraseList 是 quick win，但相比 SDK 有 biasing_weight 1.0-20.0 比 SDK 的 0.0-2.0 范围大，调高更激进。
