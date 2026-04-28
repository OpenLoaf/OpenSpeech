# 语音引擎 Provider 抽象规划

> 状态：**规划中（未实现）**。本文档定义目标架构，后续实现 PR 必须以本文为契约。
> 影响范围：listening / transcribing / translating / asking 全链路；settings 模型 tab；privacy；subscription；onboarding；history schema。

## 1. 背景

当前 OpenSpeech 只跑一条转写路径：登录 OpenLoaf → realtime ASR（V4 `OL-TL-RT-002`。问 AI 与翻译同样收敛到 OpenLoaf v4 工具。

Settings 早期预留了 `dictationSource: "SAAS" | "BYO"` 与 `endpoint` / `endpointKey` 字段（见 `settings.md` 大模型 tab），`recording.ts` 的 Gate 也按二者择一判定（见 `voice-input-flow.md` 触发 §5），但 BYO 这条线**始终没接到任何真实 provider**——它是个挖好的扩展槽。

我们现在要把这个槽变成一等公民：

1. 用户**不登录也能用**——只要本地配了一个真实 provider；
2. 同时存在多个 provider 可选（阿里 / 腾讯 / Azure / Google / 自定义 REST）；
3. 各 provider 能力差异是**显式且用户可见**的，而不是悄悄失败；
4. 项目已开源，第三方贡献者**可以以 Rust 模块的形式**追加新 provider，进 PR 后下一个 release 即可使用。

## 2. 目标 / 非目标

### 目标

- 把 "STT engine" 与 "LLM engine" 从主流程中抽离成两类接口（trait），主流程对 provider 完全无感。
- 一套**离散 Capability 枚举**作为唯一的能力描述维度；每个 Adapter 自报清单。
- 用户在 Settings 选定 (Mode × ASR Provider × LLM Provider) 三元组（"Profile"）；切换**热生效**。
- 缺能力时按既定策略降级（见 §8），不能跑就 graceful block + 列出该能力支持的 provider。
- 仓库内 `src-tauri/src/providers/` 子目录是开源贡献入口，含模板与契约清单。

### 非目标（本期不做，但接口要给后续留空间）

- **不做** 远程动态加载（dylib / wasm）。新 provider 走"PR 进仓库 → 跟随版本发布"。
- **不做** provider 自动选优 / benchmark / A/B 切换。
- **不做** Provider 之间的代理 / 中转转发——LOCAL 模式 100% 直连用户配置的服务商。
- **不做** 用户多账号下不同 provider 同步（设置仍是单机本地）。
- **不做** 团队 / 组织级 provider 模板下发。

## 3. 术语

| 术语 | 含义 |
|---|---|
| **Mode** | 顶层选项，二选一：`CLOUD` = 走 OpenLoaf 托管推理（必须登录、按积分计费）；`LOCAL` = 走用户在本地配置的 provider（无需登录、流量直达服务商、用户自付费）。 |
| **Engine** | 两条独立通道：`ASR`（语音 → 文本）和 `LLM`（文本 → 文本，承担翻译 / 问 AI / 润色）。各自独立选 provider，不强绑。 |
| **Provider** | Engine 背后的服务商标识，如 `openloaf-cloud` / `aliyun` / `tencent` / `azure` / `google` / `byo-rest`。 |
| **Adapter** | Provider 的 Rust 实现，遵循 `SpeechAdapter` 或 `LlmAdapter` trait。**provider ↔ adapter 一对一**。 |
| **Capability** | 离散能力枚举（见 §6），描述一个 Adapter 能做什么。 |
| **Profile** | 当前生效的 `(Mode, AsrProvider, LlmProvider)` 三元组，是状态机的输入。 |
| **Capability Gap** | 用户当前 Profile 缺少某 feature 所需的 capability，需要降级或拒绝执行。 |

## 4. 双轴模型（Mode × Provider）

设计核心：**Mode** 决定**谁付费 / 谁鉴权 / 数据流向哪**；**Provider** 决定**实际接谁的协议**。两者正交。

| | 鉴权 | 计费 | 配置项 | 数据流 |
|---|---|---|---|---|
| **CLOUD** | 必须登录 OpenLoaf | OpenLoaf 积分（详见 [subscription.md](./subscription.md)）| 不需要 | 客户端 → OpenLoaf 后端 → SaaS 内部选择的实际 provider |
| **LOCAL** | 不需要登录 OpenLoaf | 用户在所选 provider 处自付 | 必填：每个 provider 的 endpoint / API Key / region 等 | 客户端直连用户选定的 provider |

> **CLOUD 的 Provider 对用户不可见**，由 SaaS 后端决定（目前 = 阿里 Qwen3-ASR-Flash-Realtime，未来可能混合多家以提升某类能力）。客户端只能看到一个统一品牌 `openloaf-cloud`。
>
> **LOCAL 的 Provider 用户必选且可换**，是本设计的主战场。

## 5. Provider 矩阵（首批接入计划）

