# AI 文本改写（AI Refine）

> SSoT：本页定义 AI_REFINE 听写模式松开按键后的「文本改写」业务规则。前端组件 / Rust 命令 / settings 字段统一以本页为准。

提供「云端模式（saas）/ 自定义模式（custom）」两种 chat 调用方式，全部走标准 OpenAI 兼容 chat completions 协议（async-openai SDK）。

## 模式

| 模式 | 端点 | 鉴权 | 模型 | 适用 |
|---|---|---|---|---|
| `saas` | `<SaaSClientConfig.base_url> + V3Variant.endpoint` | `Authorization: Bearer <SDK access_token>` | `V3Variant.id`（取 `client.ai().fast_chat_variant()` 标记 `is_fast` 的快速模型） | OpenLoaf 已登录用户的默认通道；扣积分；选最快可用 chat 模型 |
| `custom` | 用户填的 `baseUrl`（如 `https://api.openai.com/v1`） | `Authorization: Bearer <用户 API Key>` | 用户填的 `model`（如 `gpt-4o-mini`） | 自带钥匙；不走 OpenLoaf；可加多个供应商但**同一时刻只能激活一个** |

两种模式都用 async-openai 的 `Client::with_config(OpenAIConfig::new().with_api_base(base).with_api_key(key))` + `chat().create_stream(...)`，事件路径一致：每个 chunk 走 `openspeech://ai-refine:delta`，结束 `openspeech://ai-refine:done`，错误 `openspeech://ai-refine:error`。

流式响应在 emit / 注入前会暂存开头的少量字符：如果模型误将本次请求里某个完整的 `<system-tag>...</system-tag>` 上下文块（如 TargetApp / HotWords）回显在输出开头，在流式注入前剔除。只剥离“前导 + 与本次请求中的块匹配”的标签，不全局删 XML，避免损坏用户本来就在口述的标签文本。

### 离题守卫（drift guard）

`RefineChatInput.drift_guard = true` 时，Rust 侧（`ai_refine/postprocess.rs::StreamingDriftGuard`）比对模型输出与 `user_text` 的**内容字符集合**（字母 / 数字 / 汉字；标点空白不算；中英大小写归一；阿拉伯数字与中文数字归为同一类）：

- `novel_ratio`：输出里有多少字在正文里从未出现。输出中**整词命中** HotWords term / aliases 的片段先剔除再算（按词典把「塞坝」还原成「sidebar」不算 novel）；**不按字母豁免**——词典一长 26 个字母很快凑齐，任何拉丁文幻觉都测不出来
- `dropped_ratio`：正文里有多少字在输出里完全消失
- `expansion`：输出内容字数 / 正文内容字数

终判命中任一条即离题：

- **改写**：`novel > 0.5` 且（`dropped > 0.5` 或 `expansion > 2`）且输出 ≥ 4 个内容字
- **抄 history**：输出的内容字符串与某条 `ConversationHistory` 正文相同、或互为子串（较短一侧 ≥ 4 个内容字），且 `novel ≥ 0.5`（用户重复口述同一句时 novel ≈ 0，不会误判）。模型抄 history 常掐头去尾（少个「帮我」），只认完全相等会漏
- **零重叠短输出**：`novel = dropped = 100%` 且输出 ≥ 2 个内容字（「制作组制作手机 UI」→「特写」）
- **截断**：输出是正文内容字符的严格前缀、长度 < 正文 35%、`dropped > 0.6`（「制作组制作手机 UI」→「制作」；只删尾巴残字或结巴去重「好的好的好的」→「好的」不命中，因为字符集没丢）

离题 ⇒ **丢弃模型输出，改用正文原文**（尾句号按 always 砍；`off` 不砍），只 emit 一帧 delta，`done.refined_text` 即原文。这样坏输出也不会进 history 污染后续请求。

流式策略：输出前 8 个内容字先 hold（约 2-3 个 SSE chunk），凑够后用 `novel_ratio` 预判——不离题就放行并转透传；离题就继续 hold 到流结束终判。短输出天然 hold 到结束。前缀已放行后才发现整体离题的，来不及撤回，只打 `warn` 日志。

**只在听写 refine（含历史重试）打开。** 翻译 / 润色 / 会议摘要 / 标题的输出本就该与输入不同，开了会把译文当离题兜底回原文——这些调用方保持缺省（关）。设置页「测试」按钮等调试路径也不开，便于看到模型原始输出。

