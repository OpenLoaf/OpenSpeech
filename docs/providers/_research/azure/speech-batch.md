# Azure Speech — Batch Transcription

> 来源：
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription-create
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription-get
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
>
> 抓取日期：2026-04-28

---

## 1. 什么时候用

- 大量预录音频（call center、媒体归档、教育课件）
- 不需要实时返回，能接受**几分钟到 24 小时**完成
- 单文件大、并发提交多

> 文档 tip：如果文件 < 2 小时且 < 300 MB 而且需要"快"，应改用 [Fast Transcription API](./speech-fast-transcription.md)。

## 2. API 版本

当前 GA 版本是 **`2024-11-15`**（REST query param `api-version`）。
旧的 `v3.0/v3.1/v3.2/3.2-preview.*` 在 **2026-03-31 退役**。
Speech CLI 暂不支持 `2024-11-15`，仍需使用 `v3.2`。

## 3. 工作流

1. 把音频上传到 Azure Blob，或拿到 SAS / 公共 URL
2. **Submit** 创建 transcription：`POST /speechtotext/transcriptions:submit`
3. **Poll** 状态：`GET /speechtotext/transcriptions/{id}`
4. 拉取结果文件：`GET .../files`

支持 webhook 通知（事件：`transcription.created/processing/succeeded/failed/deleted`），免去轮询。

## 4. Endpoint

```
POST https://<REGION>.api.cognitive.microsoft.com/speechtotext/transcriptions:submit?api-version=2024-11-15
```

## 5. 鉴权

`Ocp-Apim-Subscription-Key`（同 short audio）；或 Microsoft Entra（要求 custom domain）。

## 6. Submit 请求 body

### 6.1 完整示例

```json
{
  "contentUrls": [
    "https://crbn.us/hello.wav",
    "https://crbn.us/whatstheweatherlike.wav"
  ],
  "locale": "en-US",
  "displayName": "My Transcription",
  "model": null,
  "properties": {
    "wordLevelTimestampsEnabled": true,
    "languageIdentification": {
      "candidateLocales": ["en-US", "de-DE", "es-ES"],
      "mode": "Continuous"
    },
    "timeToLiveHours": 48
  }
}
```

### 6.2 字段位置（**官方反复强调容易踩坑**）

请求 body 严格分两层：
- **root**：`displayName`, `locale`, `model`, `contentUrls`, `contentContainerUrl`
- **`properties` 内**：所有控制行为的选项

❗ `destinationContainerUrl` 必须放 `properties` 内。放 root 会被静默忽略，结果写到 Microsoft 托管容器。

### 6.3 字段表（按层级）

| 字段 | 位置 | 说明 |
| --- | --- | --- |
| `contentUrls` | root | 单个或多个音频 URL（公共 URL 或 SAS） |
| `contentContainerUrl` | root | 整个容器 SAS URL；二选一 |
| `displayName` | root | 必填；可重复，非唯一标识 |
| `locale` | root | 必填，BCP-47；**创建后不能改** |
| `model` | root | 不传 = 默认 base model；可指 base 或 custom 的 self URI |
| `channels` | properties | 默认 `[0,1]` 都转写 |
| `destinationContainerUrl` | properties | 写入指定 container（须 ad-hoc SAS，不支持 access policy SAS） |
| `diarization` | properties | 三人以上 speakers 才用；含 `speakers.minCount/maxCount`，max < 36 |
| `diarizationEnabled` | properties | 默认 `false`；两人对话置 `true` 即可 |
| `wordLevelTimestampsEnabled` | properties | 默认 `false`；Whisper 模型不支持 |
| `displayFormWordLevelTimestampsEnabled` | properties | Whisper 必须用这个 |
| `languageIdentification.candidateLocales` | properties | 2-10 个候选；包含主 locale |
| `profanityFilterMode` | properties | `None / Masked / Removed / Tags`，默认 `Masked` |
| `punctuationMode` | properties | `None / Dictated / Automatic / DictatedAndAutomatic`，默认后者；Whisper 不适用 |
| `timeToLiveHours` | properties | 必填；6 小时 - 31 天；推荐 48 |

### 6.4 关键约束

