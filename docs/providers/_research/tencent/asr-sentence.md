# 腾讯云 一句话识别（SentenceRecognition）

> 来源：官方文档 https://cloud.tencent.com/document/product/1093/35646
> 抓取日期：2026-04-28

> 辅助：
> - 公共参数：https://cloud.tencent.com/document/api/1093/35640
> - 公共错误码：https://cloud.tencent.com/document/api/1093/35647
> - 计费：https://cloud.tencent.com/document/product/1093/35686

---

## 1. 接口域名 / 入口

- Endpoint：`asr.tencentcloudapi.com`
- Region：官方文档明确写 "**本接口不需要传递 Region 参数**"
- 协议：HTTPS POST，body 为 JSON
- Action：`SentenceRecognition`
- Version：`2019-06-14`

---

## 2. 鉴权

API 3.0 签名 v3：**TC3-HMAC-SHA256**。详见 [`auth-and-billing.md`](./auth-and-billing.md)。

必须 Header：
```
Host: asr.tencentcloudapi.com
Content-Type: application/json; charset=utf-8
X-TC-Action: SentenceRecognition
X-TC-Version: 2019-06-14
X-TC-Timestamp: <unix-seconds>
Authorization: TC3-HMAC-SHA256 Credential=..., SignedHeaders=..., Signature=...
```

---

## 3. 请求参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `EngSerViceType` | String | 是 | 引擎类型，见 §4 |
| `SourceType` | Integer | 是 | 0=语音 URL；1=语音数据（POST body） |
| `VoiceFormat` | String | 是 | 音频格式：wav / pcm / ogg-opus / speex / silk / mp3 / m4a / aac / amr |
| `Url` | String | 否 | 公网可下载音频 URL（SourceType=0 必填） |
| `Data` | String | 否 | base64 编码的音频数据（SourceType=1 必填） |
| `DataLen` | Integer | 否 | base64 编码前的字节长度（SourceType=1 必填） |
| `WordInfo` | Integer | 否 | 词级时间戳：0=不返回；1=不含标点；2=含标点（默认 0） |
| `FilterDirty` | Integer | 否 | 0=不过滤；1=过滤；2=替换为* |
| `FilterModal` | Integer | 否 | 0=不过滤；1=部分过滤；2=严格过滤 |
| `FilterPunc` | Integer | 否 | 0=不过滤；1=过滤句末标点；2=过滤所有标点 |
| `ConvertNumMode` | Integer | 否 | 0=不转；1=智能转（默认 1） |
| `HotwordId` | String | 否 | 热词表 ID |
| `HotwordList` | String | 否 | 临时热词表（最多 128 个） |
| `CustomizationId` | String | 否 | 自学习模型 ID |
| `InputSampleRate` | Integer | 否 | 仅支持 8000，用于 8k 升采样到 16k |
| `ReplaceTextId` | String | 否 | 替换词表 ID |

> 官方页面**未提及** `ProjectId`、`SubServiceType`、`UsrAudioKey`、`ReinforceHotword`、`SpeakerDiarization` 等字段。

---

## 4. EngSerViceType 取值

### 8k（电话）
- `8k_zh`、`8k_en`

### 16k（非电话）
- `16k_zh`（普通话）
- `16k_zh-PY`（中英粤混合）
- `16k_zh_medical`（医疗）
- `16k_zh_dialect`（**23 种方言混合识别**，仅一句话识别和录音文件识别有此引擎，实时识别无）
- `16k_yue`、`16k_en`、`16k_ja`、`16k_ko`
- `16k_vi`、`16k_ms`、`16k_id`、`16k_fil`
- `16k_th`、`16k_pt`、`16k_tr`、`16k_ar`
- `16k_es`、`16k_hi`、`16k_fr`、`16k_de`

> 一句话识别接口的官方文档**未列出大模型版引擎**（`*_large` / `16k_multi_lang`），如需大模型语种自动识别要走录音文件识别或实时识别。