事故原型（2026-09-22 用户反馈）：正文「上午行程结束后，下午的行程是点点点点点。」被 refine 成「上午九点十五分」——模型把 `MessageContext.requestTime`（09:15）当成用户说的时间填了进去；坏输出随即进入 ConversationHistory，下一条又被原样抄出。prompt 侧同时补了 r3「补全值只能来自正文」硬约束、`<reference_tags>` 的 MessageContext 说明与 `default-placeholder-no-fill` 示例；守卫是 prompt 失效时的最后兜底。

同一用户同日第二轮反馈：「制作组制作手机 UI。」两次分别被写成「特写」（抄 history 第一条）与「制作」（截断成两个字）。输出只有 2 个内容字，走不到改写判据的 4 字门槛，于是补了抄 history / 零重叠 / 截断三条判据——它们各自只盯一种崩塌形态，阈值都留了余量，避免误伤同音纠错（「在见」→「再见」）与结巴去重。

同日第三轮反馈（15:22 / 15:47，target Orca）两条连环事故：

1. 「帮我用 Cloudflare 的命令去添加一个 DNS 的一个设置。」被「完善」成「帮我用 Cloudflare 的 API 创建一个 DNS 记录，域名是 example.com，类型 A，值 1.2.3.4」——域名 / 类型 / IP 全是模型编的占位值，「命令」还被偷换成「API」。字符集守卫对这种「保留用户的词、再添一段像模像样的参数」**天然无能为力**（novel 0.21 / dropped 0.29 / expansion 1.6，全在正常整理范围内），只能靠 prompt：r3 加了「模糊的请求保持模糊，不替用户补参数」硬约束，并新增 `default-vague-request-no-fill` 示例（正文就是这条事故）。
2. 坏输出进了 history，25 分钟后「我主要担心的是，用这个方法的话，会不会被封。」被整段替换成 history 里那条 Cloudflare 请求（只少了「帮我」）。这条本该被改写判据拦住（dropped 0.76），却因为 **HotWords 按字母整体豁免**漏网：用户词典里有十来个英文词条（harness / viewer / sidebar / OpenSpeech …），字母几乎凑齐整套，`Cloudflare` / `API` / `DNS` / `example.com` 全被当成「已知」，novel 只有 0.31。抄 history 判据也因为少了「帮我」不完全相等而失效。修法：novel 只豁免输出里整词命中的词条；抄 history 放宽到互为子串。prompt 侧在 `default-history-bleed-long-ask` 的 focus 里补了「带指代的担忧 / 评价句」形态。

## settings 字段

`settings.aiRefine`（schema v9 引入）：

```ts
{
  mode: "saas" | "custom",                  // 默认 "saas"
  customProviders: Array<{
    id: string,                              // uuid
    name: string,                            // 显示名（用户自填）
    baseUrl: string,                         // 例 https://api.openai.com/v1
    model: string,                           // 例 gpt-4o-mini
    // apiKey 不在 store；走 keyring，name = `ai_provider_<id>`
  }>,
  activeCustomProviderId: string | null,    // 当前激活的供应商 id（custom 模式才有意义）
  customSystemPrompt: string | null,        // null = 跟随当前 UI 语言用 DEFAULT_AI_SYSTEM_PROMPTS；非 null = 用户自定义（不分语言）
  includeHistory: boolean,                   // 默认 true
}
```

## 历史上下文 / 热词 / 时间（统一走 system_prompt）

ASR 阶段（OL-TL-003）和 refine 阶段共用同一份 prompt 组装逻辑：`src/lib/asrSystemPrompt.ts::buildSpeechSystemPrompt`。区别只在 `corePrompt`——ASR 用 `ASR_CORE_RULES[lang]`（短偏置规则），refine 用 `getEffectiveAiSystemPrompt(...)`（长清洗规则）。其余 HotWords / ConversationHistory / MessageContext / TargetApp 四段两边完全一致；**Domains 段两边形式不同**：ASR 展开为"领域名: 高频术语清单"喂给上游 ASR 做同音偏置（`expandDomainKeywords: true`），refine 只放领域名让模型自行理解风格——展开会让 system message 每个领域多 ~200 字符，对 chat 阶段无收益反而吃 cache + token。

