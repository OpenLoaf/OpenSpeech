// 异步字典维护 Agent。
//
// 触发：用户在历史记录里手动改写一条 ASR 结果（HISTORY_TEXT_EDITED_EVENT）。
// 任务：把 (baseline, edited, current_dictionary) 喂给 LLM，由模型用 JSON
// structured output 决定 add / update / delete / noop。本模块只负责调一次 chat
// completion 拿回模型的 plan JSON，前端解析后 dispatch 到 dictionary store。
//
// 走 SaaS chat completions（同 ai_refine 的 fast_chat_variant），共用
// `ai_refine::resolve_saas` 拿端点。失败一律不抛错给 UI——前端只 console.warn。
//
// 不走 stream：plan 体积小（几条 decision），等完整 response 比 SSE 解析简单且
// 等价。`response_format: json_object` —— OpenAI 兼容协议里跨 backend 最稳的
// 结构化输出开关；schema 用 prompt 文字约束。

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tauri::{AppHandle, Runtime};

use crate::ai_refine::resolve_saas;

const ERR_HTTP: &str = "dictionary_agent_http";
const ERR_PARSE: &str = "dictionary_agent_parse";
const ERR_EMPTY: &str = "dictionary_agent_empty";

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryAgentInput {
    pub baseline: String,
    pub edited: String,
    #[serde(default)]
    pub dictionary: Vec<DictAgentEntry>,
    #[serde(default)]
    pub history_id: Option<String>,
    /// 前端扫最近 N 条已编辑历史得到的"反复纠正同一字段"信号。空时不注入。
    /// 让模型看到"用户已经第 3 次把 X 改成 Y"——这是必入库的强信号。
    #[serde(default)]
    pub recent_corrections: Option<Vec<RecentCorrection>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentCorrection {
    /// ASR 原识别（错听）
    pub wrong: String,
    /// 用户改成的版本（正确写法）
    pub correct: String,
    /// 最近 N 条历史里这条"X → Y"出现了几次（含本次）
    pub count: u32,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictAgentEntry {
    pub id: String,
    pub term: String,
    #[serde(default)]
    pub aliases: Vec<String>,
    /// 历次 agent 决策落下来的"含义/为什么入库"说明。给模型当上下文，让它能利用
    /// 旧条目的语义判断本次纠错是否归到同一项；同时避免重复 add 同一术语换个 reason。
    #[serde(default)]
    pub note: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictionaryAgentResult {
    /// 模型返回的 plan JSON 文本。前端 JSON.parse 后按 action 分发。
    pub plan: String,
    pub model: String,
}

#[tauri::command]
pub async fn analyze_dictionary_correction<R: Runtime>(
    app: AppHandle<R>,
    input: DictionaryAgentInput,
) -> Result<DictionaryAgentResult, String> {
    let recent_count = input
        .recent_corrections
        .as_ref()
        .map(|v| v.len())
        .unwrap_or(0);
    log::info!(
        "[dict_agent] enter history_id={:?} baseline_len={} edited_len={} dict_size={} recent_corrections={}",
        input.history_id,
        input.baseline.chars().count(),
        input.edited.chars().count(),
        input.dictionary.len(),
        recent_count,
    );

    let resolved = resolve_saas(&app).await?;

    let system_prompt = build_system_prompt();
    let user_msg = build_user_message(&input);

    let mut body = json!({
        "model": resolved.model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_msg },
        ],
        "temperature": 0,
        "enable_thinking": false,
        "stream": false,
        "response_format": { "type": "json_object" },
    });
    if let Some(vid) = resolved.variant_id.as_ref() {
        body["variant"] = Value::String(vid.clone());
    }

    let envelope = json!({
        "url": resolved.full_url,
        "model": resolved.model,
        "variantId": resolved.variant_id,
        "body": body,
    });
    match serde_json::to_string_pretty(&envelope) {
        Ok(s) => log::info!(
            "[dict_agent] request history_id={:?}\n{}",
            input.history_id,
            s
        ),
        Err(e) => log::warn!("[dict_agent] request envelope serialize failed: {e}"),
    }

    let resp = crate::http::client()
        .post(&resolved.full_url)
        .bearer_auth(&resolved.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{ERR_HTTP}: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("{ERR_HTTP}: HTTP {status}: {txt}"));
    }

    let raw_text = resp
        .text()
        .await
        .map_err(|e| format!("{ERR_PARSE}: {e}"))?;
    log::info!(
        "[dict_agent] response history_id={:?}\n{}",
        input.history_id,
        raw_text
    );
    let parsed: Value =
        serde_json::from_str(&raw_text).map_err(|e| format!("{ERR_PARSE}: {e}"))?;

    let content = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| format!("{ERR_EMPTY}: no choices[0].message.content"))?
        .to_string();

    log::info!(
        "[dict_agent] done history_id={:?} plan_len={} plan={}",
        input.history_id,
        content.chars().count(),
        content,
    );

    Ok(DictionaryAgentResult {
        plan: content,
        model: resolved.model,
    })
}

