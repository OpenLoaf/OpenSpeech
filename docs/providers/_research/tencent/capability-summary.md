# 腾讯云 OpenSpeech Capability 映射

> 抓取日期：2026-04-28
> 数据全部来自官方文档；每条结论附官方依据 URL。
> 用途：直接喂入 OpenSpeech 的 Provider Capability 矩阵。

---

## 总览矩阵

| Capability | 实时 ASR | 一句话 | 录音文件 | 录音极速版 | 总评 |
|-----------|---------|-------|---------|----------|------|
| `asr.streaming` | ✅ WebSocket | ❌ | ❌（异步） | ❌（同步一次性） | **支持，仅实时识别** |
| `asr.partial` | ✅ `slice_type=1` | ❌ | ❌ | ❌ | **支持，仅实时识别** |
| `asr.server_vad` | ✅ `needvad=1` | n/a | n/a | n/a | **支持** |
| `asr.word_timestamps` | ✅ `word_info≥1` | ✅ `WordInfo≥1` | ✅ `ResTextFormat∈{1..5}` | ✅ `word_info` | **全产品支持** |
| `asr.speaker_diarization` | ❌ | ❌ | ✅ `SpeakerDiarization=1/3` | ✅ `speaker_diarization` | **支持，仅文件类** |
| `asr.language_set` | ✅ 30+ 引擎 | ✅ 22 引擎 | ✅ 32 引擎 | ✅ 同实时 | **覆盖最广的中文 provider 之一** |
| `asr.custom_vocabulary` | ✅ `hotword_id`/`hotword_list` | ✅ | ✅ | ✅ | **全产品支持** |
| `asr.punctuation` | ✅ 默认开 + `filter_punc` 控制 | ✅ | ✅ | ✅ | **全产品支持** |
| `asr.profanity_filter` | ✅ `filter_dirty` | ✅ | ✅ | ✅ | **全产品支持** |
| `llm.translate` | ✅ TMT TextTranslate（18 语种） | — | — | — | **支持** |
| `llm.streaming` | ❌ | — | — | — | **不支持**（TMT 仅同步 REST） |

---

## 1. `asr.streaming` — 实时流式识别

| | 状态 |
|---|------|
| 支持 | ✅ |
| 入口 | 实时语音识别 WebSocket：`wss://asr.cloud.tencent.com/asr/v2/<appid>?...` |
| 协议 | 单向 WebSocket：客户端发送 binary 音频帧；服务端推送 JSON 文本帧 |
| 流结束 | 客户端发 `{"type":"end"}` |
| 实时率约束 | 1 秒最多发 3 秒音频 + 单分片间隔 ≤6s + 客户端空闲 ≤15s |
| 一句话 / 录音文件 | ❌ 这两个产品没有流式语义 |
| 极速版 | ⚠️ 文档自称"准实时"，但本质是**整段上传一次性返回**，没有边推流边出 partial 的能力 |
| **官方依据** | https://cloud.tencent.com/document/product/1093/48982 |

---

## 2. `asr.partial` — 中间结果

| | 状态 |
|---|------|
| 支持 | ✅（仅实时 ASR） |
| 字段 | `result.slice_type`：`1`=非稳态 partial，`2`=稳态 final |
| 词级 partial | `word_list[].stable_flag` 标识词是否稳定 |
| 受限 | 仅实时识别接口；其他产品都是一次性返回，没有 partial 概念 |
| **官方依据** | https://cloud.tencent.com/document/product/1093/48982 |

---

## 3. `asr.server_vad` — 服务端 VAD / 自动断句

| | 状态 |
|---|------|
| 支持 | ✅ |
| 开启方式 | 实时识别 `needvad=1`；音频 >60s **必须**开启 |
| 静音阈值 | `vad_silence_time` 500–2000ms（默认 1000） |
| 强制断句 | `max_speak_time` 5000–90000ms（默认 60000） |
| ⚠️ 限制 | 搜索片段提示 `vad_silence_time` "**目前仅支持 8k_zh 引擎**"，其他引擎是否生效官方文档语焉不详 |
| 一句话 / 文件类 | n/a — 这些场景不需要 VAD |
| **官方依据** | https://cloud.tencent.com/document/product/1093/48982 |

---

## 4. `asr.word_timestamps` — 词级时间戳

| | 状态 |
|---|------|
| 支持 | ✅ 全产品 |
| 实时 ASR | `word_info=0/1/2/100`，返回 `word_list[].start_time/end_time` |
| 一句话 | `WordInfo=0/1/2`，返回 `WordList[].StartTime/EndTime` |
| 录音文件 | `ResTextFormat ∈ {1,2,3,4,5}`，返回 `Words[].OffsetStartMs/OffsetEndMs`（注意是**句内偏移**，不是全局） |
| 极速版 | `word_info`，返回 `sentence_list[].word_list[]` |
| **官方依据** | 见各产品文档（48982 / 35646 / 37823 / 37824 / 52097） |