输出整体作为**单一 system message**送上游；user message 只放用户实际文本（refine）或音频本体（ASR）。前端**不再**单独传 `hotwords / historyEntries / requestTime / targetApp / domains` 给 Rust——`build_context_message` 在这些字段全 None 时返回 None，refine 自动跳过 context user message，messages 结构变成 `[system, user]` 两条。Rust 端结构体保留这些 Option 字段做兼容兜底，但本仓库前后端协同改动后实际只走 `system_prompt`。

- `includeHistory` 默认 `true`。从 `historyStore` 取最近 `N=5` 条 `success` 记录，按时间正序拼成 `[<分钟前> · focusTitle=<title>] <text>` 一行。当前 target 已知时整段统一同 app，`targetApp` 提到 tag attribute（`<system-tag type="ConversationHistory" targetApp="VSCode">`）避免每行重复；target 未知（罕见）时退化为行内 `targetApp=`。`focusTitle` 字段缺失的老记录或 retry 路径自动省略。翻译 phase 2 路径调 `buildSpeechSystemPrompt({ ..., skipHistory: true })`，因为历史已被 phase 1 融入 refined 结果。
- **按目标应用隔离**：当本次会话的 `target_app` 已知时，仅取 `target_app` 完全相同的历史条目；拿不到（null）时不过滤。retry 路径以"被重试那条记录的 `target_app`"作为当前应用，并 `excludeHistoryId` 排除自身。
- `MessageContext` 内含 `requestTime`（本地时间 + 时区偏移 + IANA 时区名）/ `platform`（macOS / Windows / Linux）/ `appLanguage`（OpenSpeech UI 语言）/ `dictationLanguage`（听写设置语言）/ `systemLocale`（navigator 给的）。`MachineInfo` 已合进这一段，不再单独 emit。**对 refine 而言这一段全是幻觉诱因**：`requestTime` 会被当成用户说的时间、`deviceName` / `username` 会被当成人名填进正文（见上文离题守卫的事故原型）。refine prompt 已在 `<reference_tags>` 明示「MessageContext 是遥测，一个字都不能进输出」；若再出现同类事故，下一步是给 refine 路径单独传一份精简 MessageContext（只留 `platform` / `appLanguage` / `audioDuration`），ASR 与翻译路径保持现状。

### system_prompt 段落顺序（ASR / refine 共用）

```
<corePrompt>     // ASR 用 ASR_CORE_RULES[lang]；refine 用 getEffectiveAiSystemPrompt(...)
<system-tag type="Domains"> ... </system-tag>     // ASR 展开关键词；refine 仅领域名
<system-tag type="Trending"> ... </system-tag>    // 仅 ASR：30 个跨领域热门专有名词（Claude / Cursor / DeepSeek 等）
<system-tag type="HotWords"> ... </system-tag>
<system-tag type="ConversationHistory"> ... </system-tag>
<system-tag type="MessageContext">
    requestTime: 2026-05-07T22:36:55+08:00 (Asia/Shanghai)   // 本地时间，不是 UTC
    platform: macOS                                           // 由 Rust std::env::consts::OS 归一
    appLanguage: zh-CN                                        // OpenSpeech UI 语言
    deviceName: Zhao 的 MacBook Pro                          // whoami::devicename，友好设备名
    hostname: Zhaos-MacBook-Pro.local                         // 与 deviceName 相同则省略
    username: zhao                                            // OS 用户名
    audioDuration: 21.2s                                      // 本次录音长度，调用方传 ms
</system-tag>
<system-tag type="TargetApp">
    name: VSCode
    focusTitle: VSCode — main.rs                              // 录音开始瞬间窗口标题；retry 路径无
</system-tag>
```

ASR core rules 是约 150 字的三语短规则：用 Domains/HotWords/History/TargetApp 偏置同音替代；不要清洗/补全/翻译；保留口语停顿与重复；冲突时音频优先。三语版本按 `interfaceLang` 选。

`platform` 归一为 `macOS` / `Windows` / `Linux`，来源是 Rust 端 `std::env::consts::OS`。`hostname` / `deviceName` / `username` 由 Rust 调 `whoami` crate，前端在 boot 阶段 `loadMachineInfo()` invoke 一次缓存到 `src/lib/machineInfo.ts` 模块级 cache，`buildSpeechSystemPrompt` 同步读——不每次录音都 invoke 往返。失败时全部 fallback 为空串，对应字段直接不出。

