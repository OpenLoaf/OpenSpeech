# 提案：接入 Qwen-Audio-3.1-ASR-Flash，并重新划分 ASR / refine 的分工

> 状态：待验证（SaaS 生产部署中）
> 起因：OpenLoaf-saas `04026da feat(ai): 语音识别换代到 Qwen-Audio-3.1 与腾讯大模型 2.0 引擎`
> 目标：回答「ASR 直出能不能省掉后面那次大模型调用」

---

## 一、先说结论

**不能整体省掉，但可以重新分工，并给出一个真正可用的「极速档」。**

原因是当前这次 chat 调用做的远不止「纠错」。`defaultAiPrompts.ts` 里的规则是多轮线上事故打磨出来的，
承担了 ASR 模型在架构上就不做的事：

| refine 现在做的事 | Qwen-Audio-3.1 能覆盖吗 |
|---|---|
| 同音字 / 专名纠错（git 哈伯 → GitHub） | ✅ 热词 `vocabulary` + `context` 可覆盖大半 |
| 标点、语义断句 | ✅ `semantic_punctuation_enabled` |
| 数字 / 版本号 / 日期规范化（ITN） | ✅ 模型自带 |
| 填充词、结巴（嗯 / 那个 / 好的好的好的） | 🟡 `disfluency_removal_enabled` 覆盖浅层 |
| **撤回 / 覆盖信号**（「啊不对，就 DNS 名称吧」→ 丢弃前半段） | ❌ |
| **卡壳后补全覆盖**（「80 乘多少…等一下我查下…80×24」） | ❌ |
| **口语 → 书面化、主动分段** | ❌ |
| **结构化重排** | ❌ |
| **按目标应用调风格**（微信 / iTerm2 / 邮件） | ❌ |
| **防 prompt injection**（正文是指令也只照录不执行） | ❌ |
| **防 history 串味**（离题守卫的兜底对象） | ❌ |
| **翻译**（translate 热键的 phase 2） | ❌ |

换句话说：3.1 提升的是**转写这一层的天花板**，而 refine 卖的是**「把口语变成能直接粘出去的书面文字」**。
前者做好了，后者的输入变干净、可以更快更省，但不会消失。

真正的收益有三块，按价值排序：

1. **主路径第一次能吃到词典偏置**（见下一节的关键事实）——这是准确率的质变，不是微调。
2. **上游成本降约 5 倍**（对外单价不变，纯毛利），对用户是 0 涨价。
3. **可以新增一个「极速档」**：ASR 直出 + 轻量本地后处理，跳过 chat 往返。适合短指令 / 聊天口语。

---

## 二、两条听写链路，换代目标不同

**默认模式是 UTTERANCE，走的是文件转写，不是 realtime。**

| 模式 | 默认 | 链路 | ASR 偏置 | refine |
|---|---|---|---|---|
| **UTTERANCE** | ✅ 默认（`settings.ts:304`） | 松手 → 落盘 → `transcribe_and_refine` → **OL-TL-003 asrShort** → refine chat → 注入 | ✅ 完整 system_prompt（Domains 展开 + Trending + HotWords + History + TargetApp） | ✅ 走 |
| **REALTIME** | 会议字幕 / 直播 / 同传 | 边录边出字 → **OL-TL-RT-002** WS | ❌ `stt/mod.rs:333` 传 `context: None` | ❌ 强制短路（`store.ts:101`） |

`finalize.ts:144` —— `segmentModeAtStop !== "REALTIME"` 就置 `realtimeDegradedToFile = true`，
UTTERANCE 主路径压根不开 WS。

由此得出两条结论：

1. **主路径的换代目标是 `OL-TL-003 → OL-TL-010`**，不是 realtime 那条。
   两边都支持 `params.systemPrompt`，现有 `buildSpeechSystemPrompt` 的产物可以**原样平移**，
   是 drop-in 替换。这是本提案的重点，但被 SDK 0.3.21 阻塞（见下）。
2. **REALTIME 那条的 `context: None` 是真实缺口，但价值有限**——该模式本来就不走 refine，
   补上只提升会议字幕的识别质量，对「能不能省掉大模型」这个命题没有贡献。
   它的好处是**不依赖 SaaS 部署、不依赖新 SDK，现在就能做**。

## 三、SaaS 那边已经就绪了什么

`OpenLoaf-saas@04026da` 新增（老通道一条未停，V4 按 variantId 直接寻址）：