---

## 5. `asr.speaker_diarization` — 说话人分离 / 角色分离 ⭐

> 这是腾讯在中文 ASR provider 里的招牌能力。

| | 状态 |
|---|------|
| 实时 ASR | ❌ **不支持** —— 实时接口文档无相关字段，产品功能矩阵明确不勾选该能力 |
| 一句话识别 | ❌ 文档未提及（场景 ≤60s 也不适合 diarization） |
| **录音文件 ⭐** | ✅ **完整支持**，分两档： |
| ↳ 单声道说话人分离 | `SpeakerDiarization=1` + `SpeakerNumber=0`(自动) 或 `1–10`(指定，仅 8k 引擎)。引擎白名单：`8k_zh / 8k_zh_large / 16k_zh / 16k_ms / 16k_en / 16k_id / 16k_zh_large / 16k_zh_dialect / 16k_zh_en / 16k_es / 16k_fr / 16k_ja / 16k_ko` |
| ↳ 角色分离（声纹锚定） | `SpeakerDiarization=3` + `SpeakerRoles.N`（`RoleAudioUrl`+`RoleName`），**仅 `16k_zh_en` 引擎**，**仅可传一组声纹**；增值收费 |
| ↳ 双声道分轨 | `ChannelNum=2`，物理隔离，`SpeakerId=0/1` 对应左/右声道；**最佳效果** |
| 录音文件极速版 | ✅ `speaker_diarization` 参数；具体引擎白名单文档未列 |
| 输出字段 | `ResultDetail[].SpeakerId`（Integer）+ `ResultDetail[].SpeakerRoleName`（String，仅角色分离时）|
| **官方依据** | https://cloud.tencent.com/document/product/1093/37823 + https://cloud.tencent.com/document/api/1093/37824 + https://cloud.tencent.com/document/product/1093/52097 |

> OpenSpeech 落地建议：
> - 实时听写场景 → 没有 diarization
> - 会议 / 多人录音 → 走录音文件接口（异步，能接受分钟级延迟）
> - 客服 / 双方电话 → `ChannelNum=2` 双声道分轨
> - 已知主讲人 + 提供声纹样本 → `SpeakerDiarization=3` + 16k_zh_en

---

## 6. `asr.language_set` — 支持语种 / 方言

| | 状态 |
|---|------|
| 支持 | ✅ 中文 ASR 厂商里覆盖最广之一 |
| 中文方言 | 通过大模型版引擎覆盖：`8k_zh_large` 含 28+ 方言；`16k_zh_large` 含 27 方言；`16k_zh_en` 含 9 方言；录音文件还有 `16k_zh_dialect` 23 方言 |
| 粤语 | `16k_yue`（独立）、`8k_zh_large`、`16k_zh_en` 都覆盖 |
| 多语种 | `16k_multi_lang` 支持 15 语种自动识别（en/ja/ko/ar/fil/fr/hi/id/ms/pt/es/th/tr/vi/de），**输入即可混说** |
| 单一外语引擎 | 各语种独立引擎：日/韩/泰/越/印尼/马来/菲/葡/土/阿/西/印地/法/德 |
| 中文垂类 | `16k_zh_medical` / `16k_zh_court` / `16k_zh_edu` |
| 英文垂类 | `16k_en_game` / `16k_en_edu` / `16k_en_large` |
| **auto detect "先识别语种"模式** | ❌ 没有独立的"两步式" auto；多语种走 `16k_multi_lang` 一步混说识别 |
| **官方依据** | https://cloud.tencent.com/document/product/1093/48982（实时） + 37823（录音文件）+ 35646（一句话） |

---

## 7. `asr.custom_vocabulary` — 自定义热词

| | 状态 |
|---|------|
| 支持 | ✅ 全产品 |
| 两种传法 | `hotword_id`（预创建表）/ `hotword_list`（临时） |
| 临时热词上限 | **128 个/请求** |
| 预创建表上限 | **1000 词/表，30 表/账号**，单词 ≤10 字 |
| 权重 | 1–11（11=超级热词）+ 100（同音同调替换，仅 `8k_zh`/`16k_zh`） |
| 优先级 | 同时传两者时**仅 `hotword_list` 生效** |
| 引擎兼容 | 所有中文/英文/粤语模型 |
| **官方依据** | https://cloud.tencent.com/document/product/1093/40996 |

---

## 8. `asr.punctuation` — 自动标点