`focusTitle` 来自 Rust `get_active_window_info_cmd`（`active-win-pos-rs` crate 的 `ActiveWindow.title`），录音开始瞬间与 `target_app` 一起 invoke 抓快照存到 `recording.ts` 的模块级 `currentSessionFocusTitle`。retry 路径没有焦点上下文，传 undefined 即可，helper 自动跳过该字段。`audioDuration` 由调用方传 ms（`rec.duration_ms` / `target.duration_ms`），格式化为 `21.2s` / `1m 5s`。`lastEntry` 在 helper 内从 `items` 推导：仅当上一条 success 的 `target_app` 与本次不同时输出，避免与 ConversationHistory 段冗余。

调用点：

| 阶段 | 触发点 | 文件 | targetApp 来源 |
|---|---|---|---|
| ASR | UTTERANCE 主路径 degraded → file 转写 | `src/stores/recording.ts` | `currentSessionTargetApp` |
| ASR | Debug simulate | `src/stores/recording.ts` | `currentSessionTargetApp` |
| ASR | 历史记录 retry | `src/stores/history.ts` | `target.target_app` + `excludeHistoryId=id` |
| refine | finalize phase 1 | `src/stores/recording.ts` | `currentSessionTargetApp` |
| refine | finalize phase 2 (translate) | `src/stores/recording.ts` | `currentSessionTargetApp` + `skipHistory=true` |
| refine | Debug simulate refine | `src/stores/recording.ts` | `currentSessionTargetApp` |
| refine | 历史记录 retry refine | `src/stores/history.ts` | `target.target_app` + `excludeHistoryId=id` |

约束：
- ASR 阶段的 system_prompt 与 `aiRefine.enabled` **解耦**：refine.enabled 只决定"录音结束后是否做文本清洗"，跟 ASR 阶段是否带识别偏置无关。即使关掉 AI 优化（直接落原文），ASR 阶段仍会带 system_prompt。
- `includeHistory === false` ⇒ 不出 ConversationHistory 段；其他段不变。`skipHistory: true` 同等效果（phase 2 翻译用）。
- **不主动截断**长度。SDK 建议 ≤ 2000 字，超过时 Rust 侧 `[transcribe] asr_short system_prompt chars=N exceeds the SDK-recommended 2000-char soft limit` warn 暴露真实长度，由用户自行精简。
- ASR（文件转写 / UTTERANCE 主路径，2026-09 起）：走 **OL-TL-010（Qwen-Audio-3.1）+ `vocabulary`**。
  3.1 会整条丢弃 system 消息，所以词典偏置改由 `buildAsrVocabulary()` 拼即时热词表
  （用户词典 term 权重 4，所选领域关键词 / Trending 权重 2，≤1000 词、每词 ≤64 字；
  **不取 aliases**，那是错误写法）。`system_prompt` 仍然照常组装并随请求传给 Rust，
  只在 010 非鉴权失败、自动退回 OL-TL-003（Qwen3-ASR，能读 system 消息）时使用。
  OL-TL-004 长音频、腾讯 file、阿里 file 路径对两者都打 warn 后丢弃。
- ASR（realtime / REALTIME 模式）：走 **OL-TL-RT-005 + `vocabulary` + `context`**。热词表同上；
  context 由 `buildRealtimeAsrContext()` 给最近 ≤5 条听写正文（优先用户手改版本，旧 → 新），
  每条作一个 user 轮次，超 400 字整条跳过不截断。不带 MessageContext / TargetApp——
  上游把 context 当成真实对话，requestTime / deviceName 会被当成用户说过的话。
  实测热词只在 Final 生效，partial 仍可能是同音错字。腾讯 / 阿里 BYOK realtime 没有等价字段，打 warn 后丢弃。
- 换代依据与 A/B 数据见 `docs/proposals/qwen-audio-3.1-asr.md` §九。
- refine：合并到 system_prompt 后前端**不再**单独传 `hotwords / historyEntries / requestTime / targetApp / domains` 给 Rust。Rust `build_context_message` 这些字段全 None ⇒ return None ⇒ messages 变为 `[system, user]` 两条；struct 字段保留作为兼容兜底。
- 详细日志：前端 `console.info` 各调用点打 `len=N chars`；ASR 路径 Rust 侧 `log::info!` 打 chars/bytes/lines + 前 200 字预览（换行替成 ⏎），`log::debug!` 打全文。