| Provider ID | Mode | ASR | LLM | 推荐用途 | 备注 |
|---|---|---|---|---|---|
| `openloaf-cloud` | CLOUD | ✅ realtime | ✅ 翻译 / 问 AI | **默认**，零配置 | 计费经 OpenLoaf 积分；详见 [subscription.md](./subscription.md) |
| `aliyun` | LOCAL | ✅ realtime（Paraformer Realtime / Qwen3-ASR）| ✅ 通义千问翻译 | 中文为主 + 已有阿里账号 | WebSocket 协议；需 AccessKey ID/Secret |
| `tencent` | LOCAL | ✅ realtime（一句话识别 / 实时语音识别）| ⚠️ 翻译走腾讯翻译君 REST | 中文为主 + 需要说话人分离 | WebSocket；SecretId/Key |
| `azure` | LOCAL | ✅ realtime（Speech SDK）| ✅ 内嵌翻译（Speech Translation） | 多语种 + 内嵌翻译 | Azure region + Key；翻译可与 ASR 同流 |
| `google` | LOCAL | ✅ streaming v2 | ⚠️ 翻译需独配 Cloud Translation | 多语种 + 已用 GCP | gRPC 或 REST；Service Account JSON |
| `byo-rest` | LOCAL | ⚠️ 仅批量（非流式） | ❌ | OpenAI Whisper / 本地 faster-whisper 等通用 REST | 兜底入口；放弃 partial / streaming |

> 本表是**首批接入目标**，不是穷举。OpenAI Whisper 走 `byo-rest`；Deepgram / AssemblyAI 等留给社区按 §14 流程贡献。

## 6. Capability 矩阵

> **本节是整个抽象的地基**。Capability 是闭集枚举，主流程的所有 feature gate / 降级 / 引导 / settings 预览都从这张表派生。命名 / 边界 / 取值一旦确定，后续新增 adapter 与新 feature 都按这张表对齐——错了一处会贯穿前后端。

### 6.0 设计原则（先于具体清单）

定义 Capability 之前，先固定 5 条原则。新增任何 capability 前对照检查，命中其中一条就要重新评估。

1. **正交、最小、不可再分**：每个 capability 描述**一种独立的事实**。如果 capability A 的支持情况永远跟着 B 走（A 真 ⇒ B 真，反之亦然），那 A 就该并到 B 里，而不是再开一个。例：`asr.partial` 与 `asr.streaming` 在概念上有相关性，但确实存在"streaming 但只在结束时给一个 final"的实现（早期 batch over WebSocket），所以保留两个 capability。
2. **必须能可靠探测 / 文档化**：一个 capability 必须能从 provider 官方文档明确确认，或通过握手 / 试探请求探测出真假。无法判别的能力（如"准确率高不高"）不进枚举。
3. **粒度服务于决策，不服务于描述**：是否要拆出新 capability，问"这能影响 §8 决策树的输出吗 / 影响 settings 预览面板上某一行吗"。能 → 拆；不能 → 别拆。例：不要拆 `asr.cantonese` / `asr.japanese` 等"语种支持"——粒度太细，应统一用 `asr.language_set` 报告语种集合。
4. **三态值，不是布尔**：每个 (provider × capability) 的取值是 `Supported | Limited | Unsupported`，**不是** boolean。`Limited` 必须附 `note`（一句话约束，例"仅普通话 + 英语"、"需用户额外开通"），UI 与决策器都要消费这个 note。
5. **闭集 + 版本化**：枚举集合在仓库里是 `enum` 常量，**不是字符串**；adapter 只能从枚举里挑值，不能写自由字符串。每次扩枚举都同时改本文档 §6.1 + §6.2。

### 6.1 Capability 数据结构

```text
enum CapabilityValue {
    Supported,                        // 原生完整支持
    Limited { note_i18n_key: String },// 受限，UI 必须显示 note
    Unsupported,                      // 不支持
    NotApplicable,                    // 该 capability 对此 adapter 没意义（如非流式 adapter 的 server_vad）
}

struct CapabilityReport {
    asr: BTreeMap<AsrCapability, CapabilityValue>,
    llm: BTreeMap<LlmCapability, CapabilityValue>,
    /// 静态报告还是运行时报告：openloaf-cloud 后端可能动态切换 provider，
    /// 报告由 SaaS 下发；其他 adapter 都是编译期 const。
    is_dynamic: bool,
}
```

> **为什么是三态而不是布尔**：很多 capability 的真实状态就是"半支持"。例：腾讯 ASR 支持热词但有"100 条 / 4 字符"上限；Azure 翻译能 inline，但仅在选了 `Speech Translation` 端点时；OpenLoaf 的说话人分离接口存在但 SaaS 当前未对外开放。布尔表达不出这些事实，决策器会要么过度乐观（用了崩）要么过度保守（用户说"明明能用"）。

### 6.2 ASR Capability 详表

每条 capability 都给出：**含义**（一句话）、**用户可见行为**（影响哪个用户场景）、**判定依据**（如何确定 provider 是否支持）、**默认缺失策略**（在 §8 决策树中走哪条分支）。

#### `asr.streaming`
- **含义**：通过持久连接（WebSocket/gRPC）边录边送音频帧，服务端不要求整段上传。
- **用户可见行为**：长录音不阻塞 UI；松手后等待时间 ≤ 1s（finalize 拿尾巴）。无此能力 ⇒ 录音必须先全部落盘 → 整段 upload → 等待返回，松手到出字之间 1.5s + 网络。
- **判定依据**：provider 文档是否提供 streaming endpoint。
- **缺失策略**：核心能力。听写主流程要求此 capability；缺失 ⇒ §8 引导路径，**不**走 compose。`byo-rest` 例外（明确兜底走非流式整段上传）。

#### `asr.partial`
- **含义**：streaming 期间服务端持续推送中间结果（partial transcript），final 之前用户能看到字在变。
- **用户可见行为**：录音时悬浮条 / Live 面板有"边说边出字"效果；AUTO 分段模式下还能边说边注入（[voice-input-flow.md](./voice-input-flow.md) 注入 §1）。
- **判定依据**：streaming 协议是否定义 partial event。
- **缺失策略**：静默降级。Live 面板从"流字"变为"finalize 后一次性出现"；recording.ts 的 `injectIncremental` 自动跳过。**不弹提示**——这只是体验差异不是错误。

