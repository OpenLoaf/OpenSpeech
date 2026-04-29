# 腾讯云 实时语音识别（WebSocket）

> 来源：官方文档 https://cloud.tencent.com/document/product/1093/48982
> 抓取日期：2026-04-28

> 辅助来源：
> - 计费：https://cloud.tencent.com/document/product/1093/35686
> - 热词：https://cloud.tencent.com/document/product/1093/40996
> - 产品功能：https://cloud.tencent.com/document/product/1093/35682

---

## 1. 接口 URL

```
wss://asr.cloud.tencent.com/asr/v2/<appid>?{请求参数}
```

- Path：`/asr/v2/<appid>`
- Region：官方文档**仅给出单一接入地址**，未提供多 region endpoint 列表。

> ⚠️ 注意：实时语音识别走的是独立的 `asr.cloud.tencent.com` 域名（HMAC-SHA1 签名），不是腾讯云 API 3.0 的 `asr.tencentcloudapi.com`（TC3-HMAC-SHA256 签名）。

---

## 2. 鉴权方式

签名算法：**HMAC-SHA1 + Base64 + URL 编码**（不是 TC3-HMAC-SHA256）。

### 鉴权步骤
1. 除 `signature` 外所有 query 参数按字典序排序，拼接为 URL（不含 `wss://`）
2. 用 SecretKey 对该字符串做 HMAC-SHA1，再 Base64 编码
3. 把结果做 URL 编码，作为 `signature` 参数加入请求

### 必填鉴权参数
| 参数 | 含义 |
|------|------|
| `secretid` | 腾讯云 SecretId |
| `timestamp` | 当前 UNIX 秒级时间戳 |
| `expired` | 签名过期时间戳，必须 > timestamp，且差值 < 90 天 |
| `nonce` | 随机正整数，最长 10 位 |
| `signature` | 计算结果 |

控制台：https://console.cloud.tencent.com/cam/capi

---

## 3. 请求 Query 参数完整列表

| 参数 | 类型 | 必填 | 含义 / 取值 |
|------|------|------|-----------|
| `secretid` | String | 是 | API 密钥 |
| `timestamp` | Integer | 是 | UNIX 秒 |
| `expired` | Integer | 是 | 签名过期时间 |
| `nonce` | Integer | 是 | 随机数（最长 10 位） |
| `engine_model_type` | String | 是 | 引擎类型，见 §6 |
| `voice_id` | String | 是 | 音频流唯一标识，UUID，最长 128 位，每次连接需重新生成 |
| `signature` | String | 是 | 计算签名 |
| `voice_format` | Integer | 否 | 音频编码：1=pcm、4=speex、6=silk、8=mp3、10=opus、12=wav、14=m4a、16=aac（默认 4） |
| `needvad` | Integer | 否 | VAD 端点检测：0=关闭、1=开启（默认 0；音频 >60s 时**必须开启**） |
| `vad_silence_time` | Integer | 否 | 断句静音阈值，500-2000ms（默认 1000）；**注意：根据搜索结果该参数有"目前仅支持 8k_zh 引擎"的限制** |
| `max_speak_time` | Integer | 否 | 强制断句时长 5000-90000ms（默认 60000） |
| `hotword_id` | String | 否 | 预创建热词表 ID |
| `hotword_list` | String | 否 | 临时热词表，`词\|权重` 用逗号分割，最多 128 个 |
| `customization_id` | String | 否 | 自学习模型 ID |
| `replace_text_id` | String | 否 | 替换词汇表 ID（生效延迟约 10 分钟） |
| `filter_dirty` | Integer | 否 | 0/1/2（默认 0） |
| `filter_modal` | Integer | 否 | 0/1/2（默认 0） |
| `filter_punc` | Integer | 否 | 0/1（仅句末句号，默认 0） |
| `filter_empty_result` | Integer | 否 | 0=回调空结果、1=不回调（默认 1） |
| `convert_num_mode` | Integer | 否 | 0/1/3（默认 1） |
| `word_info` | Integer | 否 | 词级时间戳：0=不显示、1=显示(不含标点)、2=显示(含标点)、100=字/词级时间戳（默认 0） |
| `noise_threshold` | Float | 否 | 噪音阈值 [-2,2]（默认 0；官方标注"慎用"） |
| `input_sample_rate` | Integer | 否 | 仅支持 8000，用于 8k 音频升采样到 16k |
| `emotion_recognition` | Integer | 否 | 情绪识别（增值收费）：0/1/2（默认 0） |

> 官方文档**未提及** `speaker_diarization` / `max_speaker_num` 参数。说话人分离能力在实时识别接口里**不支持**（参见 §9）。

---

## 4. 客户端音频数据格式