- 启用 `diarizationEnabled` 或 `diarization` → 单文件音频 ≤ **240 分钟**
- LID + 自定义模型组合 → 服务**降级到 base model**，不报错。需要 LID + 自定义模型时改用 real-time STT
- ❌ **Phrase list 不支持**——这是 batch 与 real-time/fast 的最大功能差异

## 7. 响应（创建后）

```json
{
  "self": "https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions/788a1f24-.../?api-version=2024-11-15",
  "displayName": "My Transcription",
  "locale": "en-US",
  "createdDateTime": "2025-05-24T03:20:39Z",
  "lastActionDateTime": "2025-05-24T03:20:39Z",
  "links": {
    "files": "https://eastus.api.cognitive.microsoft.com/speechtotext/transcriptions/788a1f24-.../files?api-version=2024-11-15"
  },
  "properties": { ... },
  "status": "NotStarted"
}
```

`status` 取值：`NotStarted | Running | Succeeded | Failed`。

## 8. 拉取结果

```
GET <self>/files?api-version=2024-11-15
```

返回多个 `kind`：`Transcription`（主结果）/ `TranscriptionReport`（每文件状态汇总）。再 GET 单个 file 的 `links.contentUrl` 取 JSON 结果。

## 9. 输出 JSON 结构（关键字段）

包含 `recognizedPhrases[]`，每条含 `offset`、`duration`、`speaker`（如启用 diarization）、`nBest[]`（含 lexical/itn/maskedITN/display），如启用词级时间戳，则 `nBest[0].words[]` 含 `word/offset/duration`。

> 完整字段 schema 参考 https://learn.microsoft.com/en-us/azure/ai-services/speech-service/batch-transcription-get

## 10. Whisper 模型路径

```json
{ "model": { "self": "https://<region>.api.cognitive.microsoft.com/speechtotext/models/base/<whisper-id>?api-version=2024-11-15" } }
```

- `displayName` 含 "Whisper"（如 `20240228 Whisper Large V2`）
- Display-only：`lexical` 字段不填充
- 词级时间戳要用 `displayFormWordLevelTimestampsEnabled`，不要用 `wordLevelTimestampsEnabled`
- Whisper 仅在部分 region 可用：`australiaeast`, `eastus`, `japaneast`, `southcentralus`, `southeastasia`, `uksouth`, `westeurope`

## 11. Webhook

注册：`POST /speechtotext/webhooks?api-version=2024-11-15`

```json
{
  "displayName": "My Webhook",
  "events": { "transcriptionSucceeded": true, "transcriptionFailed": true },
  "webUrl": "https://your-endpoint.example.com/webhook"
}
```

**握手**：注册时 Azure 会立即 `POST` 一个 `?validationToken=<X>`，你必须用 **plain text** 把 token 原样回写（200 OK，`Content-Type: text/plain`）。**返回 JSON 会握手失败且没有明确错误**。

防火墙：必须允许 Azure service tag `CognitiveServicesManagement` 入站 443。

## 12. Quotas（S0）

| 项 | 限制 |
| --- | --- |
| Speech-to-text REST API rate | 100 req / 10s（600 req / min） |
| 单音频文件大小 | ≤ **1 GB** |
| 容器内 blob 数 | ≤ 10,000 |
| 单 transcription 请求最多文件数 | ≤ 1,000 |
| 启用 diarization 时单文件时长 | ≤ 240 分钟 |

> F0 不可用 batch transcription。

## 13. 性能 / 调度

文档原文：
> Batch transcription jobs are scheduled best-effort. At peak hours, it might take **up to 30 minutes to start** processing and **up to 24 hours to complete**.

最佳实践（来自官方）：
- **请求批量**：单次提交 ~1000 文件优于发 600 次小请求
- **时间分散**：跨小时提交，不要短时间集中
- **轮询频率**：≥ 1 次/分钟；建议 ≥ 1 次/10 分钟
- **多 region 负载分散**：单 region 后端是 sequential 处理，加速靠跨 region

## 14. OpenSpeech 适配建议

OpenSpeech 是实时听写，batch 路径基本用不到。仅在以下场景考虑：
- 用户导入历史录音转写（"音频文件转写"功能）
- 长会议录音事后处理

如果走 batch，**不能用 phrase list**（用户词典失效），且必须先把文件上传到 Blob 拿 SAS。