#### `asr.server_vad`
- **含义**：服务端按停顿自动切句，一次 session 内可能产出多段 final（每段独立 sentence_id）。
- **用户可见行为**：影响 settings → "听写分段模式"（AUTO / MANUAL）选项是否可用（详见 `src/stores/settings.ts` 的 `asrSegmentMode`）。无此能力 ⇒ 该选项强制 MANUAL 灰显。
- **判定依据**：provider 文档是否提供 server-side VAD 配置；客户端是否能收到多段 final 事件。
- **缺失策略**：静默降级到 MANUAL 模式 + settings 该项灰显并显示 tooltip "当前 provider 不支持自动切句"。

#### `asr.word_timestamps`
- **含义**：每个识别词附时间戳（开始 / 结束 ms）。
- **用户可见行为**：未来字幕导出 / 历史回放对齐 / 编辑器精修——MVP 阶段无 UI 直接消费。
- **判定依据**：协议事件中是否带 word-level offset。
- **缺失策略**：能力级降级。即使支持的 provider 也只在用户开启对应 feature 时启用（数据量大）。MVP 阶段全部 adapter 报告均不影响行为。

#### `asr.speaker_diarization`
- **含义**：识别"有几个说话人"并给每段文字打 `speaker_id`（A / B / C…）。
- **用户可见行为**：Live 面板 / 历史详情显示 `[A] xxx [B] yyy`；可能配合"会议模式" feature。MVP 阶段未上 feature，但 capability 必须先建模——否则 provider 切换 UI 没法显示这一行差异。
- **判定依据**：provider 文档是否提供说话人分离参数 + 协议事件是否含 `speaker_id`。
- **缺失策略**：§8 引导路径。不能由组合补齐（文本后处理无法还原说话人）。
- **本期落地**：capability 进枚举、进矩阵、进 settings 预览面板（"✗ 说话人分离 — 当前 provider 不支持，支持的 provider: ..."），但**不绑任何用户 feature**。等 capability 先稳定，再上 feature。

#### `asr.language_set`
- **含义**：provider 支持的语种集合（取代之前简单的 `language_detect`）。值为 `Vec<BCP47>`，附一个 `auto_detect: bool` 标记是否支持自动检测。
- **用户可见行为**：settings → "听写语种" 下拉的可选项 = 当前 active asr provider 的 `language_set`；auto_detect=false 时下拉强制必选。
- **判定依据**：provider 文档列表 + 自动检测能力。
- **缺失策略**：不可能"缺失"——所有 ASR 都至少支持一个语种。但语种**不在用户期望集合内**时（用户在 settings 选了 yue 而当前 provider 不支持），切 provider 时弹"当前语种不可用，将回退到 zh-CN"。
- **特殊**：这是少数**带载荷**的 capability。不是简单 enum 值。CapabilityReport 里单独建模为 `language_set: LanguageSetReport`，不走 BTreeMap。

#### `asr.custom_vocabulary`
- **含义**：接受词典 hints 提升专名 / 行业术语准确率（详见 [dictionary.md](./dictionary.md)）。
- **用户可见行为**：[词典页](./dictionary.md) 仍可正常增删查；hints 是否真的传给 provider 由此 capability 决定。
- **判定依据**：provider 是否提供热词 / phrase hints / custom vocabulary 接口。
- **特别注意**：各家 hints 上限差异大（OpenAI 不支持 / 阿里 100 / 腾讯 100×4 字符 / Azure 1000 / Google 5000）。`Limited { note: "上限 100 条" }` 表达。adapter 内部按上限截断，dictionary.md 的"100 条"硬上限改为"取 min(provider上限, 100)"。
- **缺失策略**：静默降级（hints 不发，词典 UI 仍可填）+ settings 提示一行。

#### `asr.punctuation`
- **含义**：自动加标点。
- **缺失策略**：静默降级。MVP 不为此再加二次后处理（text 后插标点的 LLM 调用得不偿失）。

#### `asr.profanity_filter`
- **含义**：服务端可配的脏话过滤（替换 / 屏蔽 / 标记）。
- **缺失策略**：MVP 不暴露给用户；capability 先建模，feature 留待社区诉求。

### 6.3 LLM Capability 详表

#### `llm.translate`
- **含义**：把任意文本翻译到指定目标语种。
- **用户可见行为**：F9 翻译快捷键。
- **判定依据**：provider 是否提供翻译接口（独立 endpoint 也算）。
- **缺失策略**：§8 compose 路径——LLM provider 选 None ⇒ 翻译 feature 走 §8.3 引导。

#### `llm.qa`
- **含义**：自由文本 → 自由文本回答。
- **用户可见行为**：F8 问 AI。
- **缺失策略**：同上。

#### `llm.polish`
- **含义**：把识别文本润色（删除口误 / 填充词 / 改口）。
- **用户可见行为**：F15 AI 自动润色。
- **缺失策略**：静默降级（不润色直出）。

#### `llm.context_style`
- **含义**：接受上下文风格 prompt（"邮件" / "IM" / "代码注释"等）。
- **用户可见行为**：F16 上下文风格。
- **缺失策略**：静默降级（prompt 不发）。

#### `llm.streaming`
- **含义**：LLM 输出是否流式 token。
- **用户可见行为**：翻译 / 问 AI 的"边出边写"。
- **缺失策略**：静默降级（攒齐再注入）。

### 6.4 不进枚举的"伪 capability"

记录**评估过但决定不进枚举**的能力，避免后续 PR 反复讨论：

