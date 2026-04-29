# 腾讯云 录音文件识别（CreateRecTask） + 极速版（FlashRecognize）

> 来源：
> - 主接口：https://cloud.tencent.com/document/product/1093/37823
> - 结果查询：https://cloud.tencent.com/document/product/1093/37822
> - 数据结构：https://cloud.tencent.com/document/api/1093/37824
> - 回调说明：https://cloud.tencent.com/document/product/1093/52632
> - 极速版：https://cloud.tencent.com/document/product/1093/52097
> - 计费：https://cloud.tencent.com/document/product/1093/35686
>
> 抓取日期：2026-04-28

> ⭐ 这是腾讯云 ASR 中**唯一原生支持说话人分离 / 角色分离的产品族**，OpenSpeech 重点接入对象。

---

# Part A. 录音文件识别（异步） — `CreateRecTask`

## A.1 基本信息

| 项 | 值 |
|----|----|
| Endpoint | `asr.tencentcloudapi.com` |
| Action | `CreateRecTask` |
| Version | `2019-06-14` |
| 协议 | HTTPS POST JSON |
| 鉴权 | API 3.0 签名 v3（TC3-HMAC-SHA256） |
| 时效 | **异步**，结果 3 小时内回调或轮询返回；通常 1 小时音频 1–3 分钟出结果 |

## A.2 请求参数（完整）

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `EngineModelType` | 是 | String | 引擎，见 §A.3 |
| `ChannelNum` | 是 | Integer | 1=单声道；2=双声道 |
| `ResTextFormat` | 是 | Integer | 0–5，见 §A.4 |
| `SourceType` | 是 | Integer | 0=URL；1=base64 数据 |
| `Url` | 否 | String | SourceType=0 必填 |
| `Data` | 否 | String | SourceType=1 必填，base64 |
| `CallbackUrl` | 否 | String | 回调地址 |
| `SpeakerDiarization` | 否 | Integer | **0/1/3** —— 0=关；1=开启说话人分离；3=开启角色分离 |
| `SpeakerNumber` | 否 | Integer | **0–10** —— 0=自动（最多 20）；1–10=指定人数；16k 引擎不支持指定人数 |
| `SpeakerRoles.N` | 否 | Array of `SpeakerRoleInfo` | 角色分离配置（仅 `SpeakerDiarization=3` 用） |
| `HotwordId` | 否 | String | 热词表 ID |
| `HotwordList` | 否 | String | 临时热词，逗号分割 |
| `CustomizationId` | 否 | String | 自学习模型 |
| `FilterDirty` | 否 | Integer | 0/1/2 |
| `FilterModal` | 否 | Integer | 0/1/2 |
| `FilterPunc` | 否 | Integer | 0/1/2 |
| `ConvertNumMode` | 否 | Integer | 0/1/3 |
| `EmotionRecognition` | 否 | Integer | 0/1/2 |
| `EmotionalEnergy` | 否 | Integer | 0/1 |
| `SentenceMaxLength` | 否 | Integer | 单标点最多字数 6–40 |
| `ReplaceTextId` | 否 | String | 替换词表 ID |

## A.3 EngineModelType 全列表

### 8k
| 值 | 说明 |
|---|------|
| `8k_zh` | 中文电话通用 |
| `8k_en` | 英文电话通用 |
| `8k_zh_large` | **中文电话大模型** —— 同时支持中文 + 上海/四川/武汉/贵阳/昆明/西安/郑州/太原/兰州/银川/西宁/南京/合肥/南昌/长沙/苏州/杭州/济南/天津/石家庄/黑龙江/吉林/辽宁话 + 闽南语/客家话/粤语/南宁话 |

