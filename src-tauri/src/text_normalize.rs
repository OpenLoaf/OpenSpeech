// ASR 输出文本归一。
//
// ASR 模型（尤其 realtime）在停顿/断句处会吐出重复标点，典型 `，，`，全链路其余
// 环节（merge_segments 原样拼接、postprocess 只砍尾句号）都不折叠。这里在 ASR
// 原始输出层确定性收掉：把连续相同的全角标点折叠成一个。
//
// 只折叠"连续相同"的全角标点，所以中文省略号 `……`（U+2026 连写）天然保留，
// ASCII `...` / 小数 / 网址也因不在集合内而不受影响。

const COLLAPSIBLE: &[char] = &['，', '。', '、', '；', '：', '！', '？'];

/// 折叠连续相同的全角标点为一个；其余字符原样保留。
pub fn normalize_asr_punctuation(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev: Option<char> = None;
    for c in s.chars() {
        // 与上一个落盘字符相同且属于可折叠标点 → 跳过，prev 不变。
        if prev == Some(c) && COLLAPSIBLE.contains(&c) {
            continue;
        }
        out.push(c);
        prev = Some(c);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn collapses_double_comma() {
        assert_eq!(normalize_asr_punctuation("我希望，，我现在"), "我希望，我现在");
        assert_eq!(normalize_asr_punctuation("形式，，可以"), "形式，可以");
    }

    #[test]
    fn collapses_runs_of_three_or_more() {
        assert_eq!(normalize_asr_punctuation("，，，"), "，");
        assert_eq!(normalize_asr_punctuation("好的。。。结束"), "好的。结束");
    }

    #[test]
    fn collapses_all_fullwidth_punct() {
        assert_eq!(normalize_asr_punctuation("一、、二"), "一、二");
        assert_eq!(normalize_asr_punctuation("甲；；乙"), "甲；乙");
        assert_eq!(normalize_asr_punctuation("注：：内容"), "注：内容");
        assert_eq!(normalize_asr_punctuation("什么？？"), "什么？");
        assert_eq!(normalize_asr_punctuation("快！！"), "快！");
    }

    #[test]
    fn preserves_chinese_ellipsis() {
        assert_eq!(normalize_asr_punctuation("等等……"), "等等……");
        assert_eq!(normalize_asr_punctuation("……开头"), "……开头");
    }

    #[test]
    fn leaves_ascii_untouched() {
        assert_eq!(normalize_asr_punctuation("a..b"), "a..b");
        assert_eq!(normalize_asr_punctuation("1,,000"), "1,,000");
        assert_eq!(normalize_asr_punctuation("see..."), "see...");
    }

    #[test]
    fn does_not_collapse_different_adjacent_punct() {
        assert_eq!(normalize_asr_punctuation("好的，。"), "好的，。");
        assert_eq!(normalize_asr_punctuation("真的？！"), "真的？！");
    }

    #[test]
    fn noop_on_clean_text() {
        assert_eq!(normalize_asr_punctuation("你好，世界。"), "你好，世界。");
        assert_eq!(normalize_asr_punctuation(""), "");
        assert_eq!(normalize_asr_punctuation("没有标点的句子"), "没有标点的句子");
    }

    #[test]
    fn collapses_multiple_sites_in_one_pass() {
        assert_eq!(
            normalize_asr_punctuation("我希望，，开发，以 app 的形式，，可以"),
            "我希望，开发，以 app 的形式，可以",
        );
    }
}