| | 状态 |
|---|------|
| 支持 | ✅ 全产品（默认开启） |
| 控制方式 | 实时 / 录音文件 / 一句话：`filter_punc` / `FilterPunc`（0/1/2） |
| 实时识别特殊 | `filter_punc=0` 只控制句末句号；中间标点取决于引擎 |
| **官方依据** | 各接口文档参数表 |

---

## 9. `asr.profanity_filter` — 脏话过滤

| | 状态 |
|---|------|
| 支持 | ✅ 全产品 |
| 字段 | `filter_dirty` / `FilterDirty`：0=不过滤；1=完全过滤；2=替换为 `*` |
| **官方依据** | 各接口文档 |

---

## 10. `llm.translate` — 文本翻译

| | 状态 |
|---|------|
| 支持 | ✅ TMT TextTranslate |
| 域名 | `tmt.tencentcloudapi.com` |
| Action | `TextTranslate` Version `2018-03-21` |
| 语种 | 18 个：zh / zh-TW / en / ja / ko / fr / es / it / de / tr / ru / pt / vi / id / th / ms / ar / hi |
| 单次字符上限 | **6000 字符** |
| QPS | 5 次/秒 |
| 自动语种检测 | 接口本身**不接受 `auto`**；需先调 `LanguageDetect` |
| 单价 | 58 元/百万字符（≤100M/月）/ 50 元/百万字符（>100M/月）；月免费 500 万字符 |
| **官方依据** | https://cloud.tencent.com/document/product/551/15619 + https://cloud.tencent.com/document/product/551/35017 |

---

## 11. `llm.streaming` — 翻译流式输出

| | 状态 |
|---|------|
| 支持 | ❌ **不支持** |
| 依据 | TextTranslate 接口文档无任何 streaming / SSE 描述；接口为同步 REST |
| 替代 | `SpeechTranslate` 接口提供"分片上传 + 流式翻译"，但官方在线文档当前不可正常渲染（页面 SPA 异常），且场景是 PCM 音频翻译不是文本流式翻译；OpenSpeech 不建议依赖 |
| **官方依据** | https://cloud.tencent.com/document/product/551/15619（接口规范，无流式字段） |

---

## 12. 官方文档语焉不详 / 模糊地带

OpenSpeech 接 SDK 时一定会撞到的灰区：

| 项 | 现状 | 处理建议 |
|---|------|---------|
| 实时识别**单连接最长时长** | 文档只约束单句 90s + 空闲 15s + 实时率，**整连无显式上限** | 实测 + 主动断重连（如每 4 小时滚动） |
| 录音文件**并发任务上限** | 文档只说提交频率 20/s，并发任务总数未列 | 实测 + 联系客户经理 |
| 极速版**说话人分离引擎白名单** | 文档说支持但未列具体引擎 | 默认按录音文件接口的白名单试 |
| 角色分离 / 情绪识别 / 口语转书面语**单价** | "增值收费"但在线计费页未列单价 | 控制台或 https://buy.cloud.tencent.com/asr 查 SKU |
| 方言 / 医疗 / 法庭引擎是否**加价** | 在线计费页未明确说明 | 假定按大模型版定价（4.80 元/小时起），实测对账 |
| LanguageDetect**字符上限 / 支持语种枚举** | 页面 SSR 异常无法直接确认 | 默认按 TMT 18 语种 + 文本 6000 字符上限 |
| ASR 多 Region | 公共参数仅列 `ap-guangzhou` | 用主域 `asr.tencentcloudapi.com` 即可，无需 region 字段 |
| `vad_silence_time` 仅支持 `8k_zh` 的限制 | 来自搜索片段，主接口页未复述 | 其他引擎默认采用引擎自带断句策略，不要传该参数 |

---

## 13. 一图流（OpenSpeech 接入决策树）

```
用户场景
├─ 实时听写 / 边说边出字
│   └─ 实时语音识别 (WebSocket)
│       ✅ partial / VAD / 词级时间戳 / 热词
│       ❌ 说话人分离
│
├─ 短语音 ≤60s（单次命令、按住说话）
│   └─ 一句话识别 (REST)
│       ✅ 词级时间戳 / 热词 / 数字归一化
│       ❌ 说话人分离 / partial
│
├─ 整段上传，对延迟敏感（短视频字幕、客户端转写）
│   └─ 录音文件极速版 (HTTPS)
│       ✅ 词级时间戳 / 说话人分离 / 热词
│       ❌ partial（一次性同步返回）
│
├─ 长录音、对延迟不敏感（会议、播客、采访）
│   └─ 录音文件识别 (异步) ⭐
│       ✅ 完整说话人分离 + 角色分离 + NLP 分段 + 口语转书面语
│
└─ 翻译（基于上面任一识别结果的文本）
    └─ TMT TextTranslate (REST)
        ✅ 18 语种 / 6000 字符/次
        ❌ 流式
```