| 想加的 | 不加的理由 |
|---|---|
| `asr.cantonese` / `asr.japanese` 等单语种 | 应该用 `asr.language_set` 统一表达，不要每语种一个枚举值 |
| `asr.high_accuracy` / `asr.low_latency` | 不可观测，无法机器判定，属于"营销描述" |
| `asr.long_form_friendly` | 模糊，应拆为 `asr.streaming` + 是否有时长上限两件事 |
| `llm.code_friendly` | 模糊，所有现代 LLM 都"懂代码"；要做代码场景应做成上下文 prompt |
| `provider.free_tier` | 跟用户决策有关（值不值得选）但跟主流程逻辑无关，应放 `docs/providers/<id>.md` 而不是 capability |
| `provider.region_china` / `region_us` | 同上，落 `docs/providers/<id>.md` |

### 6.5 首批 Provider × Capability 映射

> 取值：`✓` = `Supported`；`L:<note>` = `Limited`（note 简写）；`✗` = `Unsupported`；`–` = `NotApplicable`。**新 adapter PR 必改**。

#### ASR

| Capability | openloaf-cloud | aliyun | tencent | azure | google | byo-rest |
|---|---|---|---|---|---|---|
| `asr.streaming` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| `asr.partial` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `asr.server_vad` | ✓ | ✓ | ✓ | ✓ | ✓ | – |
| `asr.word_timestamps` | L:动态 | ✓ | ✓ | ✓ | ✓ | – |
| `asr.speaker_diarization` | L:不开放 | ✗ | ✓ | ✓ | ✓ | ✗ |
| `asr.language_set` | 见 §6.6 | 见 §6.6 | 见 §6.6 | 见 §6.6 | 见 §6.6 | 见 §6.6 |
| `asr.custom_vocabulary` | ✓ | L:100 条 | L:100×4字 | ✓ | ✓ | L:按 endpoint |
| `asr.punctuation` | ✓ | ✓ | ✓ | ✓ | ✓ | L:按 endpoint |
| `asr.profanity_filter` | ✗ | ✗ | ✗ | ✓ | ✓ | ✗ |

#### LLM

| Capability | openloaf-cloud | aliyun | tencent | azure | google | byo-rest |
|---|---|---|---|---|---|---|
| `llm.translate` | ✓ | ✓ | L:独立 endpoint | ✓ inline | L:Cloud Translation 独配 | ✗ |
| `llm.qa` | ✓ | ✓ | ✓ | L:Azure OpenAI 独配 | ✓ | ✗ |
| `llm.polish` | ✓ | ✓ | ✓ | L:同上 | ✓ | ✗ |
| `llm.context_style` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |
| `llm.streaming` | ✓ | ✓ | ✓ | ✓ | ✓ | ✗ |

### 6.6 `language_set` 初始声明

| Provider | 语种集合 | auto_detect |
|---|---|---|
| openloaf-cloud | zh / zh-TW / en / ja / ko / yue | ✓ |
| aliyun | zh / zh-TW / en / ja / ko / yue | ✓ |
| tencent | zh / en / yue（其余按模型变体）| ✓（限语种集）|
| azure | 100+ BCP47 全集（按 region 变化）| ✓ |
| google | 125+ BCP47 全集 | ✓ |
| byo-rest | 由 endpoint 决定，adapter 配置里手填 | 按配置 |

### 6.7 Feature → Capability 反向索引

主流程的 feature 不直接绑 provider，而是绑 capability。一张反查表，写代码 / 加 feature 都查这里：

| Feature | 必需 | 增强（缺失时静默降级） | 引导（缺失时弹 dialog） |
|---|---|---|---|
| 听写（基础） | `asr.streaming` (byo-rest 特例) | `asr.partial` / `asr.punctuation` | — |
| 听写分段 AUTO | `asr.streaming` + `asr.server_vad` | — | `asr.server_vad` 缺失时灰显 settings 选项 |
| 词典 hints | — | `asr.custom_vocabulary` | — |
| 自动语种检测 | — | `asr.language_set.auto_detect` | — |
| 翻译 | `asr.streaming` + `llm.translate` | `llm.streaming` | `llm.translate` 缺失（LLM 未配）|
| 问 AI | `asr.streaming` + `llm.qa` | `llm.streaming` / `llm.context_style` | `llm.qa` 缺失 |
| AI 润色 | `asr.streaming` | `llm.polish` | — |
| 说话人分离（未来）| `asr.streaming` + `asr.speaker_diarization` | — | `asr.speaker_diarization` 缺失 |
| 字幕导出（未来）| `asr.word_timestamps` | — | `asr.word_timestamps` 缺失 |

### 6.8 演进规则（如何安全地加 / 改 capability）

1. **新加 capability**：
   - 加枚举值 + 本文档 §6.2 / §6.3 详条 + §6.5 矩阵补全（每个现有 adapter 都要给值，不能空）+ §6.7 反向索引。
   - 同 PR 改所有 adapter 的 `capabilities()` 实现（编译器会强制，因为枚举是 exhaustive match）。
   - 加 i18n key（settings 预览面板的 capability 名 + note）。
2. **删 capability**：当且仅当从未真正落地到任何 feature。否则改为 `Deprecated` 阶段（仍枚举但所有 adapter 报 NotApplicable）一个版本，再删。
3. **改 capability 语义**：禁止。要改语义 ⇒ 加新 capability + 老的标 Deprecated。
4. **三态值的迁移**：发现 provider 的真实情况比之前判断更受限，把 `Supported` 改 `Limited { note }`——不算 breaking。从 `Limited` 改 `Unsupported` 是 breaking（用户原本能用的功能不能用了），需要 release note 显式提示。

### 6.9 为什么这套设计现在不定好后面就难

