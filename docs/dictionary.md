# 词典规则

## 目的

提升专有名词、行业术语、生僻拼写的转写准确率。词典内容会作为 hints 附带在发给大模型的 REST 请求中。

## 条目结构

| 字段 | 说明 |
|---|---|
| id | 唯一 ID |
| term | 正确写法（目标输出） |
| aliases | 可选的发音近似词 / 常见错写（供模型匹配） |
| source | `manual`（手动）/ `auto`（异步 AI agent 决策） |
| enabled | 是否参与提示（默认 true） |
| created_at | 创建时间 |
| updated_at | 上次修改时间（手动改 / agent update）；老条目为 NULL |
| created_by | `manual` / `agent`；区分手动添加与 AI 决策添加。schema v13 之前的老条目为 NULL，按 `manual` 处理 |

## 分类

按来源分三类：

- **全部**：所有条目
- **自动添加**：从历史记录中自动识别出"用户手动修正过的词"（迭代功能，MVP 不必实现）
- **手动添加**：用户主动录入

## 用户操作

| 操作 | 规则 |
|---|---|
| 新词 | 点击"新词"按钮，弹出表单，必填 term |
| 编辑 | 支持修改 term / aliases / enabled |
| 删除 | 单条删除，无需二次确认 |
| 搜索 | 模糊匹配 term 与 aliases |
| 启用/禁用 | 可批量禁用而不删除，便于临时调整 |

## 业务约束

1. term 不得为空；空格全角/半角归一化。
2. 单个用户的词典上限 **2,000 条**；超过时禁止新增并提示。
3. 发送到大模型的 hints **最多 100 条**；选取策略：优先 `enabled=true` 的条目，按近 30 天命中频率排序（MVP 可直接取前 100 条）。
4. 词典为**每用户独立**，不跨设备同步（本地存储）。
5. 导出/导入：支持 JSON 格式导出与导入，用于备份与迁移。

## 自动收录（异步 AI Agent）

用户在历史记录里手动改写一条 ASR 结果时，系统异步把 `(原文 baseline, 用户改后 edited, 当前字典)` 喂给 LLM，由模型决定是否更新字典。**入库即生效**，不进候选区，不需要用户二次确认——交给模型把控宁缺勿滥。

- **触发**：history 写入 `text_edited` 后 emit `openspeech://history-text-edited`，前端订阅器调 Rust `analyze_dictionary_correction`（见 `src/lib/dictionaryAgent.ts` / `src-tauri/src/dictionary_agent/mod.rs`）。
- **链路**：Rust 复用 `ai_refine::resolve_saas` 拿到 SaaS chat completions 端点 + fast_chat_variant；走 `/api/v1/chat/completions`，body 加 `response_format: { "type": "json_object" }` 强制模型出 JSON。
- **Prompt 输入**：BaselineText / EditedText / CurrentDictionary（前 200 条 enabled=true，按 created_at DESC）。`docs/ai-refine.md` 里那一条 `<system-tag type="ConversationHistory">` 的格式不在此处复用，agent 用自己的 `<BaselineText> / <EditedText> / <CurrentDictionary>` 三段格式。
- **输出 schema**：

```json
{
  "decisions": [
    { "action": "add",    "term": "<正确写法>", "aliases": ["<原错词>"] },
    { "action": "update", "id": "<dict id>", "addAliases": ["<新别名>"] },
    { "action": "delete", "id": "<dict id>", "reason": "..." },
    { "action": "noop",   "reason": "..." }
  ]
}
```

`update` 走**增量加别名**（`addAliases`），不会替换原 aliases，避免模型抹掉用户手动加过的。`delete` 默认不会触发，模型 prompt 里被强制约束为"罕见操作"。

- **失败容忍**：未登录 / 网络失败 / JSON 解析失败 / 模型返回 `noop` —— 一律静默跳过，console.warn 而已，不打扰用户。**永远不会因为 agent 失败把已经保存的 `text_edited` 回滚**。
- **去重**：`add` 命中已存（`LOWER(term)` 唯一索引）会自动退化成 `update` 加别名。
- **限额**：`DICT_LIMIT = 2000`（同手动添加），到顶时 `add` 跳过；`update` 不受限。
- **入库标记**：agent 添加的条目 `source = 'auto'` + `created_by = 'agent'`，便于词典页 UI 视觉区分。