fn build_system_prompt() -> String {
    r#"<role>
你是 OpenSpeech 的字典维护 Agent。OpenSpeech 是语音输入应用，用户对一条 ASR 结果做了人工修正后，会把修正喂给你，由你决定是否更新本地字典（用于后续 ASR 偏置）。
</role>

<reference_tags>
- <BaselineText>: ASR 给出的原始 / AI 优化后的最终文本（用户改之前看到的版本）。
- <EditedText>: 用户改完后的最终文本。
- <CurrentDictionary>: 当前字典里所有已存条目，每条形如 `id=... | term="..." | aliases=[...] | note="..."`。term 是希望模型输出的"正确写法"，aliases 是常见的同音误识别，note 是该条目的含义/上次入库原因（历史决策痕迹）。
- <RecentCorrections>（可选段，空时不出现）: 最近若干条历史里，用户**重复**把同一个 ASR 误识别改成同一正确写法的统计。每条形如 `wrong="X" correct="Y" count=N`。count 含本次。这是用户行为给的最强信号：他都改 N 次了，就是要这个词。
</reference_tags>

<core_rules>
1. 判断标准：把 BaselineText vs EditedText 当成"ASR 把 X 错听成 Y"的样本——若 X 与 Y **同音 / 谐音 / 近形 / 近发音**，且 Y 看起来更像合理的目标输出（专有名词、术语、人名、项目名、常见词的正确写法），就值得入字典。**不必等错误重复出现**——一次明显的同音误识别就足够 add 一条偏置。
2. add：BaselineText 中的错词在 CurrentDictionary 里**完全没有 term 或 alias 命中**；EditedText 里对应的正确写法清晰可定位。返回 `{ "action": "add", "term": "<正确写法>", "aliases": ["<原错词>"], "reason": "<一句话说明>" }`。
3. update：BaselineText 中的错词正好可以归到 CurrentDictionary 已有某条 term 名下（之前未收录的别名），返回 `{ "action": "update", "id": "<已有条目 id>", "addAliases": ["<新别名>"], "reason": "<一句话说明>" }`。**只增量加**，不会替换原 aliases。
4. delete：极少使用。仅当用户把 CurrentDictionary 某条 term 改回一个**与该条目意图完全相反**的写法时返回 `{ "action": "delete", "id": "<...>", "reason": "<一句话说明>" }`。默认不要 delete。
5. **强制 add（禁止 noop）的情况**：
   - <RecentCorrections> 中某条 `count ≥ 2`、且 wrong↔correct **同音 / 谐音 / 近音**、且 CurrentDictionary 没有任何 term/alias 命中 correct 或 wrong：**必须** 返回 `{ "action": "add", "term": "<correct>", "aliases": ["<wrong>"], "reason": "<...>"}`。这是用户反复改的硬信号，不许保守判 noop。
   - 同上但 correct 已是某条 term：必须 `{ "action": "update", "id": "...", "addAliases": ["<wrong>"], "reason": "..." }`。
6. noop：以下场景一律 noop——
   - 编辑只是改语序、语气、标点、空格、换行、繁简切换。
   - 编辑是整段改写或大幅删改（差异超过 30% 字符），无法定位单一错词。
   - 编辑是补充 / 删除多余口头语（如去掉"嗯"、"那个"），不是错听。
   - 错词与正确写法读音 / 字形完全不相关（用户在做内容改写而非纠错）。
   - 任何拿不准的情况——错误入库会污染所有后续 ASR，宁缺勿滥。
   - **例外**：上一条"强制 add"成立时，本条不适用——优先入库。
7. 输出 JSON 形如：
```
{
  "decisions": [
    { "action": "add" | "update" | "delete" | "noop", ... }
  ]
}
```
通常 `decisions` 数组只含 1 条。同一次编辑里若同时出现多个独立误识别词，可返回多条 decision。
8. term 不为空、不超过 60 字。aliases 中不允许与 term 字面一致的项。所有字符串用 UTF-8。
9. **add / update / delete 必须带 `reason` 字段**——一句中文（≤ 60 字）说明这条 term 的**含义 / 适用领域 / 为什么这次值得入库**，让用户在字典里能一眼读懂。例如 `"项目名 OpenSpeech，常被识别成 '欧片速器'"`、`"开源库 tRPC，注意大小写"`。**不要**只复述"用户把 X 改成了 Y"，要写"是什么"或"为什么这样写才对"。noop 决策可省略 reason。
10. 不要在 JSON 外输出任何额外文字。不要解释，不要 markdown 包裹。直接返回纯 JSON 对象。
</core_rules>"#.to_string()
}