- **Capability 是 settings UI / 录音 Gate / 降级决策 / 历史 schema 的共同输入**——四处都按 capability 取真假。如果 capability 拆得不对，4 处都要重写。
- **adapter PR 的契约就是 `capabilities()` 函数返回值**——枚举一旦发布就成了对外 API，社区的 adapter 都按这个写。后改要么破坏存量、要么需要长期 deprecation 窗口。
- **feature → capability 的映射是闭环依赖**：feature 上线时需要明确"我依赖什么"；capability 上线时需要"哪些 feature 用我"。如果先上 feature 再补 capability，必然出现"feature 已经在 prod 上跑、provider 是否支持靠 if-else 判 provider 名"——回到没抽象前的状态。

所以建议的稳妥次序是：**Phase 1 先把 §6 全枚举 + 静态矩阵全部落地，但 settings UI 先只接 CLOUD**。这样枚举是真的被用起来的（gate / 降级走它），但还没有真实 LOCAL provider 来"考验"枚举设计——可以低成本调整。等 Phase 2 上 aliyun 时再补真实 capability 报告，迭代成本最低。

## 7. Adapter 契约

### 7.1 Trait 草案（Rust）

> 仅作契约描述，签名以实现 PR 为准。

```text
trait SpeechAdapter {
    fn metadata() -> AdapterMetadata;       // id / display_name / homepage / docs
    fn capabilities() -> CapabilitySet;     // 静态能力清单
    fn config_schema() -> JsonSchema;       // settings 表单据此渲染
    async fn validate(config) -> Result;    // "测试连接"按钮调用
    async fn open_session(config, params) -> SessionHandle;
    // SessionHandle 暴露：send_pcm / finish / cancel / events_stream
}

trait LlmAdapter {
    fn metadata() -> AdapterMetadata;
    fn capabilities() -> CapabilitySet;
    fn config_schema() -> JsonSchema;
    async fn translate(config, text, target_lang) -> TextStream;
    async fn answer(config, question, context_hint) -> TextStream;
    async fn polish(config, text) -> String;
}
```

### 7.2 配置 Schema（JSON Schema 子集）

每个 Adapter 自带 schema 描述需要哪些字段，UI 用统一组件渲染（不为每个 provider 写一个表单）。最小可用类型：

- `string`（含 `format: secret` → 走 keyring 不走 store）
- `enum`（下拉）
- `number`（含 min/max）
- `boolean`（开关）
- `region`（带 provider 自带的 region 列表，UI 渲染为 Combobox）

例：阿里云 ASR adapter schema 可能形如：

```text
{
  "endpoint": { "type": "string", "default": "wss://nls-gateway.aliyuncs.com/ws/v1" },
  "appKey":   { "type": "string" },
  "accessKeyId":     { "type": "string" },
  "accessKeySecret": { "type": "string", "format": "secret" },
  "model": { "type": "enum", "values": ["paraformer-realtime-v2", "qwen3-asr-flash-realtime"] }
}
```

> Secret 字段必须存 `keyring`，与现有 `src/lib/secrets.ts` / `src-tauri/src/secrets/*` 一致；非 secret 字段进 `tauri-plugin-store`。

### 7.3 错误模型

统一一组 stable error code，主流程按 code 路由（与现有 `src/lib/errors.ts` 一致）：

| Code | 含义 | 处理 |
|---|---|---|
| `provider.unauthenticated` | 401 / token 失效 / API Key 错 | 弹 settings → 让用户重新填 |
| `provider.network` | 链路不通 / DNS 失败 | toast 提示 + 保留本地录音 |
| `provider.rate_limited` | 429 / 配额满 | toast + 等待 |
| `provider.insufficient_credits` | OpenLoaf 余额不足 | 跳订阅页（详见 subscription.md）|
| `provider.unsupported_capability` | 调用了 adapter 不支持的能力 | 走 §8 降级路径 |
| `provider.invalid_config` | schema 校验失败 | 引导回 settings |
| `provider.server_error` | 5xx | toast |

Adapter 内部错误必须映射到上表，不允许把原始字符串透出来。

## 8. 能力降级策略

### 8.1 两条规则的语义边界

OpenSpeech feature 调用 Adapter 时，按以下决策：

```
feature.required_capabilities ⊆ active_profile.union_capabilities ?
  ├─ Yes → 直接用
  └─ No  → 缺哪类 capability ?
            ├─ 可由 ASR + LLM 组合产生（compose） → 走"二次实现"路径，可能附加 toast 告知
            └─ 只能由特定 provider 原生产生        → 走"功能引导"路径，弹 ProviderCapabilityGapDialog
```

### 8.2 Compose 路径（二次实现）

适用 feature：

- **翻译**：`asr.streaming + llm.translate` → 任意 ASR adapter + 任意 LLM adapter 都可拼。
- **问 AI**：`asr.streaming + llm.qa`。
- **润色**：`asr.streaming + llm.polish`。

规则：

1. ASR Provider 与 LLM Provider 可来自不同服务商（用户自选）。
2. 组合方案的端到端延迟普遍比 inline 实现长 0.3–1.5s——**首次触发**该 feature 时悬浮条 toast 一次："翻译走 ASR + LLM 组合方案"，下次不再提示（per-profile 记忆）。
3. 如果用户**没配 LLM Provider**，该 feature 进入 §8.3 引导路径。

### 8.3 引导路径（功能引导）

适用 capability：`asr.speaker_diarization` / `asr.word_timestamps` / 其他无法由组合等价实现的原生能力。

弹 `ProviderCapabilityGapDialog`，内容：