### 16k
| 值 | 说明 |
|---|------|
| `16k_zh` | 中文普通话通用（含少量英文） |
| `16k_zh_large` | **普方英大模型** —— 中文 + 英文 + 多种方言 |
| `16k_zh_en` | **中英粤+9 种方言大模型** —— 中/英/粤/四川/陕西/河南/上海/湖南/湖北/安徽/闽南/潮汕 |
| `16k_multi_lang` | **多语种大模型** —— en/ja/ko/ar/fil/fr/hi/id/ms/pt/es/th/tr/vi/de（15 种）自动识别 |
| `16k_zh_dialect` | 23 种方言混合（注意：录音文件接口确实有此引擎，但 §6 角色分离仅在 `16k_zh_en` 上支持） |
| `16k_zh-PY` | 中英粤混合 |
| `16k_zh-TW` | 中文繁体 |
| `16k_zh_medical` | 中文医疗 |
| `16k_yue` | 粤语 |
| `16k_en` / `16k_en_large` | 英文 |
| `16k_ja` / `16k_ko` / `16k_th` / `16k_vi` / `16k_ms` / `16k_id` / `16k_fil` | 日/韩/泰/越/马/印尼/菲 |
| `16k_pt` / `16k_tr` / `16k_ar` / `16k_es` / `16k_hi` / `16k_fr` / `16k_de` | 葡/土/阿/西/印地/法/德 |

## A.4 ResTextFormat 取值

| 值 | 含义 |
|---|------|
| 0 | 基础识别结果（仅含有效人声时间戳） |
| 1 | 基础 + 词级时间戳（不含标点）+ 语速 |
| 2 | 基础 + 词级时间戳（含标点）+ 语速 |
| 3 | 基础 + 词级（含标点），按标点分段，**适合字幕** |
| 4 | **【增值付费】** 同 3，且按 NLP 语义分段，适合会议/庭审；**仅支持 `8k_zh` / `16k_zh`** |
| 5 | **【增值付费】** 同 3，且额外输出口语转书面语；**仅支持 `8k_zh` / `16k_zh`** |

## A.5 音频限制

| 项 | 上限 |
|----|------|
| URL 时长 | **5 小时** |
| URL 文件大小 | **1 GB** |
| 本地上传（Data）大小 | **5 MB** |
| 支持格式 | wav / mp3 / m4a / flv / mp4 / wma / 3gp / amr / aac / ogg-opus / flac |

## A.6 任务回调与查询

- **回调**：`CallbackUrl` 配置，腾讯端推送结果（详见 https://cloud.tencent.com/document/product/1093/52632）
- **轮询**：`DescribeTaskStatus(TaskId)`（详见 https://cloud.tencent.com/document/product/1093/37822）
  - Status: 0=等待 / 1=执行中 / 2=成功 / 3=失败
- 结果在服务端**保存 24 小时**
- 回调失败重试：**最多 2 次**

## A.7 ⭐ 说话人分离 / 角色分离

> 这是 OpenSpeech 重点关注的能力，腾讯在中文 ASR provider 里几乎是**唯一原生支持的**。

### 单声道说话人分离（`SpeakerDiarization=1`）
- 仅 `ChannelNum=1` 时可用
- **支持的引擎清单**（官方原文）：
  `8k_zh` / `8k_zh_large` / `16k_zh` / `16k_ms` / `16k_en` / `16k_id` / `16k_zh_large` / `16k_zh_dialect` / `16k_zh_en` / `16k_es` / `16k_fr` / `16k_ja` / `16k_ko`
- `SpeakerNumber=0` → 自动分离（最多 20 人）；`1–10` → 指定人数；**16k 引擎不支持指定人数，必须 0**
- 结果中 `SentenceDetail[].SpeakerId` 为不同整数代表不同说话人

### 角色分离（`SpeakerDiarization=3`）— ASR 增值服务
- **仅支持 `16k_zh_en` 引擎**
- 必须配合 `SpeakerRoles.N` 数组：
  - `RoleAudioUrl`：声纹音频地址（30s 内纯净人声，最长 45s）
  - `RoleName`：角色名
- **仅可传入一组声纹**（即只能锚定一个角色，剩下的用普通分离）
- 输出：若声纹匹配成功，`SentenceDetail[].SpeakerRoleName` 字段 + `SpeakerId` 被替换为该角色

