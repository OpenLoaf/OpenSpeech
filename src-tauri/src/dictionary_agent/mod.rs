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
}

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictAgentEntry {
    pub id: String,
    pub term: String,
    #[serde(default)]
    pub aliases: Vec<String>,
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
    log::info!(
        "[dict_agent] enter history_id={:?} baseline_len={} edited_len={} dict_size={}",
        input.history_id,
        input.baseline.chars().count(),
        input.edited.chars().count(),
        input.dictionary.len(),
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
- <CurrentDictionary>: 当前字典里所有已存条目，每条形如 `id=... | term="..." | aliases=[...]`。term 是希望模型输出的"正确写法"，aliases 是常见的同音误识别。
</reference_tags>

<core_rules>
1. 判断标准：把 BaselineText vs EditedText 当成"ASR 把 X 错听成 Y"的样本——若 X 与 Y **同音 / 谐音 / 近形 / 近发音**，且 Y 看起来更像合理的目标输出（专有名词、术语、人名、项目名、常见词的正确写法），就值得入字典。**不必等错误重复出现**——一次明显的同音误识别就足够 add 一条偏置。
2. add：BaselineText 中的错词在 CurrentDictionary 里**完全没有 term 或 alias 命中**；EditedText 里对应的正确写法清晰可定位。返回 `{ "action": "add", "term": "<正确写法>", "aliases": ["<原错词>"] }`。
3. update：BaselineText 中的错词正好可以归到 CurrentDictionary 已有某条 term 名下（之前未收录的别名），返回 `{ "action": "update", "id": "<已有条目 id>", "addAliases": ["<新别名>"] }`。**只增量加**，不会替换原 aliases。
4. delete：极少使用。仅当用户把 CurrentDictionary 某条 term 改回一个**与该条目意图完全相反**的写法时返回 `{ "action": "delete", "id": "<...>" }`。默认不要 delete。
5. noop：以下场景一律 noop——
   - 编辑只是改语序、语气、标点、空格、换行、繁简切换。
   - 编辑是整段改写或大幅删改（差异超过 30% 字符），无法定位单一错词。
   - 编辑是补充 / 删除多余口头语（如去掉"嗯"、"那个"），不是错听。
   - 错词与正确写法读音 / 字形完全不相关（用户在做内容改写而非纠错）。
   - 任何拿不准的情况——错误入库会污染所有后续 ASR，宁缺勿滥。
6. 输出 JSON 形如：
```
{
  "decisions": [
    { "action": "add" | "update" | "delete" | "noop", ... }
  ]
}
```
通常 `decisions` 数组只含 1 条。同一次编辑里若同时出现多个独立误识别词，可返回多条 decision。
7. term 不为空、不超过 60 字。aliases 中不允许与 term 字面一致的项。所有字符串用 UTF-8。
8. 不要在 JSON 外输出任何额外文字。不要解释，不要 markdown 包裹。直接返回纯 JSON 对象。
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
                format!(
                    "- id={} | term=\"{}\" | aliases={}",
                    e.id,
                    escape_quote(&e.term),
                    aliases
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    format!(
        "<BaselineText>\n{}\n</BaselineText>\n\n<EditedText>\n{}\n</EditedText>\n\n<CurrentDictionary>\n{}\n</CurrentDictionary>",
        input.baseline, input.edited, dict_block,
    )
}

fn escape_quote(s: &str) -> String {
    s.replace('"', "&quot;")
}