- 标题："当前语音引擎不支持「说话人分离」"
- 解释："此能力依赖服务商原生输出，无法由文本后处理补齐。"
- 列表："以下 provider 支持此能力：tencent / azure / google"
- 行动按钮：
  - **切回云端**（高亮，主要 CTA，等价于 set Mode = CLOUD）
  - **去设置切换** → 跳 Settings 语音引擎 tab
  - **暂时不用此能力** → 关闭对话框，feature 静默失败本次

> 不允许悄悄跳过用户期望的能力（例如用户开了"显示说话人"但当前 provider 不支持就装作没事）；也不要在每次录音都提示，记住"用户已选择关闭此提示"per-(profile, capability)。

### 8.4 降级 vs 引导的判断表

| Feature | 必需 capability | 可 compose？ | 缺失策略 |
|---|---|---|---|
| 听写（基础） | `asr.streaming` | 否（核心能力） | 阻塞 + 引导 |
| 翻译 | `asr.streaming + llm.translate` | 是 | compose（首次提示一次）|
| 问 AI | `asr.streaming + llm.qa` | 是 | compose |
| AI 润色 | `asr.streaming + llm.polish` | 是 | compose |
| 实时 partial | `asr.partial` | 否 | 静默降级到"松手出整段" |
| 词典 hints | `asr.custom_vocabulary` | 否 | 静默降级（hints 不发，UI 仍可填）|
| 说话人分离（未来）| `asr.speaker_diarization` | 否 | 引导 |
| 词级时间戳（未来）| `asr.word_timestamps` | 否 | 引导 |

## 9. 设置 UX

### 9.1 信息架构

把现有 Settings 的 "大模型（REST）" tab（[settings.md](./settings.md)）替换为 **"语音引擎"** tab，内部分两块：

```
[ 语音引擎 ]
├─ Mode 切换器（segmented：CLOUD / LOCAL）─────────────────────
│
├─ if CLOUD：
│     · 状态卡片：当前账户 + 套餐 + 余额（透传 subscription.md 的展示）
│     · 一行说明："使用 OpenLoaf 托管的语音引擎，按账户积分计费"
│     · 按钮："管理订阅 / 充值 / 退出"
│
└─ if LOCAL：
      · ASR Provider 下拉（必选，列出 §5 中除 openloaf-cloud 外的全部）
      · ASR Provider 配置表单（schema 渲染）
      · "测试连接" 按钮
      · ───────────────────────────
      · LLM Provider 下拉（可选，None / 各 LLM 适配器）
      · LLM Provider 配置表单
      · "测试连接" 按钮
      · ───────────────────────────
      · Capability 预览面板（实时刷新，见 §9.2）

[ 共通 ] 显著横幅："LOCAL 模式下音频将直接发送到你选择的服务商，请确认其数据政策"（与 [privacy.md](./privacy.md) 第 §"传输给第三方大模型的规则" 联动）
```

### 9.2 Capability 预览面板

设置页右侧（或表单下方）实时显示当前 Profile 能做什么：

```
当前 Profile 支持：
  ✓ 听写（实时 partial）
  ✓ 翻译  ─ 走 ASR + LLM 组合（约 +0.5s 延迟）
  ✗ 说话人分离 ─ 当前 provider 不支持
              ↳ 支持的 provider：tencent / azure / google
```

实现：纯前端组件，按 §6.2 矩阵静态渲染，不依赖运行时状态。Provider 切换时立即重算。

### 9.3 字段持久化迁移

现有字段：

```
settings.general.dictationSource: "SAAS" | "BYO"
settings.general.endpoint: string
settings.general.endpointKey (keyring): string
```

迁移到（**BREAKING**，需要 schema migration）：

```
settings.providers.mode: "CLOUD" | "LOCAL"
settings.providers.asr: { providerId: string, config: Record<string, unknown> }
settings.providers.llm: { providerId: string | null, config: Record<string, unknown> }
```

旧字段映射：

- `dictationSource=SAAS` → `mode=CLOUD`
- `dictationSource=BYO` + `endpoint` 非空 → `mode=LOCAL` + `asr.providerId="byo-rest"` + 配置注入到 `asr.config`
- 其他 → 默认 `CLOUD` + 未登录态由原 Gate 兜底

迁移由 `schemaVersion` 升级时一次性跑（设置文件已有 schemaVersion 机制，见 [settings.md](./settings.md) 通用规则 §2）。

## 10. 主流程改造

### 10.1 录音 Gate（取代 [voice-input-flow.md](./voice-input-flow.md) 触发 §5）

```
活跃 Profile = settings.providers.mode + asr + llm
canDictate = active_profile.asr.canStart() && (mode == LOCAL || isAuthenticated)
  ├─ false → 与现有 Gate 一致：弹 LoginDialog 或 settings → 语音引擎 tab
  └─ true  → 进入 preparing → recording
```

`canStart()` 的实现：

- CLOUD：`isAuthenticated && navigator.onLine !== false && healthCheck()`（与现状等价）
- LOCAL：`hasValidConfig() && (lastValidatedAt < 24h || quickValidate())`

### 10.2 STT 接口

`stt_start` invoke 不再写死 `realtime_asr_llm_ol_tl_rt_002`，而是：

```text
stt_start { lang, mode } 
  → providers::registry::active_asr().open_session(lang, mode)
  → SessionHandle 抽象
  → 主流程订阅 SessionHandle.events 把 partial / final / error 等仍然 emit 到当前的
    `openspeech://asr-*` 事件名（保持前端不变）