### 双声道分轨（`ChannelNum=2`）
- 推荐用于 8k 电话音频
- **不需要**也不应开启 `SpeakerDiarization`
- `SentenceDetail[].SpeakerId` 物理含义：
  - `0` = 左声道（甲方）
  - `1` = 右声道（乙方）
- 官方原文："物理区分说话人、避免说话双方重叠产生的识别错误，能达到最好的说话人分离效果和识别效果"

### 单声道分离 vs 双声道对比

| 维度 | 单声道分离 | 双声道分轨 |
|------|-----------|-----------|
| 适用 | 16k 通用、单麦录音 | 8k 电话双方分轨录制 |
| 参数 | `ChannelNum=1` + `SpeakerDiarization=1` | `ChannelNum=2`，无需开 SD |
| SpeakerId 含义 | 算法分配的人物 ID | 0=左、1=右物理声道 |
| 重叠话音处理 | 算法尽量分；可能会错 | 物理隔离，最佳效果 |

## A.8 输出数据结构（关键）

### `Response.Data.ResultDetail[]`（即 `SentenceDetail`）

| 字段 | 类型 | 含义 |
|------|------|------|
| `FinalSentence` | String | 单句最终结果 |
| `SliceSentence` | String | 单句中间结果（空格分词） |
| `WrittenText` | String | 口语转书面语（增值，开启后才有） |
| `StartMs` | Integer | 该句起始毫秒 |
| `EndMs` | Integer | 该句结束毫秒 |
| `WordsNum` | Integer | 该句词数 |
| `Words[]` | Array of `SentenceWords` | 词级数组 |
| `SpeechSpeed` | Float | 语速（字/秒） |
| **`SpeakerId`** | Integer | **说话人 ID**（双声道时 0/1 = 左/右） |
| **`SpeakerRoleName`** | String | **角色分离匹配到的角色名** |
| `EmotionalEnergy` | Float | 情绪能量 [1,10] |
| `EmotionType` | Array<String> | 情绪类型 |
| `SilenceTime` | Integer | 与上句的静音时长 |
| `KeyWordResults` | Array | 关键词识别结果 |
| `LangType` | String | 多语种识别识别出的语种类型 |

### `SentenceWords`
| 字段 | 类型 | 含义 |
|------|------|------|
| `Word` | String | 词 |
| `OffsetStartMs` | Integer | 该词在句中起始偏移 |
| `OffsetEndMs` | Integer | 该词在句中结束偏移 |

> ⚠️ 词级时间戳**只有当 `ResTextFormat ∈ {1,2,3,4,5}`** 才返回 `Words[]`。

## A.9 限频与并发

- 默认任务提交频率：**20 次/秒**
- 任务返回时效与提交频率无关
- 并发任务总数：官方文档**未明确说明**

## A.10 错误码

| 错误码 | 含义 |
|--------|------|
| `AuthFailure.InvalidAuthorization` | 鉴权错误 |
| `FailedOperation.CheckAuthInfoFailed` | 鉴权错误 |
| `FailedOperation.ErrorDownFile` | 下载音频失败 |
| `FailedOperation.ErrorRecognize` | 识别失败 |
| `FailedOperation.ServiceIsolate` | 账号欠费 |
| `FailedOperation.UserHasNoAmount` | 资源包耗尽 |
| `FailedOperation.UserHasNoFreeAmount` | 资源包耗尽，需开后付费或购买 |
| `FailedOperation.UserNotRegistered` | 服务未开通 |
| `InvalidParameter` | 参数错误 |
| `InvalidParameterValue` | 参数取值错误 |
| `MissingParameter` | 缺少参数 |
| `RequestLimitExceeded.UinLimitExceeded` | 超出请求频率 |
| `UnknownParameter` | 未知参数 |

公共错误码：https://cloud.tencent.com/document/api/1093/35647

## A.11 计费