| variantId | 用途 | 上游 | 对外单价 | 对 OpenSpeech |
|---|---|---|---|---|
| `OL-TL-RT-005` | 实时 ASR | `qwen-audio-3.1-asr-flash-streaming` | 4 积分/分钟（= RT-002） | **主路径候选** |
| `OL-TL-010` | 短音频（≤5min，同步） | `qwen-audio-3.1-asr-flash` | 1.32 积分/分钟（= TL-003） | degraded 路径候选 |
| `OL-TL-011` | 长音频（异步） | `qwen-audio-3.1-asr-flash-filetrans` | 1.32 积分/分钟 | 会议转写候选 |

协议差异（saas 侧已实测，不是照文档推断）：

- **RT-005**：上游与 Paraformer 是**同一套** DashScope `run-task` duplex 协议，saas 内部直接复用
  `DashScopeRunTaskSession`。对客户端而言，V4 WS 外壳（start / ready / 二进制帧 / finish）与 RT-001/002 一致，
  **OpenSpeech 的 realtime worker 逻辑可原样复用，只换 variantId 与 params 形状**。
- **TL-010**：支持 `params.systemPrompt`，以 system message 形式进 multimodal-generation。
  也就是说现有 `buildSpeechSystemPrompt` 那套 `<system-tag>` 偏置在短音频路径上**可以平移**。
- 能力差：3.1 覆盖 30 语种 + 10 方言（RT-002 只有中英日韩粤），多了热词 / Prompt 上下文 / 说话人分离
  （说话人分离仅 filetrans），少了情感识别（我们没用）。

---

## 四、两个阻塞项（都在 SaaS 侧，需要对面配合）

### 4.1 Rust SDK 还没有新方法 —— 需要发 0.3.21

`openloaf-saas 0.3.20` 的 `v4_tools/` 里只有 RT-001/002/003/004、TL-003/004/006，没有 010/011/RT-005。
`RealtimeAsrSession::connect()` 是 `pub(crate)`，外部拿不到泛型入口。

好消息是成本极低：**RT-005 的 params 形状与 RT-001 几乎相同**（`QwenAsrStreamingParamsSchema` 是
`ParaformerRealtimeParamsSchema.extend({ model })`），新增模块基本是复制 `realtime_asr_ol_tl_rt_001.rs`
改 variantId 与 model enum。

> 临时绕过（只用于验证，不进生产）：refine 已经是 reqwest 直发 SaaS `/api/v1/chat/completions`，
> access_token 拿得到；同理可以在 `examples/` 里用 tungstenite 直连
> `wss://<base>/api/ai/v4/tools/OL-TL-RT-005/stream?token=<access_token>` 打通效果对比，不等 SDK。

### 4.2 RT-005 的参数白名单漏掉了 3.1 最值钱的两个能力

`apps/server/src/ai/services/aliyun/params-whitelist.ts` 的 `QwenAsrStreamingParamsSchema`
直接沿用了 Paraformer 的字段集，只有 `vocabulary_id`（需在 DashScope 控制台预建热词表）。
而阿里官方 client-events 文档里，3.x streaming 实际支持：

| 上游字段 | 位置 | 说明 | 对 OpenSpeech 的意义 |
|---|---|---|---|
| `vocabulary` | `payload.parameters` | **即时热词**，key-value + weight(1–5 / 50)，无需控制台预建 | 对接用户词典，**每个用户词表不同，这个才用得上** |
| `context` | `payload.input` | 对话上下文，user/assistant 消息数组，每类 ≤5 条、每轮 ≤400 字 | 对接 ConversationHistory / 领域提示 |
| `keep_dialect` / `vad_model` / `max_sentence_silence` / `multi_threshold_mode_enabled` / `speech_noise_threshold` | `payload.parameters` | 方言保留、VAD 调参 | 后续可调 |

而且 `paraformer-realtime-handler.ts` 拼 run-task 帧时 `input: {}` 是**硬编码空对象**，
context 通道根本没开。

**结论：不补这两个字段，换到 RT-005 反而比现在更差**——丢了 RT-002 那个还没用上的 `context`，
换来一个只认预建热词表的通道。这条必须先跟 saas 那边对齐。

---

## 五、落地方案（三步，每步可独立验证）

### P0 —— 补上 REALTIME 的 `context`（不依赖部署，现在就能做）

改动面：`src/lib/asrSystemPrompt.ts` 新增 `buildRealtimeAsrContext()` + `src/lib/stt.ts`
透传 + `src-tauri/src/stt/mod.rs` 填进 RT-002 params + `store.ts` 调用点，4 个文件。

