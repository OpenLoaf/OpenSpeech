# Provider 官方文档调研索引

> 抓取日期：2026-04-28
> 抓取方式：Claude Code 子 agent + WebSearch / WebFetch，强制只接受官方域名。
> 用途：为 [`docs/speech-providers.md`](../../speech-providers.md) §6 Capability 矩阵提供事实依据；后续写 Rust adapter 的接入参考。

## 1. 完成度与可信度

| Vendor | 抓取方式 | 文件数 | 可信度 | 说明 |
|---|---|---|---|---|
| **Tencent** | WebFetch 直读 + WebSearch 补充 | 7 | **高** | 官方文档页基本能直读；个别 SPA 页面 SSR 异常用 SERP 片段补全 |
| **Azure** | WebFetch 直读 + WebSearch 补充 | 10 | **高** | learn.microsoft.com 大部分页面可直读；定价页被网络拦截，用 list-price 估算 |
| **Google** | **几乎全部 WebSearch 摘要**（直读受阻） | 9 | **中** | 本机环境 `cloud.google.com` 全部 301→`docs.cloud.google.com` 后被 SSL 阻断；事实来自官方页 SERP 摘要，仍是官方源但**字段细节需在可达环境复核** |
| **OpenAI** | **几乎全部 WebSearch 摘要**（直读受阻） | 7 | **中** | 本机环境对 `platform.openai.com` 等所有 OpenAI 域名 fetch 被拒；事实来自 SERP 官方摘要 |

> 后续行动：在能直访 cloud.google.com / platform.openai.com 的网络环境里把这两家的 capability-summary 复核一遍——特别是字段名、上限数值、模型名称。

## 2. 目录结构

```
_research/
├── README.md                       本文件
├── tencent/                        高可信度
│   ├── README.md
│   ├── asr-realtime.md             实时 WebSocket 识别
│   ├── asr-sentence.md             一句话识别 REST
│   ├── asr-recording.md            录音文件识别（含极速版）
│   ├── translation.md              翻译君 TMT
│   ├── auth-and-billing.md         鉴权 + 计费
│   └── capability-summary.md       ★ 核心交付物
├── azure/                          高可信度
│   ├── README.md
│   ├── speech-realtime.md          实时 SDK + WebSocket
│   ├── speech-rest-short.md        短音频 REST
│   ├── speech-batch.md             异步批量
│   ├── speech-fast-transcription.md Fast Transcription
│   ├── speech-translation.md       Speech Translation（SDK 独占）
│   ├── translator.md               独立 Translator 服务
│   ├── azure-openai.md             Azure OpenAI 集成
│   ├── auth-and-billing.md
│   └── capability-summary.md       ★ 核心交付物
├── google/                         中可信度（需复核）
│   ├── README.md
│   ├── speech-v2-streaming.md
│   ├── speech-v2-recognize.md
│   ├── speech-v2-batch.md
│   ├── speech-v1-vs-v2.md
│   ├── translation.md              Cloud Translation Basic + Advanced
│   ├── gemini-api.md               Gemini API + Vertex
│   ├── auth-and-billing.md
│   └── capability-summary.md       ★ 核心交付物
└── openai/                         中可信度（需复核）
    ├── README.md
    ├── audio-transcriptions.md     Whisper / gpt-4o-transcribe
    ├── audio-translations.md       Whisper → 英文
    ├── realtime-api.md             Realtime WebSocket
    ├── chat-completions.md
    ├── auth-and-billing.md
    └── capability-summary.md       ★ 核心交付物（双栏 A/B）
```

## 3. 跨 vendor 的关键发现（直接影响主架构设计）

下面 7 条是把 4 份 summary 横向对比后浮出来的**跨 provider 事实**，主文档 §6 / §8 / §10 都要按这些事实修正。

### 3.1 `asr.speaker_diarization` 在实时听写场景下基本不可得

