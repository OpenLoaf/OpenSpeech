// AI refine 输出后置处理：按 strip_trailing_period 模式砍尾句号。
//
// 流式背景：refine 边收 delta 边经前端 inject 到目标 app。整段 done
// 才砍尾来不及——句号已经被注入了。所以采用 "tail-hold" 策略：
// 收到 delta 时 hold 住末尾可能是句号的那一个字符，等下一段 delta 来
// 再决定 emit 还是丢弃，整段结束时按规则决断 hold 内容。
//
// 用户设置可选 off/auto/always：
//   - off:    完全不砍（hold 的尾巴在 done 时原样吐出）
//   - auto:   走全规则——用户原话尾本来就是句号则保留、`etc.` 缩写
//             和省略号不砍、引号闭合内部砍但闭合符保留、emoji/语气标点不砍
//   - always: 无视用户原话也砍（仍然放过缩写/省略号/引号/emoji/语气）

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StripMode {
    Off,
    Auto,
    Always,
}

impl StripMode {
    pub fn from_str_or_auto(s: Option<&str>) -> Self {
        match s.unwrap_or("auto") {
            "off" => Self::Off,
            "always" => Self::Always,
            _ => Self::Auto,
        }
    }
}

/// 这些字符算"潜在尾句号"。
fn is_period_char(c: char) -> bool {
    matches!(c, '。' | '．' | '.' | '｡')
}

/// done 阶段对整段 full 做"最终砍尾"。考虑闭合符场景：
/// 末尾形如 `xxx。"` 或 `xxx。」` 时，把句号砍掉、闭合符留下。
pub fn strip_full_at_end(full: &str, user_text: &str, mode: StripMode) -> String {
    if matches!(mode, StripMode::Off) {
        return full.to_string();
    }

    let trimmed_end = full.trim_end_matches([' ', '\t']);
    let trailing_whitespace = &full[trimmed_end.len()..];

    let chars: Vec<char> = trimmed_end.chars().collect();
    if chars.is_empty() {
        return full.to_string();
    }

    // 末尾是闭合符（引号 / 括号）？回退一位看是不是句号。
    let last = *chars.last().unwrap();
    let closing_chars = ['"', '\'', '"', '"', '」', '』', ')', '）', ']', '】'];
    if closing_chars.contains(&last) && chars.len() >= 2 {
        let prev = chars[chars.len() - 2];
        if is_period_char(prev)
            && should_strip_final(prev, &chars[..chars.len() - 2], user_text, mode)
        {
            let kept: String = chars[..chars.len() - 2].iter().collect();
            return format!("{kept}{last}{trailing_whitespace}");
        }
        return full.to_string();
    }

    if !is_period_char(last) {
        return full.to_string();
    }

    if should_strip_final(last, &chars[..chars.len() - 1], user_text, mode) {
        let kept: String = chars[..chars.len() - 1].iter().collect();
        format!("{kept}{trailing_whitespace}")
    } else {
        full.to_string()
    }
}

/// 决定最终是否砍掉这个尾句号字符。
/// `prefix` 是去掉 tail 之后的字符序列（已 trim 末尾空白）。
fn should_strip_final(tail: char, prefix: &[char], user_text: &str, mode: StripMode) -> bool {
    if matches!(mode, StripMode::Off) {
        return false;
    }

    // 语气标点 / emoji / 表情，本身就不会进入这里（is_period_char 不匹配）。

    // 省略号场景：`...` 或前面是 `…`
    if tail == '.' {
        if let Some(p) = prefix.last() {
            if *p == '.' || *p == '…' {
                return false;
            }
        }
    }

    // always 模式：到这里就直接砍
    if matches!(mode, StripMode::Always) {
        return true;
    }

    // auto 模式：用户原话末尾本来就是句号 → 保留
    if user_text
        .trim_end()
        .chars()
        .last()
        .map(is_period_char)
        .unwrap_or(false)
    {
        return false;
    }
    true
}

/// 流式 hold-tail 处理器。
pub struct StreamingStripper {
    held_tail: Option<char>,
}

impl StreamingStripper {
    pub fn new() -> Self {
        Self { held_tail: None }
    }

    /// 收到一段 delta，返回 "应该立即 emit 给前端" 的部分。剩下的潜在
    /// 尾句号字符 hold 在内部，等下一段或 finalize 决断。
    pub fn push(&mut self, delta: &str) -> String {
        if delta.is_empty() {
            return String::new();
        }
        // 先把上次 hold 的字符拼回前面——它前面跟了新内容，说明它不是
        // 结尾，无条件 emit。
        let mut combined = String::with_capacity(delta.len() + 4);
        if let Some(t) = self.held_tail.take() {
            combined.push(t);
        }
        combined.push_str(delta);

        // 再看 combined 末尾是否潜在句号，如果是，hold 起来。
        if let Some(last) = combined.chars().last() {
            if is_period_char(last) {
                self.held_tail = Some(last);
                let last_len = last.len_utf8();
                let emit_part = &combined[..combined.len() - last_len];
                return emit_part.to_string();
            }
        }
        combined
    }