- 计费方式：**按时长（小时）**
- 后付费阶梯：0–12 万小时/月 = 1.75 元/小时；30 万+小时/月 = 0.95 元/小时
- 免费额度：每月 10 小时
- 资源包：60 小时 90 元 / 1000 小时 1200 元 / 300000 小时 210000 元
- 角色分离、口语转书面语、NLP 语义分段、情绪识别 = **增值收费**（具体单价官方在线计费页未列）

---

# Part B. 录音文件识别极速版（同步） — `FlashRecognize`

## B.1 基本信息

| 项 | 值 |
|----|----|
| URL | `https://asr.cloud.tencent.com/asr/flash/v1/<appid>?{query}` |
| 协议 | HTTPS POST，body 为音频二进制 |
| 鉴权 | **HMAC-SHA1 + Base64**（同实时识别，不是 TC3）；`Authorization` header 传签名 |
| 时效 | **准实时同步返回**（通常秒级），适合短视频字幕、配音转写 |

## B.2 请求参数（query）

`appid`、`secretid`、`timestamp` 必填；其他重要：
- `engine_type` 必填
- `voice_format` 必填
- `speaker_diarization`、`hotword_id`、`hotword_list`、`customization_id`
- `filter_dirty` / `filter_modal` / `filter_punc` / `convert_num_mode`
- `word_info`
- `first_channel_only`

## B.3 引擎

支持：`8k_zh`、`8k_zh_large`、`16k_zh`、`16k_zh_large`、`16k_multi_lang`、`16k_yue`、`16k_en` 等。

## B.4 音频上限

| 项 | 上限 |
|----|------|
| 文件大小 | **100 MB** |
| 时长 | **2 小时** |
| 格式 | wav / pcm / ogg-opus / speex / silk / mp3 / m4a / aac / amr |

## B.5 响应

```json
{
  "code": 0,
  "message": "success",
  "request_id": "xxx",
  "audio_duration": 12345,
  "flash_result": [
    {
      "channel_id": 0,
      "text": "全段识别文本",
      "sentence_list": [
        { "text": "...", "start_time": 0, "end_time": 1200,
          "word_list": [ { "word": "...", "start_time": 0, "end_time": 200 } ] }
      ]
    }
  ]
}
```

## B.6 能力

| 能力 | 极速版 |
|------|--------|
| 词级时间戳 | ✅ |
| 热词 | ✅（含临时热词、超级热词） |
| 自学习模型 | ✅ |
| 说话人分离 | ✅（`speaker_diarization`） |
| partial 中间结果 | ❌（同步一次性返回） |
| 角色分离（声纹锚定） | 官方文档未明确 |

## B.7 限频与并发

- 普通版本：**单账号免费并发 20**
- 大模型版本：**单账号免费并发 5**
- 提升需购买并发包

## B.8 错误码（区段）

- `4001`–`4012`：参数 / 鉴权 / 服务相关
- `5001`–`5003`：识别失败 / 超时

---

# Part C. 关键页面汇总

| 页面 | 链接 |
|------|------|
| CreateRecTask | https://cloud.tencent.com/document/product/1093/37823 |
| DescribeTaskStatus | https://cloud.tencent.com/document/product/1093/37822 |
| 数据结构 | https://cloud.tencent.com/document/api/1093/37824 |
| 回调说明 | https://cloud.tencent.com/document/product/1093/52632 |
| FlashRecognize | https://cloud.tencent.com/document/product/1093/52097 |
| 计费 | https://cloud.tencent.com/document/product/1093/35686 |
| 热词配置 | https://cloud.tencent.com/document/product/1093/40996 |
| 自学习模型 | https://cloud.tencent.com/document/product/1093/38416 |
| 公共参数 | https://cloud.tencent.com/document/api/1093/35640 |
| 公共错误码 | https://cloud.tencent.com/document/api/1093/35647 |
| API Explorer | https://console.cloud.tencent.com/api/explorer?Product=asr&Version=2019-06-14&Action=CreateRecTask |