fn build_user_message(input: &DictionaryAgentInput) -> String {
    let dict_block = if input.dictionary.is_empty() {
        "(空)".to_string()
    } else {
        input
            .dictionary
            .iter()
            .map(|e| {
                let aliases = if e.aliases.is_empty() {
                    "[]".to_string()
                } else {
                    let parts: Vec<String> = e
                        .aliases
                        .iter()
                        .map(|a| format!("\"{}\"", escape_quote(a)))
                        .collect();
                    format!("[{}]", parts.join(", "))
                };
                let note = e
                    .note
                    .as_deref()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| format!(" | note=\"{}\"", escape_quote(s)))
                    .unwrap_or_default();
                format!(
                    "- id={} | term=\"{}\" | aliases={}{}",
                    e.id,
                    escape_quote(&e.term),
                    aliases,
                    note,
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let recent_block = input
        .recent_corrections
        .as_ref()
        .filter(|v| !v.is_empty())
        .map(|v| {
            let lines: Vec<String> = v
                .iter()
                .filter(|r| !r.wrong.trim().is_empty() && !r.correct.trim().is_empty())
                .map(|r| {
                    format!(
                        "- wrong=\"{}\" correct=\"{}\" count={}",
                        escape_quote(&r.wrong),
                        escape_quote(&r.correct),
                        r.count,
                    )
                })
                .collect();
            if lines.is_empty() {
                String::new()
            } else {
                format!(
                    "\n\n<RecentCorrections>\n{}\n</RecentCorrections>",
                    lines.join("\n"),
                )
            }
        })
        .unwrap_or_default();

    format!(
        "<BaselineText>\n{}\n</BaselineText>\n\n<EditedText>\n{}\n</EditedText>\n\n<CurrentDictionary>\n{}\n</CurrentDictionary>{}",
        input.baseline, input.edited, dict_block, recent_block,
    )
}

fn escape_quote(s: &str) -> String {
    s.replace('"', "&quot;")
}

// ============================================================================
// 批量抽词：用户粘贴一段任意文本（术语清单 / 文章段落 / 中英对照表），
// 由 LLM 决定哪些条目值得入字典。和 analyze_dictionary_correction 共用 SaaS
// 端点和 json_object 协议；输出 `{ items: [...] }`，前端再让用户勾选确认。
// ============================================================================

const EXTRACT_MAX_TEXT_CHARS: usize = 12_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractTermsInput {
    pub text: String,
    #[serde(default)]
    pub dictionary: Vec<DictAgentEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractTermsResult {
    /// 模型返回的 JSON 文本，前端 JSON.parse 后取 items 列。
    pub plan: String,
    pub model: String,
}

#[tauri::command]
pub async fn extract_dictionary_terms<R: Runtime>(
    app: AppHandle<R>,
    input: ExtractTermsInput,
) -> Result<ExtractTermsResult, String> {
    let text = input.text.trim();
    if text.is_empty() {
        return Err("extract_terms_empty".to_string());
    }
    let text_for_model: String = if text.chars().count() > EXTRACT_MAX_TEXT_CHARS {
        text.chars().take(EXTRACT_MAX_TEXT_CHARS).collect()
    } else {
        text.to_string()
    };
    log::info!(
        "[dict_extract] enter text_chars={} dict_size={}",
        text_for_model.chars().count(),
        input.dictionary.len(),
    );

    let resolved = resolve_saas(&app).await?;

    let system_prompt = build_extract_system_prompt();
    let user_msg = build_extract_user_message(&text_for_model, &input.dictionary);

    let mut body = json!({
        "model": resolved.model,
        "messages": [
            { "role": "system", "content": system_prompt },
            { "role": "user", "content": user_msg },
        ],
        "temperature": 0,
        "enable_thinking": false,
        "stream": false,
        "response_format": { "type": "json_object" },
    });
    if let Some(vid) = resolved.variant_id.as_ref() {
        body["variant"] = Value::String(vid.clone());
    }

    let resp = crate::http::client()
        .post(&resolved.full_url)
        .bearer_auth(&resolved.api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("{ERR_HTTP}: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let txt = resp.text().await.unwrap_or_default();
        return Err(format!("{ERR_HTTP}: HTTP {status}: {txt}"));
    }

    let raw_text = resp
        .text()
        .await
        .map_err(|e| format!("{ERR_PARSE}: {e}"))?;
    log::info!("[dict_extract] response\n{}", raw_text);
    let parsed: Value =
        serde_json::from_str(&raw_text).map_err(|e| format!("{ERR_PARSE}: {e}"))?;

    let content = parsed
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_str())
        .ok_or_else(|| format!("{ERR_EMPTY}: no choices[0].message.content"))?
        .to_string();

    Ok(ExtractTermsResult {
        plan: content,
        model: resolved.model,
    })
}

fn build_extract_system_prompt() -> String {
    r#"<role>
你是 OpenSpeech 的字典批量入库助手。用户粘贴了一段文本（可能是术语清单、中英对照表、Markdown 列表、文章段落，或一段对话），你的任务是从中提取出"值得作为语音输入偏置词加入用户字典"的术语。这些字典条目会作为 hints 喂给 ASR / LLM，提升用户在语音输入时把"听起来像但实际不是"的同音词识别为正确写法的概率。
</role>

<reference_tags>
- <RawText>: 用户原始粘贴的文本，可能含 Markdown / bullet / 中英混排。
- <CurrentDictionary>: 用户已有的字典条目，每条形如 `term="..." | aliases=[...]`。**已有的 term 不要再提**，否则会被前端去重忽略。aliases 只是参考。
</reference_tags>

<core_rules>
1. 收录优先级（由高到低）：
   a) **专有名词 / 项目名 / 产品名 / 品牌**（如 OpenSpeech、tRPC、Postgres）。
   b) **人名 / 公司名 / 地名**（含外文音译）。
   c) **行业术语 / 技术词汇 / 缩写**（如 bilge、CRDT、SPAKE2、舵叶、堵漏毯）。
   d) 用户明显**特意列出来**的清单条目（即使是常用词，但出现在 bullet / 编号列表 / 表格里），按"用户在意"原则也可收录。
2. **不要**收录：
   - 常用日常词（吃 / 喝 / 你好 / 今天 / 我们）。
   - 通用动词、形容词、副词、介词、连词、量词。
   - 标点、纯数字、emoji、网址、单字、空白。
   - <CurrentDictionary> 里已存在的 term（大小写不敏感）。
3. **term 字段 —— 严格按用户原文里的语言/写法收录**：
   - 用户原文只有中文，term 用中文。
   - 用户原文只有英文，term 用英文。
   - 用户原文是**中英对照**（如 "船首 bow / head"、"备锚 prepare anchor"、"中文释义 + 英文术语"）：**拆成两条独立 item** —— 一条中文 term，一条英文 term。**绝不允许只取英文那一侧**——用户说哪种语言哪种就要被偏置，跨语言放 aliases 即可。
   - 用户原文是其他外语，term 用该外语。
   - **不要主动翻译**用户原文没出现的语种（用户没写英文就不要给中文术语配英文 term）。
4. **aliases 字段**（可选）：
   - term 是中文时，可填同音字 / 近音词 / 常见错听（如 "bilge"-"毕奇"）。
   - term 是英文时，可填常见错拼或音译近似中文。
   - **中英对照拆成的两条之间互填 aliases**：中文条目的 aliases 放对应英文写法（如 term="船首"，aliases=["bow", "head"]），英文条目的 aliases 放对应中文（如 term="bow"，aliases=["船首"]）。这样用户说任一语言都能命中。
   - 没把握就留空数组。aliases 不允许与 term 字面一致。
5. **reason 字段**（必填，≤ 50 字）：一句中文说明这个术语**是什么 / 哪个领域 / 为什么值得入字典**。例：`"船舶舱底污水，行业术语"`、`"开源项目名，常被识别成'TR PC'"`。**不要**复述用户原文。
6. **去重**：同一个 term 只返回一次。`items` 数组按"信息密度优先"排序，最值得用户保留的放前面。
7. **数量上限**：本次最多返回 100 条（中英对照拆出的两条各占 1 个名额）。超过 100 时只保留最高优先级的 100 条。
8. **任意文本支持**：
   - 输入是清单 / 词表（每行 1 条）时：高召回——只要符合规则 1，都可收录。
   - 输入是连续叙述文本时：低召回——只挑专有名词、术语、项目名、人名、行业关键词，不要把每个名词都入库。
   - 输入完全没有可入库的术语（如纯口语对话、纯数字、纯日常句）时：返回 `{ "items": [] }`。
9. 输出**纯 JSON**对象，形如：
```
{
  "items": [
    { "term": "船首", "aliases": ["bow", "head"], "reason": "船舶部位，船头" },
    { "term": "bow", "aliases": ["船首"], "reason": "Bow，英文船首术语" },
    { "term": "舵叶", "aliases": ["rudder blade"], "reason": "船舶操纵部位" },
    { "term": "bilge", "aliases": ["毕奇", "舱底"], "reason": "船舶舱底污水" }
  ]
}
```
10. 严禁在 JSON 外输出任何文字、解释、markdown 包裹。直接给 JSON 对象。
</core_rules>"#.to_string()
}

fn build_extract_user_message(text: &str, dict: &[DictAgentEntry]) -> String {
    let dict_block = if dict.is_empty() {
        "(空)".to_string()
    } else {
        dict.iter()
            .map(|e| {
                let aliases = if e.aliases.is_empty() {
                    "[]".to_string()
                } else {
                    let parts: Vec<String> = e
                        .aliases
                        .iter()
                        .map(|a| format!("\"{}\"", escape_quote(a)))
                        .collect();
                    format!("[{}]", parts.join(", "))
                };
                format!(
                    "- term=\"{}\" | aliases={}",
                    escape_quote(&e.term),
                    aliases,
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };
    format!(
        "<RawText>\n{}\n</RawText>\n\n<CurrentDictionary>\n{}\n</CurrentDictionary>",
        text, dict_block,
    )
}