> 这一条直接颠覆了之前"切到腾讯就支持说话人分离"的假设。

| Provider | 实时路径 | 异步 / 批量路径 |
|---|---|---|
| Tencent | ❌ 实时 ASR / 一句话识别都不支持 | ✅ 仅录音文件接口 |
| Azure | ⚠️ 仅 `ConversationTranscriber`（独立 SDK 入口）+ 单 session ≤ 240min | ✅ Fast / Batch 都支持 |
| Google | ⚠️ V2 sync + streaming 都标支持，但 chirp 系列具体兼容性官方未明示 | ✅ Batch 支持 |
| OpenAI | ❌ Realtime API 不支持（diarize 模型仅在 `/v1/audio/transcriptions`） | ✅ `gpt-4o-transcribe-diarize` |

**架构含义**：
- §6 capability 维度需要从"provider"细化到"(provider × 协议路径)"——同一个 provider 不同 endpoint capability 不同。
- §8 引导对话框列出"支持说话人分离的 provider"时，必须同步说明"用户场景 = 实时听写"下没有任何 provider 真正支持，要走异步路径意味着延迟分钟级。
- 现阶段建议：把 `asr.speaker_diarization` 标为"实时路径全员 Unsupported / Limited"，等真正上"会议模式"feature 时再单独评估异步路径。

### 3.2 流式都有硬上限，必须客户端 endless streaming

| Provider | 单流上限 | 应对 |
|---|---|---|
| Tencent | 单句 90s + 空闲 15s + 实时率约束；整连无显式上限 | 滚动重连（每 4h） |
| Azure | `ConversationTranscriber` 单 session ≤ 240min；普通 STT 无明示 | 240min 到点重连 |
| Google | **V2 streaming 单 stream ≤ 5 min**（最严） | 必须客户端切流，Google 官方提供 endless streaming 模板 |
| OpenAI Realtime | 公开文档未给具体并发数，受 tier 控制 | 实测后定 |

**架构含义**：`SessionHandle` trait 要从一开始就建模"重连"——不能假设单 session 一次开到底。

### 3.3 没有 first-party Rust SDK 的 provider 占多数

| Provider | Rust SDK | 替代 |
|---|---|---|
| Tencent | ❌ | 自实现 HMAC-SHA1（实时） + TC3-HMAC-SHA256（其他）签名 |
| Azure | ❌ | 自实现 WebSocket / REST，或 FFI 调 Microsoft Speech C SDK |
| Google | ❌ | tonic + 官方 protobuf；或走 OpenAI compat 层 |
| OpenAI | ❌（只有官方 Python / Node / Go / .NET） | 自实现 REST + WebSocket，社区 `async-openai` 等不算官方 |

**架构含义**：
- adapter 层统一用 `reqwest` (rustls) + `tokio-tungstenite` 自实现，不要为某个 vendor 引入 FFI / 大号官方 SDK；
- 4 家签名 / 鉴权风格各异（HMAC-SHA1 / TC3-HMAC-SHA256 / Bearer / API Key / OAuth），公共代码只能抽到"加 header / 拼 URL"层。

### 3.4 Speech Translation（ASR 同流翻译）几乎是 Azure 独家

| Provider | inline ASR + 翻译 |
|---|---|
| Azure | ✅ Speech Translation SDK（partial 也翻译） |
| Tencent | ⚠️ `SpeechTranslate` 接口存在但官方在线文档当前 SPA 渲染异常 |
| Google | ❌ Cloud Translation 完全无 streaming；要边出边翻只能走 Gemini 通用 LLM |
| OpenAI | ❌ Audio Translations 仅"音频→英文"一次性，无 stream；其他翻译都靠 LLM prompt |

**架构含义**：§8 翻译 feature 在 LOCAL 模式下基本都走 compose 路径（ASR + LLM 二段）；只有 Azure 一家可以走 inline。在 capability 报告里这是 `llm.translate` 的 sub-flag，要单独建模 `inline_speech_translation` 还是用 note 表达，需要决策。