```

事件名 / payload **不变**，前端 listener（`recording.ts`）零改动。

### 10.3 翻译 / 问 AI / 润色

新增 invoke：

- `llm_translate { text, targetLang }`
- `llm_answer { question, contextHint }`
- `llm_polish { text }`

各自走 `providers::registry::active_llm()` dispatch。LLM provider 为 None 时返回 `provider.unsupported_capability` 错误，主流程走 §8.3 引导。

### 10.4 历史 schema 增量

`history` 表新增：

| 列 | 类型 | 说明 |
|---|---|---|
| `provider_asr` | TEXT | 此条录音转写时使用的 ASR provider id（支持事后追溯）|
| `provider_llm` | TEXT NULL | 翻译/问AI/润色用的 LLM provider id（无则为 NULL）|

新增列做 `ALTER TABLE ... ADD COLUMN`，旧记录 NULL。"重试"按钮：先查当前 active provider，若不同则弹确认"原 provider 已变更，将用 <new> 重试"。

## 11. 隐私边界（与 [privacy.md](./privacy.md) 互锁）

| Mode | Provider | 数据流 | 用户需知情 |
|---|---|---|---|
| CLOUD | openloaf-cloud | 客户端 → OpenLoaf 后端 → SaaS 内部 | 已在登录 / onboarding 告知 |
| LOCAL | aliyun | 客户端 → `nls-gateway.aliyuncs.com`（直连）| 设置页横幅 + onboarding 第一次切到 LOCAL 时 modal |
| LOCAL | tencent | 客户端 → `asr.tencentcloudapi.com` | 同上 |
| LOCAL | azure | 客户端 → `<region>.stt.speech.microsoft.com` | 同上 |
| LOCAL | google | 客户端 → `speech.googleapis.com` | 同上 |
| LOCAL | byo-rest | 客户端 → 用户自填 endpoint | 同上 + 显示当前 endpoint hostname |

更新 `privacy.md` 中"传输给第三方大模型的规则"小节：把"音频数据"扩展为"音频数据 + 可选词典 hints + 可选上下文风格 + 翻译 / 问答的文本输入"，并按 provider 列出每条数据流向。

## 12. 默认行为与首启

- 首启 + 未登录：默认 `mode=CLOUD`，进入 onboarding 引导登录；用户也可在第二步选择"使用本地 provider"跳到 settings 配置。
- 切到 LOCAL 但未配任何 ASR provider：触发录音时 Gate 拦截，跳 settings 高亮 ASR Provider 选择框。
- 切到 LOCAL + 选了 provider 但鉴权失败（"测试连接"未通过且按下快捷键）：toast 提示并允许"切回 CLOUD"快捷按钮。
- 已登录用户切到 LOCAL：保留登录态（OpenLoaf 账户仍可用于词典同步等其他能力），只是听写不再走 SaaS。
- 已登录用户从 LOCAL 切回 CLOUD：直接生效，不需要再次登录。

## 13. 网络 / 离线策略

- **CLOUD**：保留现有 health check（`recording.ts:780-812`），改写为 `active_profile.healthCheck()` 派发到 adapter。
- **LOCAL**：默认信任用户配置的 endpoint（可能是 LAN / localhost / 离线模型），**不做** `navigator.onLine` 检查。Adapter 自身的连接错误由 §7.3 错误模型上报。
- 例外：`byo-rest` 与已知公网域名 provider（aliyun/tencent/azure/google）的 endpoint 落在公网时，仍参与 `navigator.onLine` 同步检查（避免典型断网下白录）。

## 14. 开源扩展点

### 14.1 仓库结构

```
src-tauri/src/providers/
├── mod.rs                      # registry + 公共 trait
├── capability.rs               # Capability 枚举（闭集）
├── error.rs                    # AdapterError stable code
├── _template/                  # 模板目录（贡献者复制改名）
│   ├── mod.rs
│   ├── manifest.json
│   └── README.md
├── openloaf_cloud/             # 包装现有 OpenLoaf 路径
├── aliyun/
├── tencent/
├── azure/
├── google/
└── byo_rest/

