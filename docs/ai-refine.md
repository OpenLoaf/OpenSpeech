# AI 文本改写（AI Refine）

> SSoT：本页定义 AI_REFINE 听写模式松开按键后的「文本改写」业务规则。前端组件 / Rust 命令 / settings 字段统一以本页为准。

提供「云端模式（saas）/ 自定义模式（custom）」两种 chat 调用方式，全部走标准 OpenAI 兼容 chat completions 协议（async-openai SDK）。

## 模式

| 模式 | 端点 | 鉴权 | 模型 | 适用 |
|---|---|---|---|---|
| `saas` | `<SaaSClientConfig.base_url> + V3Variant.endpoint` | `Authorization: Bearer <SDK access_token>` | `V3Variant.id`（取 `client.ai().fast_chat_variant()` 标记 `is_fast` 的快速模型） | OpenLoaf 已登录用户的默认通道；扣积分；选最快可用 chat 模型 |
| `custom` | 用户填的 `baseUrl`（如 `https://api.openai.com/v1`） | `Authorization: Bearer <用户 API Key>` | 用户填的 `model`（如 `gpt-4o-mini`） | 自带钥匙；不走 OpenLoaf；可加多个供应商但**同一时刻只能激活一个** |

两种模式都用 async-openai 的 `Client::with_config(OpenAIConfig::new().with_api_base(base).with_api_key(key))` + `chat().create_stream(...)`，事件路径一致：每个 chunk 走 `openspeech://ai-refine:delta`，结束 `openspeech://ai-refine:done`，错误 `openspeech://ai-refine:error`。

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

## 历史上下文 / 热词 / 时间（context message）

历史 / 热词 / 请求时间不走 chat memory pair，而是合并到**第一条 user message**里，封装为 `<system-tag>` 块；用户实际文本作为**第二条 user message**。提示词约定见 `src/lib/defaultAiPrompts.ts`。

- `includeHistory` 默认 `true`。从 `historyStore` 取最近 `N=5` 条 `success` 记录，按时间正序拼成 `[<分钟前> 文本]` 字符串数组。"分钟前" 走 i18n key `settings:ai.minutes_ago`。
- 热词从 `getHotwordsForRefine().hotwords` 拿，逗号串拆数组传给 Rust。
- requestTime 由前端取 `new Date().toISOString() + " (UTC)"`。

Rust `build_context_message` 负责把这三段合成单一 user message；任一段为空就跳过该段；三段全空则不插 context message（直接 system → user）。

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
}
```

- 请求体走 async-openai BYOT（`create_stream_byot`），body 显式带 `temperature: 0`、`enable_thinking: false`、`stream_options.include_usage: true`，对齐 SaaS chat 期望。
- saas：`openloaf::shared_client().ai().fast_chat_variant()` 拿 model id（`None` ⇒ 抛错由前端兜底）。POST URL 固定为 `<saas_base>/api/v1/chat/completions`（OpenLoaf 兼容 OpenAI 协议端点），key = SDK access_token，body 仍要塞 `variant: <variant.id>`。
- custom：用 `secret_get("ai_provider_<id>")` 取 key；POST URL = `<custom_base>/chat/completions`。
- 事件 payload 都附带 `task_id`，前端按 task_id 路由。

**集成 example**：`src-tauri/examples/test_ai_refine_chat.rs` 复用 `~/.openspeech/dev_session.json` 拿 token，本地一键 `cargo run --example test_ai_refine_chat` 端到端跑一次真实 SaaS chat。

## 与现有 docs 关系

替换 [`docs/speech-providers.md`](./speech-providers.md) 中 `llm.polish` capability 走的旧 V4 工具调用路径。前端 / Rust 端均已不再实现该旧通道，AI refine 只走本页定义的 chat completions 协议。