- 受益范围**仅 REALTIME 模式**（会议字幕 / 直播），默认 UTTERANCE 用户无感。
- `context` ≤2000 字，且 REALTIME 不走 refine，所以只送**词汇偏置**：
  HotWords → Domains 展开关键词 → Trending → 最近几条 history 的修正对。
  不送 MessageContext（requestTime / deviceName 是幻觉诱因，`docs/ai-refine.md` 已有定论）。
- 超限按**整段丢弃**，不截半句——截断会让「说了半句被砍」隐性发生，更难调。
- 风险低：纯新增可选字段，不动协议与线程模型；不传就是今天的行为。

### P1 —— 接 RT-005 / TL-010，做三档 A/B（等 SaaS 部署 + SDK 0.3.21）

主路径在 `src-tauri/src/transcribe/mod.rs` 的 `run_asr_short_blocking` 旁边加一条 TL-010 分支，
realtime 侧在 `src-tauri/src/asr/backends/` 加 `saas_v31.rs`（`saas.rs` 已是 `RealtimeAsrBackend` 实现）。
用 **dev-only 开关**切换，不做用户可见 UI。

对比三档：

| 档 | 链路 | 看什么 |
|---|---|---|
| A（现状） | TL-003 + systemPrompt → refine | 基线 |
| B | **TL-010** + systemPrompt → refine | 纠错负担降了多少，refine 还改不改得动 |
| C | **TL-010** + systemPrompt **直出，跳过 refine** | 直出能不能直接粘出去 |

REALTIME 那条同步做 RT-002 → RT-005 的对照，但它不是「省掉大模型」的主战场。

### P2 —— 按结果决定「极速档」

如果 C 档在「短指令 / 聊天口语」上可用，就做成一个用户可选档位（沿用现有
`aiRefine.enabled` 的解耦设计，它本来就允许关掉 refine 直接落原文），配轻量本地后处理
（`text_normalize.rs` 已有基础）。**不做全局替换**——长段落 / 邮件 / 翻译必须保留 refine。

---

## 六、怎么测（等生产部署好）

脚手架已经齐了，不用新建体系：

- `src-tauri/examples/transcribe_audio_runner.rs` —— ASR 侧跑批
- `src-tauri/examples/prompt_eval_runner.rs` —— refine 侧跑批（stdout 只出 refined 文本，可直接 diff）
- `src-tauri/examples/test_realtime_asr_segmentation.rs` —— 实时分句对照

语料集建议直接从 `~/.openspeech` 的 history 里挑真实录音，按场景分桶（每桶 20–30 条）：

1. **专名密集**（产品名 / 命令 / 英文术语）→ 测热词是否真的生效
2. **口语自纠错**（撤回、卡壳补全）→ 这桶就是用来证明 refine 不能省的
3. **短指令**（≤15 字，微信 / 终端）→ 极速档的目标场景
4. **长段落**（>100 字，需分段）→ refine 的主场
5. **方言 / 中英混说** → 3.1 的 30 语种 + 10 方言是否兑现

指标：字错率（CER）、专名命中率、**refine 改动量**（B 档的 refine diff 应该显著小于 A 档，
这是「ASR 变准了」的直接证据）、端到端延迟（松手 → 注入完成）、单次听写积分。

---

## 七、顺带记一笔

`src-tauri/Cargo.toml:47` 写的是 `openloaf-saas = "0.3.20"`，按 `r-saas-sdk-pin` 应为 `"=0.3.20"`。
升到 0.3.21 时一并改掉。

---

## 八、待落地时需要同步更新的文档

- `docs/cloud-endpoints.md` —— C1 表格与 §4 的 provider 对照
- `docs/speech-providers.md` —— CLOUD provider 的上游说明
- `docs/ai-refine.md` —— 「ASR 阶段的 system_prompt」那一节的路径约束（P0 做完就不再是「只有 TL-003 透传」）

---

## 九、实测结果（2026-09-23，生产环境，SDK `=0.3.21`）

### 方法

- 语料：history 里 20 条**用户手动改过**的听写（`text_edited`，改后文本作标准答案），音频均为原始录音。
- 同一段音频分别打 `OL-TL-003`（Qwen3-ASR-Flash，现网主路径）与 `OL-TL-010`（Qwen-Audio-3.1-ASR-Flash），
  各跑「不带 prompt」「带词典 prompt」两轮，共 80 次调用。runner：`src-tauri/examples/asr_ab_runner.rs`。
- 词典 prompt 里**刻意放入了这批样本的正确词**（负荷跟踪 / 晶振 / rom / boot / CLI …），
  测的是「词已经在词典里，模型用不用得上」。