    /// 流式结束。根据 mode / 累计 full / user_text 决定 hold 的尾巴
    /// 要不要 emit。返回 (still_to_emit, final_full_after_strip)。
    pub fn finalize(
        &mut self,
        full_so_far: &str,
        user_text: &str,
        mode: StripMode,
    ) -> (String, String) {
        let Some(tail) = self.held_tail.take() else {
            return (String::new(), full_so_far.to_string());
        };

        let combined = format!("{full_so_far}{tail}");

        match mode {
            StripMode::Off => (tail.to_string(), combined),
            StripMode::Always | StripMode::Auto => {
                // 用 strip_full_at_end 做完整判定（含闭合符 / 省略号 / 用户原话兜底）
                let stripped = strip_full_at_end(&combined, user_text, mode);
                if stripped.len() < combined.len() {
                    // 砍了：不 emit tail，full 取 stripped
                    (String::new(), stripped)
                } else {
                    // 没砍：tail 该 emit
                    (tail.to_string(), combined)
                }
            }
        }
    }
}

impl Default for StreamingStripper {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn strip(full: &str, user: &str, mode: StripMode) -> String {
        strip_full_at_end(full, user, mode)
    }

    #[test]
    fn off_mode_never_strips() {
        assert_eq!(strip("你好。", "你好", StripMode::Off), "你好。");
        assert_eq!(strip("hello.", "hello", StripMode::Off), "hello.");
    }

    #[test]
    fn auto_strips_chinese_period() {
        assert_eq!(strip("你好。", "你好", StripMode::Auto), "你好");
    }

    #[test]
    fn auto_strips_english_period() {
        assert_eq!(
            strip("hello world.", "hello world", StripMode::Auto),
            "hello world"
        );
    }

    #[test]
    fn auto_keeps_when_user_ended_with_period() {
        // 用户自己说了"句号" / 自己打了句号 → 保留
        assert_eq!(
            strip("我说完了。", "我说完了。", StripMode::Auto),
            "我说完了。"
        );
    }

    #[test]
    fn auto_keeps_ellipsis() {
        assert_eq!(strip("等等...", "等等", StripMode::Auto), "等等...");
        assert_eq!(strip("等等…", "等等", StripMode::Auto), "等等…");
    }

    #[test]
    fn auto_strips_inside_closing_quote() {
        // 末尾 `。"` → 砍句号留引号
        assert_eq!(
            strip("他说\"你好。\"", "他说你好", StripMode::Auto),
            "他说\"你好\""
        );
        // 中文引号
        assert_eq!(
            strip("他说「你好。」", "他说你好", StripMode::Auto),
            "他说「你好」"
        );
    }

    #[test]
    fn auto_does_not_touch_exclamation() {
        // 不在 is_period_char 范围内，函数自然不动
        assert_eq!(strip("你好！", "你好", StripMode::Auto), "你好！");
        assert_eq!(strip("你好？", "你好", StripMode::Auto), "你好？");
    }

    #[test]
    fn always_overrides_user_period() {
        assert_eq!(
            strip("我说完了。", "我说完了。", StripMode::Always),
            "我说完了"
        );
    }

    #[test]
    fn always_still_keeps_ellipsis() {
        assert_eq!(strip("等等...", "等等。", StripMode::Always), "等等...");
    }

    #[test]
    fn full_with_only_period_is_safe() {
        // 边界：只有一个句号
        assert_eq!(strip("。", "", StripMode::Auto), "");
        assert_eq!(strip(".", "", StripMode::Auto), "");
    }

    #[test]
    fn full_keeps_period_inside_sentence() {
        // 句中句号不能动
        assert_eq!(
            strip("我去了上海。然后又去了北京", "...", StripMode::Auto),
            "我去了上海。然后又去了北京"
        );
    }

    #[test]
    fn streaming_holds_tail_until_finalize() {
        let mut s = StreamingStripper::new();
        // 一次到位 "你好。"
        let emit = s.push("你好。");
        assert_eq!(emit, "你好");
        let (extra, full) = s.finalize("你好", "你好", StripMode::Auto);
        assert_eq!(extra, "");
        assert_eq!(full, "你好");
    }

    #[test]
    fn streaming_two_chunks_with_tail_period() {
        let mut s = StreamingStripper::new();
        let e1 = s.push("你好");
        assert_eq!(e1, "你好");
        let e2 = s.push("。");
        assert_eq!(e2, ""); // hold 住
        let (extra, full) = s.finalize("你好", "你好", StripMode::Auto);
        assert_eq!(extra, "");
        assert_eq!(full, "你好");
    }

    #[test]
    fn streaming_releases_tail_when_more_content_follows() {
        let mut s = StreamingStripper::new();
        let e1 = s.push("我去");
        assert_eq!(e1, "我去");
        let e2 = s.push("。");
        assert_eq!(e2, ""); // hold
        let e3 = s.push("然后");
        assert_eq!(e3, "。然后"); // 释放 hold + 新内容
        let (extra, full) = s.finalize("我去。然后", "我去然后", StripMode::Auto);
        assert_eq!(extra, "");
        assert_eq!(full, "我去。然后");
    }

    #[test]
    fn streaming_off_mode_keeps_tail() {
        let mut s = StreamingStripper::new();
        s.push("你好");
        s.push("。");
        let (extra, full) = s.finalize("你好", "你好", StripMode::Off);
        assert_eq!(extra, "。");
        assert_eq!(full, "你好。");
    }

    #[test]
    fn streaming_user_said_period_keeps_tail() {
        let mut s = StreamingStripper::new();
        s.push("我说完了");
        s.push("。");
        let (extra, full) = s.finalize("我说完了", "我说完了。", StripMode::Auto);
        assert_eq!(extra, "。");
        assert_eq!(full, "我说完了。");
    }
}