## 系统提示词

设置页只有**一个 textarea**。生效值：

- `customSystemPrompt === null`（默认状态）：从 `DEFAULT_AI_SYSTEM_PROMPTS` 按 `resolveLang(interfaceLang)` 取一条；切换 UI 语言后 textarea 显示内容会跟着切。
- `customSystemPrompt` 非 null：用户已经自定义过，所有界面语言下都用这一条；textarea 一旦发生 `onChange` 就把当前内容写入 `customSystemPrompt`，自此与界面语言解耦。
- 「恢复默认」按钮把 `customSystemPrompt` 设回 `null`，回到跟随界面语言的默认行为。

`DEFAULT_AI_SYSTEM_PROMPTS` 三语长 prompt 在 `src/lib/defaultAiPrompts.ts`（XML 标签结构 + role / input_boundary / language_rule / 7 条 rules / examples / self_check）。规则覆盖：保守整理、通顺化只做减法、自我修正、主动分段、ASR 书面化、标点规范化、结构化重排触发条件、reference 标签处理。

调用前端用 `getEffectiveAiSystemPrompt(customSystemPrompt, lang)` 解析最终 system prompt 传给 Rust。

## API Key 存储

- 自定义 provider 的 API Key 一律走系统 keyring（macOS Keychain / Windows Cred Mgr / Linux Secret Service），常量 `SECRET_AI_PROVIDER_KEY_PREFIX = "ai_provider_"`。
- 完整 keyring `name = "ai_provider_<provider.id>"`。
- store 里**绝不**保留 apiKey 字段。删除 provider 时同步 `deleteAiProviderKey(id)`。
- 不写日志、不进 settings.json。

## Rust 命令

`refine_text_via_chat_stream(input)`：

```rust
RefineChatInput {
    mode: "saas" | "custom",
    system_prompt: String,
    user_text: String,
    hotwords: Option<Vec<String>>,            // 可空，会拼进 <system-tag type="HotWords">
    history_entries: Option<Vec<String>>,    // 可空，每条形如 "[N 分钟前] xxx"，前端组好
    request_time: Option<String>,            // ISO 8601 UTC，用于 MessageContext
    custom_base_url: Option<String>,
    custom_model: Option<String>,
    custom_keyring_id: Option<String>,
    task_id: Option<String>,
    strip_trailing_period: Option<String>,   // off / auto / always，None = auto
    drift_guard: Option<bool>,               // 离题守卫，只有听写 refine 传 true（见上文）
}
```

- 请求体走 async-openai BYOT（`create_stream_byot`），body 显式带 `temperature: 0`、`enable_thinking: false`、`stream_options.include_usage: true`，对齐 SaaS chat 期望。
- saas：`openloaf::shared_client().ai().fast_chat_variant()` 拿 model id（`None` ⇒ 抛错由前端兜底）。POST URL 固定为 `<saas_base>/api/v1/chat/completions`（OpenLoaf 兼容 OpenAI 协议端点），key = SDK access_token，body 仍要塞 `variant: <variant.id>`。
- custom：用 `secret_get("ai_provider_<id>")` 取 key；POST URL = `<custom_base>/chat/completions`。
- 事件 payload 都附带 `task_id`，前端按 task_id 路由。

**集成 example**：`src-tauri/examples/test_ai_refine_chat.rs` 复用 `~/.openspeech/dev_session.json` 拿 token，本地一键 `cargo run --example test_ai_refine_chat` 端到端跑一次真实 SaaS chat。

## 翻译听写流水线（Translate hotkey）

翻译听写（`activeId === "translate"`，默认 Fn+Shift）走**两阶段独立 chat 调用**，不复用同一个 conversation：

```
raw transcript ──[call 1: refine system prompt]──▶ refined ──[call 2: translation system prompt]──▶ translation
```

### 为什么不是单次调用 / 不是同 conversation 续聊