| 项 | 规格 |
|----|------|
| 支持格式 | PCM、WAV、Opus、Speex、SILK、MP3、M4A、AAC |
| 采样率 | 16000 Hz 或 8000 Hz |
| 采样精度 | 16 bit |
| 声道 | 单声道 mono |
| 分片建议 | 每 200ms 发送 200ms 时长的数据（1:1 实时率） |
| PCM 分片大小 | 8k → 3200 字节；16k → 6400 字节 |
| 帧类型 | Binary frame = 音频；Text frame `{"type":"end"}` = 流结束 |

> ⚠️ 发送速率超过 1:1 实时率，或分片间隔 >6 秒会触发错误码 4000。
> Opus 特殊：FrameSize 固定 640 short，每帧前要带 OpusHead(4B) + 帧长(2B)。

---

## 5. 服务端响应 JSON

### 握手成功
```json
{ "code": 0, "message": "success", "voice_id": "RnKu9FODFHK5FPpsrN" }
```

### 识别中 / 结束
```json
{
  "code": 0,
  "message": "success",
  "voice_id": "RnKu9FODFHK5FPpsrN",
  "message_id": "RnKu9FODFHK5FPpsrN_11_0",
  "result": {
    "slice_type": 0,
    "index": 0,
    "start_time": 0,
    "end_time": 1240,
    "voice_text_str": "实时",
    "word_size": 0,
    "word_list": [
      { "word": "我", "start_time": 380, "end_time": 680, "stable_flag": 1 }
    ]
  }
}
```

### 字段
| 字段 | 类型 | 含义 |
|------|------|------|
| `code` | Int | 0=成功；非 0 见 §8 |
| `message` | String | 错误说明 |
| `voice_id` | String | 与请求一致 |
| `message_id` | String | 本条消息唯一 ID |
| `final` | Int | =1 表示音频流全部识别完毕 |
| `result.slice_type` | Int | **0=开始；1=识别中（非稳态 partial）；2=识别结束（稳态 final）** |
| `result.index` | Int | 该段在整流中的序号（从 0 起） |
| `result.start_time` / `end_time` | Int | 该段在整流的起止时间 (ms) |
| `result.voice_text_str` | String | 当前段文本（UTF-8） |
| `result.word_size` | Int | 当前段词数 |
| `result.word_list[]` | Array | 词级数组：`word`、`start_time`、`end_time`、`stable_flag` |

> **partial vs final 的关键判断字段就是 `slice_type`**：
> - `slice_type=1` → 中间结果（partial），后续会更新
> - `slice_type=2` → 该句最终结果（final）
> - `slice_type=0` → 该句开始

---

## 6. engine_model_type 全列表

### 8k（电话场景）
| 值 | 含义 |
|---|------|
| `8k_zh` | 中文电话通用 |
| `8k_en` | 英文电话通用 |
| `8k_zh_large` | 中文电话专用大模型（同时识别中文+粤语+多种方言） |

### 16k（非电话场景）
| 值 | 含义 |
|---|------|
| `16k_zh` | 中文普通话通用（含少量英语） |
| `16k_zh_large` | 普方英大模型（中文+英文+27 种方言） |
| `16k_zh_en` | 中英粤+9 种方言大模型 |
| `16k_multi_lang` | 多语种大模型（en/ja/ko/ar/fil/fr/hi/id/ms/pt/es/th/tr/vi/de 共 15 种） |
| `16k_zh-TW` | 中文繁体 |
| `16k_zh_edu` | 中文教育 |
| `16k_zh_medical` | 中文医疗 |
| `16k_zh_court` | 中文法庭 |
| `16k_yue` | 粤语 |
| `16k_en` | 英语通用 |
| `16k_en_game` | 英语游戏 |
| `16k_en_edu` | 英语教育 |
| `16k_en_large` | 英语大模型 |
| `16k_ja` / `16k_ko` / `16k_th` / `16k_id` / `16k_vi` / `16k_ms` / `16k_fil` | 日/韩/泰/印尼/越南/马来/菲律宾 |
| `16k_pt` / `16k_tr` / `16k_ar` / `16k_es` / `16k_hi` / `16k_fr` / `16k_de` | 葡/土耳其/阿/西/印地/法/德 |

> **注意**：实时识别接口**没有** `16k_zh_dialect` 单独引擎；方言能力是通过 `8k_zh_large` / `16k_zh_large` / `16k_zh_en` 三个大模型版引擎自动覆盖的。

### 多语种自动识别
- `16k_multi_lang` 文档原文："**可实现 15 个语种的自动识别**"
- 但官方未单独提供 `auto` / `und` 这种"先检测再识别"的两步式 auto-detect 模式 —— 它是**输入即多语种、输出文本带语种标签**的混说识别。

