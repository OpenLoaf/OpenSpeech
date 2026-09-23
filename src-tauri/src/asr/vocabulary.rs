// Qwen-Audio-3.1 即时热词（`vocabulary`）的出站清洗。
//
// 3.1 的热词只认这个参数：短音频会整条丢弃 system 消息，所以词典偏置只能走这里
// （2026-09-23 SaaS 侧直连上游实测，见 docs/proposals/qwen-audio-3.1-asr.md §九）。
//
// 上游约束与后果：
// - 权重只收 1–5 或 50。越界时上游**静默丢掉整张表**，SaaS 新版改为直接 400 /
//   INVALID_PARAMS——任何一条越界都会让整次识别失败，所以这里必须夹紧。
// - 最多 1000 个词，每词 ≤ 64 字。
//
// 前端 `buildAsrVocabulary()` 已按优先级（用户词典 > 领域 > 热门）裁剪过；这里是最后
// 一道防线，防止老前端 / 手改设置把非法值送上去。

use std::collections::BTreeMap;

/// 上游热词表的词条上限。
pub const MAX_WORDS: usize = 1000;
/// 单个热词的字数上限（按 char 计）。
pub const MAX_WORD_CHARS: usize = 64;
/// 上游认可的特殊权重（强制命中档）。
const FORCE_WEIGHT: u8 = 50;

/// 把前端给的热词表清洗成上游一定接受的形态；清洗后为空返回 `None`，调用方据此不传字段。
///
/// 超过 [`MAX_WORDS`] 时按权重从高到低保留（同权重按词序），保证用户词典（高权重）优先留下。
pub fn sanitize(raw: Option<BTreeMap<String, u8>>) -> Option<BTreeMap<String, u8>> {
    let raw = raw?;
    let mut entries: Vec<(String, u8)> = raw
        .into_iter()
        .filter_map(|(word, weight)| {
            let word = word.trim().to_string();
            if word.is_empty() || word.chars().count() > MAX_WORD_CHARS {
                return None;
            }
            let weight = if weight == FORCE_WEIGHT {
                FORCE_WEIGHT
            } else {
                weight.clamp(1, 5)
            };
            Some((word, weight))
        })
        .collect();
    if entries.is_empty() {
        return None;
    }
    if entries.len() > MAX_WORDS {
        // 稳定排序：权重降序，同权重保持 BTreeMap 的词序，结果可复现。
        entries.sort_by_key(|e| std::cmp::Reverse(e.1));
        entries.truncate(MAX_WORDS);
    }
    Some(entries.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn map(pairs: &[(&str, u8)]) -> Option<BTreeMap<String, u8>> {
        Some(pairs.iter().map(|(k, v)| (k.to_string(), *v)).collect())
    }

    // 越界权重会让上游整表作废 / SaaS 直接 400，必须夹进 1–5，50 原样保留。
    #[test]
    fn clamps_out_of_range_weights_and_keeps_force_weight() {
        let out = sanitize(map(&[("a", 0), ("b", 6), ("c", 50), ("d", 3), ("e", 255)])).unwrap();
        assert_eq!(out["a"], 1);
        assert_eq!(out["b"], 5);
        assert_eq!(out["c"], 50);
        assert_eq!(out["d"], 3);
        assert_eq!(out["e"], 5);
    }

    // 空词、纯空白、超长词都会被上游拒收，直接剔除。
    #[test]
    fn drops_blank_and_overlong_words() {
        let long = "长".repeat(MAX_WORD_CHARS + 1);
        let out = sanitize(map(&[("  ", 4), ("ok", 4), (long.as_str(), 4)])).unwrap();
        assert_eq!(out.len(), 1);
        assert!(out.contains_key("ok"));
    }

    // 超上限时高权重（用户词典）优先保留，低权重（热门词）先被裁掉。
    #[test]
    fn keeps_highest_weights_when_over_limit() {
        let mut m = BTreeMap::new();
        for i in 0..MAX_WORDS {
            m.insert(format!("low{i:04}"), 2);
        }
        m.insert("zzz-user-term".to_string(), 4);
        let out = sanitize(Some(m)).unwrap();
        assert_eq!(out.len(), MAX_WORDS);
        assert!(out.contains_key("zzz-user-term"));
    }

    // 清洗后什么都不剩就不该发一个空表上去。
    #[test]
    fn returns_none_when_nothing_survives() {
        assert!(sanitize(map(&[(" ", 4)])).is_none());
        assert!(sanitize(None).is_none());
    }
}