### 3.5 自定义词典上限差异巨大

| Provider | 上限 | 备注 |
|---|---|---|
| Tencent | 临时 128/请求；预创建 1000/表，30 表 | 单词 ≤10 字 |
| Azure | **500 phrases**（real-time / fast 路径） | Batch **不支持** phrase list；超 500 需走 Custom Speech 训练 |
| Google | PhraseSet boost 0-20 | 具体上限官方文档未给统一数字 |
| OpenAI | **没有持久化词典**，只能 prompt | whisper-1 限 prompt 末尾 224 token |

**架构含义**：[`docs/dictionary.md`](../../dictionary.md) 现有的"100 条" 硬上限要改写为：取 `min(provider上限, 100)`，并在 settings 词典页对超额条目灰显说明。OpenAI 路径下词典 UI 可填但 hints 的实际机制完全不同（prompt 注入而非词表上传）。

### 3.6 OpenAI byo-rest 不再纯"非流式"

我们原 §5 计划把 `byo-rest` 当"放弃 streaming 的兜底"，但 OpenAI 已经更新：
- `whisper-1` 仍然只支持整段上传同步返回
- `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` 已支持 `stream=true` → SSE delta（`transcript.text.delta`）

**架构含义**：要么把 `byo-rest` 拆成 `byo-rest-batch`（Whisper 风）+ `byo-openai-stream`（gpt-4o-transcribe 风）两个 adapter；要么在同 adapter 内按用户配置的 model 字段动态报告 capability（这与 §6.0 "三态非布尔" 的精神更一致）。倾向后者。

### 3.7 Profanity filter 是 Azure / Google / Tencent 普遍能力，OpenAI 没有

| Provider | 支持 |
|---|---|
| Tencent | ✅ `filter_dirty` 0/1/2 |
| Azure | ✅ masked/removed/raw（Fast/Batch 多一档 Tags） |
| Google | ✅ `profanity_filter=true`（首字母+`*`） |
| OpenAI | ❌ 两路径都无 |

**架构含义**：本来在 §6.4 "不进枚举的伪 capability" 里提过 profanity filter 列得勉强；现在看 4 家里 3 家都有，是真正离散的能力，应保留在枚举里。OpenAI 走"应用层后处理"或不暴露。

## 4. 主文档需要回写的项

跨 vendor 调研出的结论应回填到 [`../../speech-providers.md`](../../speech-providers.md)：

| 主文档位置 | 回填内容 |
|---|---|
| §6.2 ASR 详条 | `asr.speaker_diarization` 缺失策略改为"实时全 Unsupported"；`asr.streaming` 加"单流上限与重连"段 |
| §6.5 Provider × Capability 矩阵 | 用本目录 4 份 capability-summary 的真实值替换"靠常识"的占位值 |
| §6.6 language_set | 4 家真实语种数 / 自动检测能力 |
| §7.1 Trait 草案 | `SessionHandle` 加 `should_reconnect()` / `reconnect()` 方法 |
| §8.4 缺失策略表 | 翻译"compose vs inline"区分要明确"仅 Azure 路径有 inline" |
| §11 隐私边界 | 4 家真实 endpoint 域名 |
| §16 风险 | 加"Rust SDK 缺位 → 全部自实现签名层" |

## 5. 后续 TODO

- [ ] 在能直访 cloud.google.com / platform.openai.com 的网络环境复核 Google / OpenAI 这两份 summary（特别是字段名、模型名、上限数值）
- [ ] 阿里云这次未抓——它是当前 OpenLoaf SaaS 后端的实际 provider，单独再做一份 `_research/aliyun/`
- [ ] 给 `docs/providers/<id>.md` 写用户向文档（账号注册流程、key 获取、定价、隐私链接），与 capability-summary 互相引用