---

## 7. 单次连接限制

| 项 | 规格 |
|----|------|
| 客户端空闲断开 | 超过 **15 秒**未发送音频数据 → 错误码 4008 |
| 单句强制断句最长 | `max_speak_time` 上限 90 秒 |
| 1:1 实时率上限 | 1 秒内最多发送 3 秒音频，否则错误码 4000；分片间隔 >6 秒也错 |
| 默认并发 | **单账号 200 路**，可付费提升 |
| 最长连接时长 | **官方文档未明确说明**（仅约束单句和空闲，整体连接时长无显式上限） |

---

## 8. 错误码

| 错误码 | 含义 |
|--------|------|
| 4000 | 音频数据发送过多 |
| 4001 | 参数不合法 |
| 4002 | 鉴权失败 |
| 4003 | AppID 服务未开通 |
| 4004 | 资源包耗尽 |
| 4005 | 账户欠费 |
| 4006 | 并发超限 |
| 4007 | 音频解码失败 |
| 4008 | 客户端 15 秒未发送音频 |
| 4009 | 客户端连接断开 |
| 4010 | 上传未知文本消息 |
| 5000–5002 | 服务端临时故障（偶发） |
| 6001 | 境外调用需在国际站开通 |

---

## 9. 说话人分离能力 — **不支持**

> **官方实时识别接口文档（48982）通篇未提及** `speaker_diarization`、`max_speaker_num`、`speaker_info`、`SpeakerId` 等任何字段。

依据：
- 实时识别接口参数表无说话人相关字段。
- 产品功能矩阵页（35682）"说话人分离"能力**只标注录音文件识别支持**，实时识别行不勾选该功能。

如需"说话人分离 / 角色分离"，必须改用：
- **录音文件识别 `CreateRecTask`**（异步、`SpeakerDiarization` + `SpeakerNumber` + `SpeakerRoles`，详见 [`asr-recording.md`](./asr-recording.md)）
- **录音文件极速版 `FlashRecognize`**（准实时，但语义上仍是"完整文件识别"，不是流式）

---

## 10. 自定义热词

### 两种传法
| 方式 | 上限 | 说明 |
|------|------|------|
| `hotword_id` | 30 个表/账号；1000 词/表；单词 ≤10 字 | 控制台预创建 |
| `hotword_list`（临时热词） | **128 个/请求** | 每次请求直接传 |

> 同时传 `hotword_id` + `hotword_list` 时，**只有 `hotword_list` 生效**。

### 权重
- `[1, 11]` 整数 + 数值 `100` 共 12 档
- `1–10`：通用热词
- `11`：超级热词
- `100`：热词增强版（同音同调替换；**仅支持 `8k_zh` / `16k_zh`**）

### 引擎兼容
- 所有中文普通话模型 + 所有英文模型 + 所有粤语模型支持热词
- 热词增强版（权重 100）仅中文普通话两个引擎

---

## 11. 计费

来源：https://cloud.tencent.com/document/product/1093/35686

- 计费方式：**按时长（小时）**
- 后付费阶梯：0–299 小时/日 = 3.20 元/小时；≥5000 小时/日 = 1.20 元/小时
- 大模型版（`*_large`、`16k_zh_en`、`16k_multi_lang`）后付费：0–299 小时/日 = 4.80 元/小时；≥5000 小时/日 = 3.00 元/小时
- 免费额度：每月 5 小时
- 资源包：60 小时 270 元 / 1000 小时 4200 元 / 10000 小时 35000 元
- 增值能力（情绪识别、口语转书面语、角色分离等）需在购买资源包后开启，**单独计费**（具体单价在线计费页未列出，需查购买页）

---

## 12. 相关官方链接

- 主接口：https://cloud.tencent.com/document/product/1093/48982
- 计费：https://cloud.tencent.com/document/product/1093/35686
- 公共错误码：https://cloud.tencent.com/document/api/1093/35647
- 控制台 API 密钥：https://console.cloud.tencent.com/cam/capi
- 词汇替换配置：https://console.cloud.tencent.com/asr/replaceword
- 并发购买：https://buy.cloud.tencent.com/asr
- 官方 SDK：
  - Go: https://github.com/TencentCloud/tencentcloud-speech-sdk-go
  - Python: https://github.com/TencentCloud/tencentcloud-speech-sdk-python
  - JS: https://github.com/TencentCloud/tencentcloud-speech-sdk-js
  - Java: https://github.com/TencentCloud/tencentcloud-speech-sdk-java
  - C++: https://github.com/TencentCloud/tencentcloud-speech-sdk-cpp
  - .NET: https://github.com/TencentCloud/tencentcloud-speech-sdk-dotnet