- 样本量小、单次运行，上游有随机性，结论看趋势，不看个位数差距。

### 结果

| | 003 裸 | 003 + 词典 | 010 裸 | 010 + 词典 |
|---|---|---|---|---|
| 词典 prompt 改变输出的样本 | — | **13 / 20** | — | **2 / 20** |
| 中文同音词（负荷 / 晶振 / 烧写 / boot / 会话） | 多错 | **基本全对** | 错 | 错（复合 / 金证 / 烧血 / 波特） |
| 英文缩写（CLI / JST / context7） | 逐字母拆（C R I / G S T） | 同左 | **对** | **对** |
| 耗时中位 | 843 ms | 862 ms | 1371 ms | 1040 ms |
| 单价 | 1.32 积分/分钟 | 同 | 同 | 同 |

两条关键发现：

1. **010 基本不认 `systemPrompt`。** 词典 prompt 只改变了它 2/20 条输出，同音纠错一条没救回来。
   原因是 3.1 的热词走的是专用参数（`vocabulary`），不走 system message；SaaS 的 TL-010 目前只透传
   `systemPrompt`。**所以按现在的接口把主路径从 003 换到 010，用户词典会整体失效**，而用户手改最多的
   恰恰是这类同音专名。
2. **003 的 system prompt 偏置是有效的**，但也有副作用：#15「还没有地主剥削得强」被带词的 003 写成了
   「还没有 DeepSeek，我学得强」——词是从 Trending 段里硬塞进来的。现网 Trending 同样包含 DeepSeek，
   这是真实存在的幻觉风险。

### 线上错误出在哪一层

回查这批样本当时的 `text`（ASR 原文）与 `refined_text`：**所有同音错误都出在 ASR，refine 一条都没纠正**
（符合跟踪、金正电路、双录、bot、烧鞋、雁眉斯、C R I → CRi 原样通过）。refine 实际做的是去填充词、
去结巴（「任任意」「复复制」「也也删掉」）、书面化和分段——这部分 ASR 直出做不到。

### 结论

- **现在不切主路径。** 继续用 003 + system prompt。010 的原始识别并不比 003 好（英文缩写更好，中文同音更差），
  又用不上词典。
- **换代的前提是 SaaS 把 3.1 的 `vocabulary`（即时热词）透传出来**，TL-010 和 RT-005 都要。
  补上后用同一套 runner 与语料重测，重点看中文同音词能否追平 003 + 词典。
- **refine 省不掉**：它不负责纠同音字，负责的是把口语整理成书面文字。省掉它等于把「对的，嗯，
  任任意的一个……」原样粘出去。「极速档」只在 <5 秒短指令上值得评估。

### 补测：010 + `vocabulary`（2026-09-23，SaaS `540ce84` 上线 + SDK `=0.3.22`）

SaaS 侧实测确认：**3.1 短音频会整条丢弃 system 消息**（带与不带 input_tokens 完全相同），
热词只能走 `parameters.vocabulary`（`{词: 权重}`，权重只收 1–5 或 50，越界整表被静默丢弃）。
这解释了上一轮「010 + 词典 prompt」为什么无效。

用同一批 20 条样本、同一份 31 词词表（真实词典 13 条 + 放入的正确词）重跑：

| 样本（关键词） | 003 + 词典 prompt | 010 + vocabulary |
|---|---|---|
| 负荷跟踪 / 晶振 / rom / 烧录 / 烧写 / Rust / EMS | ✅ | ✅ |
| CLI ×2 | ❌（C R I / c i） | ✅ |
| context7 | ❌（context 七） | ✅ |
| JST | ❌（G S T） | ✅ |
| 2lane | ❌（两 line） | 🟡（两lane） |
| 地主 | ❌ **幻觉成 DeepSeek** | ✅ |
| boot | ✅ | ❌（波特，上游没选中这个热词） |
| 会话（不在词表） | 🟡 | ❌ |
| 耗时中位 | 862 ms | **720 ms** |

不计双方都无法识别的项（「灏」不在词表，viewer / XML 是用户说完后才改的，最后一条是整理阶段的改动），
可判定的 14 个关键词里：**003 + 词典 8 个，010 + vocabulary 13 个**，同价、更快，而且没有出现 prompt 带进来的幻觉词。

**结论更新：换代成立。** 主路径 `OL-TL-003 + systemPrompt` 应切到 `OL-TL-010 + vocabulary`。refine 仍需保留，
原因不变：ASR 原文里的「任任意」「复复制」「对的，嗯」只有 refine 能清理。