docs/providers/                 # 每 provider 一份用户文档（如何申请 key、定价、限制）
├── aliyun.md
├── tencent.md
├── ...
```

### 14.2 贡献清单（Adapter PR 必备）

1. 实现 `SpeechAdapter` 或 `LlmAdapter`（或两者）。
2. 在 `providers/<id>/manifest.json` 声明：`id` / `display_name` / `homepage` / `engines: [asr|llm|both]` / `capabilities: [...]` / `config_schema`。
3. 在 `providers/mod.rs` 的 registry 列表里登记一行（编译期 const，**不**用 inventory / linkme）。
4. 加 i18n 文案到 `src/i18n/locales/{lang}/settings.json` 的 `providers.<id>` 命名空间（zh-CN / zh-TW / en 三语全齐，规则见 SKILL.md i18n 段）。
5. 加 capability 矩阵到本 doc §6.2，**同 PR 必改**。
6. 加 `docs/providers/<id>.md`：账号注册流程、key 获取、计费要点、已知限制、隐私链接。
7. 加最小 example：`src-tauri/examples/test_<id>_adapter.rs` 离线 smoke test。
8. 单元测试覆盖：config validate / capability 报告 / 错误码映射。

### 14.3 不接受的 PR

- 没补 §6.2 矩阵的（无法被 §8 决策器使用）。
- 没补 docs/providers/ 的（用户无从下手）。
- 用了 `Capability` 枚举之外的字符串（破坏闭集约定）。
- 把 secret 字段存到 `tauri-plugin-store`（违反 [privacy.md](./privacy.md) §4）。

## 15. 渐进式迁移路径

不做 big-bang。每个 Phase 输出可发版的中间形态：

| Phase | 内容 | 用户可见变化 |
|---|---|---|
| **0** | 把现有 OpenLoaf realtime 路径包装成 `OpenLoafCloudAdapter`；行为完全等价于现状；引入 `providers/` 目录与 trait | 无 |
| **1** | 引入 Capability 枚举与 registry；改写 `recording.ts` Gate 为 `active_profile` 决策；UI 仍然只显示 CLOUD | 无 |
| **2** | 实现 settings 改造：mode 切换器、provider 表单、capability 预览；上线 `aliyun` + `tencent` 两个 LOCAL adapter；上线翻译 / 问 AI 走 LLM adapter（CLOUD 模式下仍走 OpenLoaf v4 工具，LOCAL 模式下走对应 LLM 适配器）| 第一个里程碑：用户可不登录用 aliyun / tencent |
| **3** | 上线 `azure` + `google` adapter；上线 `byo-rest` 兜底；上线 §8.3 ProviderCapabilityGapDialog | LOCAL 选项扩展到 5 个 |
| **4** | 上线 `_template/` 与 `docs/providers/` 文档；blog post 公布开源 adapter 接入流程 | 社区贡献入口 |
| **5（可选）** | 评估 wasm 动态加载是否值得 | 取决于社区 PR 数量 |

每个 Phase 都需要：

- 跑通 `pnpm build` 与 `pnpm tauri build` 三平台
- 既有 history / dictionary / hotkeys 等业务规则不回退
- 文档同步（本 doc + privacy + settings + 涉及的 docs/providers/）

## 16. 风险与未解决问题

| 风险 | 缓解 |
|---|---|
| 4 家流式协议差异巨大（阿里 nls / 腾讯 / Azure / Google）→ 维护成本 | trait 内部允许各 adapter 维护自己的 worker；公共代码只做 control plane（鉴权、capability 报告、错误映射）|
| 各服务端采样率 / 编码要求不一致 | 在 adapter 入口做重采样 / 量化（参考现有 `src-tauri/src/audio/*` 的 mono downmix + PCM16 量化）|
| LOCAL 模式下用户填错 key 但 "测试连接" 通过、实际录音才失败 | "测试连接" 必须真发一段 1s 静音的握手 + finish，验证全链路 |
| LLM 翻译延迟（compose vs inline）用户感知不一致 | UI 在 capability 预览里写明"约 +0.5s"；首次触发 toast 一次 |
| OpenLoaf 后端未来切混合 provider，capability 可能动态变化 | `openloaf-cloud` adapter 的 `capabilities()` 允许 async（启动时拉一次配置缓存到 store），其他 adapter 是静态 const |
| 已登录用户切到 LOCAL 后再切回 CLOUD，token 是否仍有效 | 不动 OpenLoaf 登录态；切 mode 只切 dispatch，不动 keyring 里的 OpenLoaf token |
| Provider 服务端跨境合规（GDPR / 中国《个人信息保护法》）| 本应用不承担——通过 §11 隐私横幅显式让用户知情；docs/providers/<id>.md 列出该服务商的合规说明链接 |

### Open questions（不阻塞开工，但需在 Phase 1 前定）

1. **Profile 是否多档**？目前设计为单一 active profile；是否要支持"工作 profile / 个人 profile" 一键切换？  
   *建议*：MVP 单 profile，多 profile 等社区诉求出现再做。
2. **CLOUD 模式下 LLM Provider 是否对用户可见**？目前设计为对用户隐藏（统一是 openloaf-cloud）。  
   *建议*：保持隐藏，避免与 OpenLoaf 套餐叙事打架。
3. **是否允许 ASR = LOCAL，LLM = CLOUD 这种"混合 mode"**？  
   *建议*：**不允许**。Mode 是顶层鉴权 / 计费分界线，混着用会让 §11 隐私边界与 §13 网络策略难以解释。LLM Provider 选 None 即为"不启用 LLM 类 feature"。
4. **byo-rest 是否要尝试 streaming**？目前定为非流式兜底。  
   *建议*：保持非流式。streaming 的 SSE/WebSocket 各家协议太碎，bytarget 用户应直接选有原生 adapter 的 provider。
5. **Provider 切换是否需要清空相关历史 / 缓存**？  
   *建议*：不清。historical record 已经 §10.4 标了 provider id，用户事后可追溯。

## 17. 与现有文档的关系

本规划落地后，以下文档需同步更新：

| 文档 | 更新点 |
|---|---|
| [features.md](./features.md) | F4 "REST 大模型接入" 改为 "Provider 适配器系统"；新增 F19 "本地 Provider 配置（不登录可用）" |
| [voice-input-flow.md](./voice-input-flow.md) | 触发 §5 Gate 部分改为引用 §10.1 |
| [settings.md](./settings.md) | "大模型（REST）" 整段替换为 §9 描述的"语音引擎" tab |
| [privacy.md](./privacy.md) | "传输给第三方大模型的规则" 扩展为按 provider 分类 |
| [subscription.md](./subscription.md) | BYO 段改为引用本 doc 的 LOCAL Mode 概念 |
| [history.md](./history.md) | schema 增加 provider_asr / provider_llm 列 |
| [permissions.md](./permissions.md) | 各 LOCAL provider 的网络白名单（如 macOS 防火墙规则）|
| [onboarding.md](./onboarding.md) | 新增"选择语音引擎模式"步骤（CLOUD 推荐 / LOCAL 高级） |
| [README.md](./README.md) | 索引新增本文档与 docs/providers/ 子目录 |

新增文档：`docs/providers/<id>.md` 每 provider 一份，跟随 adapter PR 一起入仓。