---

## 5. 音频规格

| 项 | 上限 |
|----|------|
| 时长 | **60 秒** |
| 文件大小 | **3 MB（base64 编码后）** |
| 声道 | 单声道 |
| 采样率 | 8000 / 16000 Hz（与引擎对应） |
| 支持格式 | wav、pcm、ogg-opus、speex、silk、mp3、m4a、aac、amr |

---

## 6. 响应结构

```json
{
  "Response": {
    "RequestId": "xxx",
    "Result": "识别出来的整段文本",
    "AudioDuration": 1500,
    "WordSize": 4,
    "WordList": [
      { "Word": "你", "StartTime": 0, "EndTime": 200 },
      { "Word": "好",  "StartTime": 200, "EndTime": 400 }
    ]
  }
}
```

| 字段 | 类型 | 含义 |
|------|------|------|
| `Result` | String | 识别文本 |
| `AudioDuration` | Integer | 音频时长 ms |
| `WordSize` | Integer | 词数（仅在 `WordInfo>0` 时返回） |
| `WordList[].Word` | String | 词文本 |
| `WordList[].StartTime` / `EndTime` | Integer | 该词在音频中的起止 (ms) |

---

## 7. 能力支持

| 能力 | 是否支持 | 怎么开 |
|-----|---------|--------|
| 词级时间戳 | ✅ | `WordInfo=1`（不含标点）/ `WordInfo=2`（含标点） |
| 自定义热词 | ✅ | `HotwordId` 或 `HotwordList`（最多 128） |
| 自学习模型 | ✅ | `CustomizationId` |
| 标点过滤 | ✅ | `FilterPunc` |
| 数字归一化 | ✅ | `ConvertNumMode` |
| 脏词过滤 | ✅ | `FilterDirty` |
| 替换词表 | ✅ | `ReplaceTextId` |
| **说话人分离** | ❌ | **官方文档未提及** —— 单段 ≤60s 的设计就不适合做 diarization |
| **服务端 VAD** | ❌（不需要） | 单段 ≤60s 不存在分句问题 |
| **partial 中间结果** | ❌ | 一次性请求-响应，无 partial |
| 多语种自动检测 | ❌ | 需指定具体 `EngSerViceType` |
| 流式 | ❌ | 单次 REST |

---

## 8. 限频与并发

- 默认请求频率：**30 次/秒**
- 提升需在 https://buy.cloud.tencent.com/asr 购买并发包

---

## 9. 错误码（节选）

| 错误码 | 含义 |
|--------|------|
| `FailedOperation.ErrorRecognize` | 识别失败 |
| `FailedOperation.ServiceIsolate` | 账号欠费 |
| `FailedOperation.UserNotRegistered` | 服务未开通 |
| `InvalidParameterValue.ErrorInvalidEngservice` | EngSerViceType 无效 |
| `InvalidParameterValue.ErrorVoicedataTooLong` | 音频时长超过 60s |
| `InvalidParameter.ErrorInvalidVoiceFormat` | 音频格式不支持 |
| `InvalidParameterValue.NoHumanVoice` | 无有效人声（>1s） |

完整公共错误码：https://cloud.tencent.com/document/api/1093/35647

---

## 10. 计费

来源：https://cloud.tencent.com/document/product/1093/35686

- 计费方式：**按调用次数（千次）**
- 后付费阶梯：0–299 千次/日 = 3.20 元/千次；≥5000 千次/日 = 1.20 元/千次
- 免费额度：每月 5000 次
- 资源包：30 千次 90 元 / 1000 千次 1800 元 / 100000 千次 120000 元

---

## 11. 相关链接

- 主接口：https://cloud.tencent.com/document/product/1093/35646
- API Explorer：https://console.cloud.tencent.com/api/explorer?Product=asr&Version=2019-06-14&Action=SentenceRecognition
- 公共参数：https://cloud.tencent.com/document/api/1093/35640