- **单 prompt 复合方案废弃**：把"清洗+翻译"塞进一个 prompt，refine 的 5 个 examples 会拽住模型输出源语言；如果加翻译 examples，又会跟 refine 注意力打架，回归 011 这类长段会输出未整理原文。已在 `.claude/skills/openspeech-prompt-eval` 验证过这条路走不通。
- **同 conversation 续聊废弃**：让 phase 2 用同一份 system prompt + 续 turn 续聊看似省 cache，但 refine prompt 的 `<role>` 是"清洗"不是"翻译"，5 个示例全是中文 → 中文，模型会被 examples 拽住继续输出源语言或四不像。
- **正解**：两个 system prompt 各管各的，**phase 2 是全新 HTTP 请求**——only `[system_translation, user=refined_text]` 两条消息，不带 phase 1 的 user/assistant 残留。两个 prompt 各自被 SaaS prompt cache 命中（首次冷之后稳定）。高内聚低耦合。

### Phase 1 = refine

- system prompt = `getEffectiveAiSystemPrompt(customSystemPrompt, lang)`（与普通听写共用）
- userText = raw ASR transcript
- 处理填充词、撤回信号、长段分段、UI 元素引号、命名实体大小写——见 `defaultAiPrompts.ts` 的 `<examples>`
- 输出 `refinedSrc`，作为 phase 2 输入

### Phase 2 = translate

- system prompt = `getEffectiveAiTranslationSystemPrompt(customTranslationSystemPrompt, lang) + "\n\nTarget language: <name>"`，目标语言名取自 `TRANSLATE_LANG_NAMES[generalSettings.translateTargetLang]`（"English" / "日本語" / "繁體中文" 等 human-readable）
- userText = phase 1 输出的 `refinedSrc`，**不传 historyEntries**（phase 1 已经把历史/热词融入 refined 结果，phase 2 只翻译这一段干净文本）
- 输出 `translation`

### 输出形态（`general.translateOutputMode` + `general.translateBilingualOrder`）

| 形态 | UX | 注入 / 剪贴板的最终文本 |
|---|---|---|
| `target_only` | phase 1 静默累计 token（pill 留在 `transcribing`/思考中），phase 2 切到 `translating` 才开始流式注入译文 | 仅 translation |
| `bilingual` + `translation_first`（默认） | 同 `target_only` 的静默 phase 1；phase 2 流式注入译文，收尾后把 refine 后的原文整段追加到译文下面 | `${translation}\n${refinedSrc}` |
| `bilingual` + `source_first` | phase 1 流式注入 refined（pill 切到 `injecting`），完成后注入换行，phase 2 切到 `translating` 流式注入译文 | `${refinedSrc}\n${translation}` |

`target_only` 把 phase 1 静默是为了避免"先注入中文 → 再清掉 → 注入英文"的视觉跳跃。`bilingual` 让用户保留原文做核对。三种形态下 `history.refined_text` 都只存译文（`translationOnlyText`），跟注入文本不是一回事。

**为什么"译文在上"必须让原文放弃流式**：`injectIncremental` 只能按前缀往后追加（`fullText.startsWith(session.lastInjectedText)` 是硬前提），没有回头往已注入文本前面插字的能力。译文要占住最上面，原文就只能等 phase 2 收尾后整段补在下面——不是没做，是做不了。代价是 `translation_first` 下 phase 2 失败时原文一起丢（与 `target_only` 的失败语义一致，history 标 failed）。

### FSM 切换点

`recording.ts` 翻译路径：

1. 录音结束 → `transcribing`
2. phase 1 流式（bilingual + source_first）/ 静默（target_only、bilingual + translation_first）
3. phase 1 done → 主动 `setState({ state: "translating" })`
4. phase 2 onChunk 复用普通 `onChunk`（其内部仅在 `state === "transcribing"` 时切到 `injecting`，所以 `translating` 不会被覆盖，整个 phase 2 期间保持 `translating`）
5. phase 2 done → 末尾兜底 paste + `idle`

`isInjectFlowActive()` 三个状态都算 active：`transcribing | injecting | translating`，让 ESC / history 写入 / 末尾兜底门控统一。

## 与现有 docs 关系

替换 [`docs/speech-providers.md`](./speech-providers.md) 中 `llm.polish` capability 走的旧 V4 工具调用路径。前端 / Rust 端均已不再实现该旧通道，AI refine 只走本页定义的 chat completions 协议。
