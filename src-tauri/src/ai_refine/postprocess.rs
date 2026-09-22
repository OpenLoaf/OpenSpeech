// AI refine 输出后置处理：
// 1. 拦截模型在输出开头误回显的本次请求 <system-tag> 上下文块；
// 2. 拦截与正文几乎无字符重叠的整段离题输出（幻觉 / 抄 history / 答题），兜底回退原文；
// 3. 按 strip_trailing_period 模式砍尾句号。
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

use std::collections::HashSet;

const SYSTEM_TAG_OPEN_PREFIX: &str = "<system-tag";
const SYSTEM_TAG_CLOSE: &str = "</system-tag>";

/// 流式前缀过滤器。只删除“输出开头 + 与本次请求中某个完整块匹配”的
/// `<system-tag>...</system-tag>`，避免模型把 TargetApp / HotWords 等参考
/// 上下文当成正文回显并流式注入。
///
/// 不做全局 XML 删除：用户可能真的在口述一段 `<system-tag>` 文本；只有内容
/// 与本次请求上下文一致时才视为泄漏。
pub struct StreamingContextLeakFilter {
    known_blocks: Vec<String>,
    pending: String,
    prefix_decided: bool,
    stripped_blocks: usize,
}

impl StreamingContextLeakFilter {
    pub fn new<'a>(context_sources: impl IntoIterator<Item = &'a str>, user_text: &str) -> Self {
        let user_blocks = extract_system_tag_blocks(user_text)
            .into_iter()
            .map(|block| normalize_system_tag(&block))
            .collect::<Vec<_>>();
        let known_blocks = context_sources
            .into_iter()
            .flat_map(extract_system_tag_blocks)
            .map(|block| normalize_system_tag(&block))
            .filter(|block| !user_blocks.contains(block))
            .collect();
        Self {
            known_blocks,
            pending: String::new(),
            prefix_decided: false,
            stripped_blocks: 0,
        }
    }

    /// 收到一段 delta，返回可以继续交给尾句号 stripper 的文本。
    /// 在判定首个可见内容是否为泄漏块前，内容会暂存而不 emit。
    pub fn push(&mut self, delta: &str) -> String {
        if delta.is_empty() {
            return String::new();
        }
        if self.prefix_decided || self.known_blocks.is_empty() {
            return delta.to_string();
        }

        self.pending.push_str(delta);
        self.resolve_pending(false)
    }

    /// 流结束时释放未能构成完整匹配块的前缀，不会吞掉普通文本。
    pub fn finalize(&mut self) -> String {
        if self.prefix_decided || self.pending.is_empty() {
            return String::new();
        }
        self.resolve_pending(true)
    }

    pub fn stripped_blocks(&self) -> usize {
        self.stripped_blocks
    }

    fn resolve_pending(&mut self, stream_ended: bool) -> String {
        loop {
            // 已剔除的标签与正文之间的换行可能被 SSE 分到下一个 chunk；
            // 跨 chunk 继续吞掉这段分隔，避免正文前凭空多出空行。
            if self.stripped_blocks > 0 {
                self.pending = self.pending.trim_start_matches(['\r', '\n']).to_string();
            }
            let trimmed = self.pending.trim_start_matches(char::is_whitespace);
            if trimmed.is_empty() {
                if stream_ended {
                    self.prefix_decided = true;
                    return std::mem::take(&mut self.pending);
                }
                return String::new();
            }

            // `<sys` 这类分片仍可能继续成 `<system-tag`，先等下一块。
            if SYSTEM_TAG_OPEN_PREFIX.starts_with(trimmed) {
                if stream_ended {
                    self.prefix_decided = true;
                    return std::mem::take(&mut self.pending);
                }
                return String::new();
            }

            if !trimmed.starts_with(SYSTEM_TAG_OPEN_PREFIX) {
                self.prefix_decided = true;
                return std::mem::take(&mut self.pending);
            }

            let Some(close_start) = trimmed.find(SYSTEM_TAG_CLOSE) else {
                if stream_ended {
                    self.prefix_decided = true;
                    return std::mem::take(&mut self.pending);
                }
                return String::new();
            };
            let block_end = close_start + SYSTEM_TAG_CLOSE.len();
            let candidate = &trimmed[..block_end];
            let normalized = normalize_system_tag(candidate);
            if !self.known_blocks.iter().any(|known| known == &normalized) {
                self.prefix_decided = true;
                return std::mem::take(&mut self.pending);
            }

            self.stripped_blocks += 1;
            let leading_whitespace_len = self.pending.len() - trimmed.len();
            let consumed = leading_whitespace_len + block_end;
            let remainder = self.pending[consumed..]
                .trim_start_matches(['\r', '\n'])
                .to_string();
            self.pending = remainder;

            if self.pending.is_empty() && !stream_ended {
                return String::new();
            }
            // 继续检查：模型可能连续回显多个已知上下文块。
        }
    }
}

fn extract_system_tag_blocks(source: &str) -> Vec<String> {
    let mut blocks = Vec::new();
    let mut search_from = 0;
    while let Some(relative_open) = source[search_from..].find(SYSTEM_TAG_OPEN_PREFIX) {
        let open_start = search_from + relative_open;
        let line_start = source[..open_start]
            .rfind('\n')
            .map_or(0, |newline| newline + 1);
        if !source[line_start..open_start].trim().is_empty() {
            // 如规则正文里的“可能含 `<system-tag type=\"...\">` 块”只是
            // 行内说明，不能与后面真实块的闭合标签跨段配对。
            search_from = open_start + SYSTEM_TAG_OPEN_PREFIX.len();
            continue;
        }

        let from_open = &source[open_start..];
        let Some(close_start) = from_open.find(SYSTEM_TAG_CLOSE) else {
            break;
        };
        let block_end = close_start + SYSTEM_TAG_CLOSE.len();
        blocks.push(from_open[..block_end].to_string());
        search_from = open_start + block_end;
    }
    blocks
}

fn normalize_system_tag(block: &str) -> String {
    block.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// 输出前缀先 hold 多少个「内容字符」（字母 / 数字 / 汉字，不含标点空白）再做离题预判。
/// 8 个字 ≈ 2-3 个 SSE chunk，用户感知不到；短于 8 个字的输出天然 hold 到流结束。
const DRIFT_PREFIX_HOLD_CONTENT_CHARS: usize = 8;
/// 输出内容字符里「正文从未出现过」的占比超过此值 → 在写正文没有的东西。
/// 输出中**整词命中** HotWords term / alias 的片段先剔除再算（按词典还原品牌名不算 novel）；
/// 只按词条豁免、不按字母豁免——词典一长，26 个字母很快被凑齐，任何拉丁文幻觉都测不出来。
const DRIFT_NOVEL_RATIO: f32 = 0.5;
/// 正文内容字符里「在输出中完全消失」的占比超过此值 → 丢了正文大半。
const DRIFT_DROPPED_RATIO: f32 = 0.5;
/// 输出内容字符少于此数不终判——两三个字没有统计意义（「十五」→「15」这类归一会被误伤）。
const DRIFT_MIN_OUTPUT_CONTENT_CHARS: usize = 4;
/// 输出内容字符数 / 正文内容字符数超过此倍数 → 膨胀。整理只会删水分、极少加字；
/// 模型「回答正文里的问题」时输出通常是正文的两三倍长，且复用正文里的疑问词，
/// dropped 反而不高，只能靠膨胀识别。
const DRIFT_EXPANSION_RATIO: f32 = 2.0;
/// 零重叠（novel = dropped = 100%）时终判门槛降到此值：「制作组制作手机 UI」被写成
/// 「特写」只有两个字，但一个字都对不上，没有任何正常整理长这样。
const DRIFT_MIN_OUTPUT_CONTENT_CHARS_ZERO_OVERLAP: usize = 2;
/// 截断判据：输出是正文内容字符的**严格前缀**、长度不到正文的此比例、且正文字符集丢了
/// 超过 DRIFT_TRUNCATION_DROPPED_RATIO。撤回覆盖留的是**尾巴**不是头，不会命中前缀判据；
/// 「好的好的好的」→「好的」这类结巴去重字符集没丢，也不会命中。
const DRIFT_TRUNCATION_MAX_EXPANSION: f32 = 0.35;
const DRIFT_TRUNCATION_DROPPED_RATIO: f32 = 0.6;
/// 输出与某条 ConversationHistory 文本相同（或互为子串）、且与正文的重叠低于此值 → 抄 history。
/// 用户重复口述同一句时 novel ≈ 0，不会误判。
const DRIFT_HISTORY_ECHO_MIN_NOVEL: f32 = 0.5;
/// 抄 history 的子串判据只在较短一侧至少这么多内容字时生效：完全相同不限长度（「特写」两个字
/// 也要拦），但「好的」这类短语几乎必然是某条长 history 的子串，不能凭子串关系就判抄。
const DRIFT_HISTORY_ECHO_MIN_SUBSTRING_CHARS: usize = 4;

/// 流式「离题守卫」：拦截与正文几乎无关的整段幻觉。
///
/// 真实事故（2026-09-22 用户反馈）：正文「上午行程结束后，下午的行程是点点点点点。」被
/// 模型改写成「上午九点十五分」——它把 MessageContext 里的 requestTime 当成用户说的时间
/// 填了进去；坏输出随后进 ConversationHistory，下一条又被原样抄出，级联污染。
/// prompt 规则是软约束，这里做硬兜底：输出既添了正文没有的字、又丢了正文大半字 =
/// 不是整理，是另写——丢弃它，让调用方以正文原文兜底。
///
/// 只看字符集合不看语义。主判据：novel 高，再叠加 dropped 高 **或** 膨胀：
/// - novel_ratio：输出的内容字符里，多少在正文里从未出现（整词命中 HotWords 的片段先剔除）
/// - dropped_ratio：正文的内容字符里，多少在输出里完全消失（另写 / 抄 history）
/// - expansion：输出比正文长了多少倍（答题 / 展开解释）
///
/// 三条补充判据覆盖主判据的盲区（同一用户当天的后续反馈）：
/// - 抄 history：输出 == 某条 ConversationHistory 文本（或互为子串）且与正文几乎无重叠
///   （「制作组制作手机 UI」→「特写」；「我主要担心的是…会不会被封」→ 抄走上一条只少了「帮我」）
/// - 零重叠短输出：novel = dropped = 100% 时门槛从 4 字降到 2 字
/// - 截断：输出是正文的严格前缀且只剩不到 35%（「制作组制作手机 UI」→「制作」）
///
/// 单看 novel 会误伤「克劳德 → Claude」这类音译还原；单看 dropped 会误伤撤回覆盖
/// （「帮我写邮件…啊不对算了，发消息给项目群」→ 只留后半句）。数字形态归一到同一类，
/// 「一点二 → 1.2」不算新增。
///
/// 第三轮反馈（2026-09-22 15:47）暴露的盲区：HotWords 曾按**字母**整体豁免，用户词典里有十来个
/// 英文词条时 26 个字母几乎被凑齐，「我主要担心的是…会不会被封」被抄成 history 里的
/// 「用 Cloudflare 的 API 创建一个 DNS 记录，域名是 example.com…」novel 只有 0.31 而漏网。
/// 现在只豁免输出里**整词命中**的词条，其余字母一律按正文判。
///
/// 流式策略：前 DRIFT_PREFIX_HOLD_CONTENT_CHARS 个内容字符先 hold；凑够后用 novel_ratio
/// 预判——不离题就放行并转透传，离题就继续 hold 到流结束终判。终判离题且从未放行过
/// 任何字符 → Fallback（调用方回退正文）；已放行过 → 来不及撤回，照常放行只记日志。
pub struct StreamingDriftGuard {
    /// 正文的内容字符集合——dropped_ratio 的分母。
    source_chars: HashSet<char>,
    /// 正文内容字符数（含重复）——expansion 的分母。
    source_content_len: usize,
    /// HotWords term / aliases 的内容字符串（归一后，≥ 2 字）——算 novel 前先从输出里整词剔除。
    hotword_terms: Vec<String>,
    /// 正文的内容字符序列——截断判据要比对前缀。
    source_content: Vec<char>,
    /// ConversationHistory 各条正文的内容字符串（去掉 `[N 分钟前 …]` 头、只留内容字符），
    /// 抄 history 判据用——相等或互为子串都算。
    history_keys: Vec<String>,
    pending: String,
    /// 前缀预判已通过，后续 delta 直接透传。
    released: bool,
    /// 已放行过的输出——终判时拼回全量，也用来判断还能不能兜底。
    emitted: String,
    /// false = 纯透传、不终判。翻译 / 润色 / 会议摘要等「输出本就该与输入不同」的
    /// 路径必须关掉，否则译文会被当离题兜底回原文。
    enabled: bool,
}

pub enum DriftFinalize {
    /// 未离题：放行 pending（可能为空）。
    Release(String),
    /// 离题且尚未 emit 过任何字符：调用方丢弃模型输出，以正文兜底。
    Fallback(DriftStats),
    /// 离题但前缀已放行、来不及兜底：照常放行 pending，仅供记录。
    ReleaseDrifted { pending: String, stats: DriftStats },
}

/// 终判时的三个指标，供日志。
#[derive(Debug, Clone, Copy)]
pub struct DriftStats {
    pub novel_ratio: f32,
    pub dropped_ratio: f32,
    pub expansion: f32,
}

impl StreamingDriftGuard {
    /// `context_sources` 传本次请求的 system / context message 内容，从中抽 HotWords 块的
    /// term 与 aliases——模型按词典把「Cloud Code」还原成「Claude Code」时，命中的整词
    /// 不算 novel；同时抽 ConversationHistory 各条正文供抄 history 判据比对。
    pub fn new<'a>(user_text: &str, context_sources: impl IntoIterator<Item = &'a str>) -> Self {
        let source_content: Vec<char> = user_text.chars().filter_map(content_char_class).collect();
        let source_chars: HashSet<char> = source_content.iter().copied().collect();
        let mut hotword_terms: Vec<String> = Vec::new();
        let mut history_keys: Vec<String> = Vec::new();
        for source in context_sources {
            for term in extract_hotword_terms(source) {
                let key = content_key(&term);
                // 单字词条会把输出里所有同字母都豁免掉，没有区分度，跳过。
                if key.chars().count() >= 2 && !hotword_terms.contains(&key) {
                    hotword_terms.push(key);
                }
            }
            for entry in extract_history_entries(source) {
                let key = content_key(&entry);
                if !key.is_empty() && !history_keys.contains(&key) {
                    history_keys.push(key);
                }
            }
        }
        // 长词条优先剔除，避免短词条先把长词条截成碎片（「tab」先于「table」）。
        hotword_terms.sort_by_key(|term| std::cmp::Reverse(term.chars().count()));
        Self {
            source_chars,
            source_content_len: source_content.len(),
            hotword_terms,
            source_content,
            history_keys,
            pending: String::new(),
            released: false,
            emitted: String::new(),
            enabled: true,
        }
    }

    /// 关闭态：push 原样透传，finalize 恒 Release("")。
    pub fn disabled() -> Self {
        Self {
            source_chars: HashSet::new(),
            source_content_len: 0,
            hotword_terms: Vec::new(),
            source_content: Vec::new(),
            history_keys: Vec::new(),
            pending: String::new(),
            released: true,
            emitted: String::new(),
            enabled: false,
        }
    }

    /// 收到一段 delta，返回可以继续下发的文本。前缀预判通过前内容暂存不 emit。
    pub fn push(&mut self, delta: &str) -> String {
        if delta.is_empty() {
            return String::new();
        }
        if !self.enabled {
            return delta.to_string();
        }
        // 正文没有内容字符（空 / 纯标点）无从比较，直接透传。
        if self.released || self.source_chars.is_empty() {
            self.emitted.push_str(delta);
            return delta.to_string();
        }
        self.pending.push_str(delta);
        let content_count = self.pending.chars().filter_map(content_char_class).count();
        if content_count < DRIFT_PREFIX_HOLD_CONTENT_CHARS {
            return String::new();
        }
        let (novel_ratio, _) = self.ratios(&self.pending);
        if novel_ratio >= DRIFT_NOVEL_RATIO {
            // 前缀已经在写正文没有的东西，继续 hold 到流结束再终判。
            // 每次 push 都重算：模型若先写了一段导语再接正文，比例回落后仍能放行。
            return String::new();
        }
        self.released = true;
        let out = std::mem::take(&mut self.pending);
        self.emitted.push_str(&out);
        out
    }

    /// 流结束终判。
    pub fn finalize(&mut self) -> DriftFinalize {
        if !self.enabled {
            return DriftFinalize::Release(String::new());
        }
        let pending = std::mem::take(&mut self.pending);
        let full = format!("{}{}", self.emitted, pending);
        let output_content: Vec<char> = full.chars().filter_map(content_char_class).collect();
        let (novel_ratio, dropped_ratio) = self.ratios(&full);
        let expansion = output_content.len() as f32 / self.source_content_len.max(1) as f32;
        let stats = DriftStats {
            novel_ratio,
            dropped_ratio,
            expansion,
        };
        let rewritten = output_content.len() >= DRIFT_MIN_OUTPUT_CONTENT_CHARS
            && novel_ratio > DRIFT_NOVEL_RATIO
            && (dropped_ratio > DRIFT_DROPPED_RATIO || expansion > DRIFT_EXPANSION_RATIO);
        let zero_overlap = output_content.len() >= DRIFT_MIN_OUTPUT_CONTENT_CHARS_ZERO_OVERLAP
            && novel_ratio >= 1.0
            && dropped_ratio >= 1.0;
        let history_echo = !output_content.is_empty()
            && novel_ratio >= DRIFT_HISTORY_ECHO_MIN_NOVEL
            && self.echoes_history(&output_content.iter().collect::<String>());
        let truncated = !output_content.is_empty()
            && output_content.len() < self.source_content.len()
            && self.source_content.starts_with(&output_content)
            && expansion < DRIFT_TRUNCATION_MAX_EXPANSION
            && dropped_ratio > DRIFT_TRUNCATION_DROPPED_RATIO;
        let drifted = rewritten || zero_overlap || history_echo || truncated;
        if !drifted {
            self.emitted.push_str(&pending);
            return DriftFinalize::Release(pending);
        }
        if self.emitted.is_empty() {
            DriftFinalize::Fallback(stats)
        } else {
            self.emitted.push_str(&pending);
            DriftFinalize::ReleaseDrifted { pending, stats }
        }
    }

    fn ratios(&self, output: &str) -> (f32, f32) {
        let out_chars: Vec<char> = output.chars().filter_map(content_char_class).collect();
        if out_chars.is_empty() || self.source_chars.is_empty() {
            return (0.0, 0.0);
        }
        // 先把整词命中 HotWords 的片段剔掉，剩下的字符才拿去和正文比。
        let mut residual: String = out_chars.iter().collect();
        for term in &self.hotword_terms {
            if residual.contains(term.as_str()) {
                residual = residual.replace(term.as_str(), "");
            }
        }
        let novel = residual
            .chars()
            .filter(|c| !self.source_chars.contains(c))
            .count();
        let out_set: HashSet<char> = out_chars.iter().copied().collect();
        let dropped = self
            .source_chars
            .iter()
            .filter(|c| !out_set.contains(c))
            .count();
        (
            novel as f32 / out_chars.len() as f32,
            dropped as f32 / self.source_chars.len() as f32,
        )
    }

    /// 输出（内容字符串）是否抄自某条 history：完全相同不限长度；互为子串时较短一侧
    /// 至少 DRIFT_HISTORY_ECHO_MIN_SUBSTRING_CHARS 个字——模型抄 history 常会掐头去尾
    /// （少个「帮我」、多个语气词），只认完全相等会漏。
    fn echoes_history(&self, output_key: &str) -> bool {
        let out_len = output_key.chars().count();
        self.history_keys.iter().any(|entry| {
            if entry == output_key {
                return true;
            }
            let shorter = out_len.min(entry.chars().count());
            shorter >= DRIFT_HISTORY_ECHO_MIN_SUBSTRING_CHARS
                && (entry.contains(output_key) || output_key.contains(entry))
        })
    }
}

/// 文本的「内容字符串」：只留 content_char_class 归一后的字符，标点 / 空白全丢。
/// HotWords 整词匹配与抄 history 比对都用这个键，这样「子Agent」/「子 Agent」、
/// 「M2」/「M 二」都能对上。
fn content_key(text: &str) -> String {
    text.chars().filter_map(content_char_class).collect()
}

/// 把字符归一到「内容字符」类别：
/// - 标点 / 空白 / 符号 / emoji → None（不参与统计）
/// - 阿拉伯数字与中文数字 → '#'（「一点二」→「1.2」这类数字形态归一不算新增内容）
/// - 其它字母 / 汉字 → 小写（「git 哈伯」→「GitHub」大小写不算新增）
fn content_char_class(c: char) -> Option<char> {
    if c.is_ascii_digit()
        || matches!(
            c,
            '〇' | '零'
                | '一'
                | '二'
                | '三'
                | '四'
                | '五'
                | '六'
                | '七'
                | '八'
                | '九'
                | '十'
                | '百'
                | '千'
                | '万'
                | '亿'
                | '两'
        )
    {
        return Some('#');
    }
    if !c.is_alphanumeric() {
        return None;
    }
    c.to_lowercase().next()
}

/// 从 system / context message 里抽 ConversationHistory 各条正文。前端每条形如
/// `[N 分钟前 · focusTitle=xxx] 正文`（多行条目之间空行分隔），去掉方括号头只留正文。
fn extract_history_entries(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    for block in extract_system_tag_blocks(source) {
        if !block.starts_with("<system-tag type=\"ConversationHistory\"") {
            continue;
        }
        let Some(open_end) = block.find('>') else {
            continue;
        };
        let inner = &block[open_end + 1..block.len() - SYSTEM_TAG_CLOSE.len()];
        for line in inner.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let body = if line.starts_with('[') {
                match line.find(']') {
                    Some(close) => &line[close + 1..],
                    None => line,
                }
            } else {
                line
            };
            let normalized = normalize_for_history_match(body);
            if !normalized.is_empty() {
                out.push(normalized);
            }
        }
    }
    out
}

/// 抄 history 判据的比对键：去掉首尾空白与尾部句读（模型可能多带一个句号）、归一内部空白。
fn normalize_for_history_match(text: &str) -> String {
    text.trim()
        .trim_end_matches(['。', '.', '！', '!', '？', '?', '…', '，', ','])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

/// 从 system / context message 里抽 HotWords 块的 term 与每个 alias，一词一项。
/// 前端两种格式都覆盖：单行「A、B、C」，或多行 `term | aliases: a, b | note: ...`；
/// note 是给模型看的解释，不当词条，否则会把一大段说明文字当成「已知内容」。
fn extract_hotword_terms(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    for block in extract_system_tag_blocks(source) {
        if !block.starts_with("<system-tag type=\"HotWords\"") {
            continue;
        }
        let Some(open_end) = block.find('>') else {
            continue;
        };
        let inner = &block[open_end + 1..block.len() - SYSTEM_TAG_CLOSE.len()];
        for line in inner.lines() {
            for segment in line.split(" | ") {
                let segment = segment.trim();
                if segment.starts_with("note:") {
                    continue;
                }
                let list = segment.strip_prefix("aliases:").unwrap_or(segment);
                out.extend(
                    list.split([',', '、'])
                        .map(str::trim)
                        .filter(|term| !term.is_empty())
                        .map(str::to_string),
                );
            }
        }
    }
    out
}

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

    const TARGET_APP_TAG: &str = "<system-tag type=\"TargetApp\">\n\tname: Orca\n</system-tag>";

    #[test]
    fn context_leak_filter_strips_feedback_target_app_regression_across_chunks() {
        let mut filter = StreamingContextLeakFilter::new([TARGET_APP_TAG], "");

        assert_eq!(filter.push("<system-tag type=\"Tar"), "");
        assert_eq!(
            filter.push("getApp\">\n\tname: Orca\n</system-tag>\n\n"),
            ""
        );
        assert_eq!(
            filter.push("像我现在这种情况，除了 Terraform 以外，还有哪些方案支持起来会更好一些？"),
            "像我现在这种情况，除了 Terraform 以外，还有哪些方案支持起来会更好一些？"
        );
        assert_eq!(filter.finalize(), "");
        assert_eq!(filter.stripped_blocks(), 1);
    }

    #[test]
    fn context_leak_filter_strips_separator_split_after_closing_tag() {
        let mut filter = StreamingContextLeakFilter::new([TARGET_APP_TAG], "");

        assert_eq!(filter.push(TARGET_APP_TAG), "");
        assert_eq!(filter.push("\n\n"), "");
        assert_eq!(filter.push("正文"), "正文");
        assert_eq!(filter.stripped_blocks(), 1);
    }

    #[test]
    fn context_leak_filter_strips_multiple_known_leading_blocks() {
        let domains = "<system-tag type=\"Domains\">\n\t软件开发\n</system-tag>";
        let mut filter = StreamingContextLeakFilter::new([domains, TARGET_APP_TAG], "");
        let response = format!("{domains}\n\n{TARGET_APP_TAG}\n\n正文");

        assert_eq!(filter.push(&response), "正文");
        assert_eq!(filter.stripped_blocks(), 2);
    }

    #[test]
    fn context_leak_filter_matches_harmless_whitespace_differences() {
        let mut filter = StreamingContextLeakFilter::new([TARGET_APP_TAG], "");
        let echoed = "  <system-tag   type=\"TargetApp\">\n name:   Orca\n</system-tag>\n\n正文";

        assert_eq!(filter.push(echoed), "正文");
        assert_eq!(filter.stripped_blocks(), 1);
    }

    #[test]
    fn context_leak_filter_preserves_unknown_or_user_authored_tag() {
        let mut filter = StreamingContextLeakFilter::new([TARGET_APP_TAG], "");
        let authored = "<system-tag type=\"TargetApp\">\n\tname: VS Code\n</system-tag>\n\n请保留";

        assert_eq!(filter.push(authored), authored);
        assert_eq!(filter.finalize(), "");
        assert_eq!(filter.stripped_blocks(), 0);
    }

    #[test]
    fn context_leak_filter_only_strips_at_response_prefix() {
        let mut filter = StreamingContextLeakFilter::new([TARGET_APP_TAG], "");

        assert_eq!(filter.push("正文\n"), "正文\n");
        assert_eq!(filter.push(TARGET_APP_TAG), TARGET_APP_TAG);
        assert_eq!(filter.stripped_blocks(), 0);
    }

    #[test]
    fn context_leak_filter_releases_incomplete_prefix_at_finalize() {
        let mut filter = StreamingContextLeakFilter::new([TARGET_APP_TAG], "");

        assert_eq!(filter.push("<sys"), "");
        assert_eq!(filter.finalize(), "<sys");
        assert_eq!(filter.stripped_blocks(), 0);
    }

    #[test]
    fn context_leak_filter_preserves_tag_also_present_in_user_text() {
        let mut filter = StreamingContextLeakFilter::new([TARGET_APP_TAG], TARGET_APP_TAG);

        assert_eq!(filter.push(TARGET_APP_TAG), TARGET_APP_TAG);
        assert_eq!(filter.stripped_blocks(), 0);
    }

    #[test]
    fn context_tag_extraction_ignores_inline_documentation_marker() {
        let source =
            format!("规则里会提到 `<system-tag type=\"...\">` 这种参考块。\n\n{TARGET_APP_TAG}");
        let blocks = extract_system_tag_blocks(&source);

        assert_eq!(blocks, vec![TARGET_APP_TAG]);
    }

    /// 逐 chunk 喂完流并终判；返回 (放行的全文, 终判)。
    fn run_drift(user_text: &str, sources: &[&str], chunks: &[&str]) -> (String, DriftFinalize) {
        let mut guard = StreamingDriftGuard::new(user_text, sources.iter().copied());
        let mut released = String::new();
        for chunk in chunks {
            released.push_str(&guard.push(chunk));
        }
        let verdict = guard.finalize();
        if let DriftFinalize::Release(rest) | DriftFinalize::ReleaseDrifted { pending: rest, .. } =
            &verdict
        {
            released.push_str(rest);
        }
        (released, verdict)
    }

    const FEEDBACK_HOTWORDS: &str = "<system-tag type=\"HotWords\">\n\tCodex | aliases: Codecs | note: OpenAI 代码模型 Codex，ASR 常将 'Codex' 误识别为同音词 'Codecs'\n\tClaude Code | aliases: Cloud Code\n\t新片厂 | aliases: 芯片厂\n</system-tag>";

    // 2026-09-22 10:00 第二轮反馈时的 history 块（WPS Office 目标）。
    const FEEDBACK_HISTORY: &str = "<system-tag type=\"ConversationHistory\" targetApp=\"WPS Office\">\n\t[49 分钟前] 特写\n\n\t[48 分钟前] 释义者神秘任务开启\n\n\t[47 分钟前 · focusTitle=剧本.docx] B 同时入画上车\n\n\t[44 分钟前] 上午九点十五分\n</system-tag>";

    // 2026-09-22 15:47 第三轮反馈时的真实词典：十来个英文词条，字母几乎凑齐整套。
    const FEEDBACK_HOTWORDS_LONG: &str = "<system-tag type=\"HotWords\">\n\tharness\n\tviewer\n\trunner\n\t子Agent | aliases: zv\n\tskill | aliases: scale\n\tFN | aliases: F 和 N\n\tsidebar | aliases: 塞坝\n\tharnessctl-cli | aliases: hexems-cli\n\thexems | aliases: 海科森云\n\ttab | aliases: type, table\n\tAnthropic | aliases: authpic\n\tOpenSpeech\n\tOpenLoaf\n</system-tag>";

    // 第三轮反馈的 history 块（Orca 目标）：最后一条是上一次 refine 编出来的坏输出。
    const FEEDBACK_HISTORY_CLOUDFLARE: &str = "<system-tag type=\"ConversationHistory\" targetApp=\"Orca\">\n\t[107 分钟前] 我发现一个问题：打开一个新的 bash 终端，输入一些命令后关闭，再开一个新终端，结果这个终端没有显示之前的历史记录\n\n\t[25 分钟前] 帮我用 Cloudflare 的 API 创建一个 DNS 记录，域名是 example.com，类型 A，值 1.2.3.4\n</system-tag>";

    // 第二轮反馈 ①：「制作组制作手机 UI」被写成 history 里的「特写」。只有两个字，
    // 走不到主判据的 4 字门槛，靠「抄 history」与「零重叠」两条都能拦。
    #[test]
    fn drift_guard_falls_back_when_short_output_echoes_history_entry() {
        let (released, verdict) = run_drift(
            "制作组制作手机 UI。",
            &[FEEDBACK_HOTWORDS, FEEDBACK_HISTORY],
            &["特", "写"],
        );
        assert_eq!(released, "");
        assert!(matches!(verdict, DriftFinalize::Fallback(_)));
    }

    // 抄 history 判据不依赖 history 块也能兜住：两个字、零重叠。
    #[test]
    fn drift_guard_falls_back_on_two_char_zero_overlap_output() {
        let (released, verdict) = run_drift("制作组制作手机 UI。", &[], &["特写"]);
        assert_eq!(released, "");
        assert!(matches!(verdict, DriftFinalize::Fallback(_)));
    }

    // 用户重复口述 history 里已有的短句：输出 == history 条目，但与正文完全重叠 → 放行。
    #[test]
    fn drift_guard_passes_repeated_dictation_matching_history() {
        let (released, verdict) = run_drift("特写。", &[FEEDBACK_HISTORY], &["特写"]);
        assert_eq!(released, "特写");
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 第二轮反馈 ②：「制作组制作手机 UI」被截成「制作」——novel 为 0，只能靠前缀 + 长度判。
    #[test]
    fn drift_guard_falls_back_when_output_is_tiny_prefix_of_input() {
        let (released, verdict) = run_drift("制作组制作手机 UI。", &[], &["制", "作"]);
        assert_eq!(released, "");
        assert!(matches!(verdict, DriftFinalize::Fallback(_)));
    }

    // 只删尾部残尾的正常整理也是正文前缀，但只丢了一个字 → 放行。
    #[test]
    fn drift_guard_passes_prefix_that_only_drops_dangling_tail() {
        let (released, verdict) = run_drift(
            "六六六，现在准确度还是挺高的，最近用着挺爽，能。",
            &[],
            &["666，现在准确度还是挺高的，最近用着挺爽"],
        );
        assert_eq!(released, "666，现在准确度还是挺高的，最近用着挺爽");
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 结巴去重：输出是前缀且很短，但正文字符集一个没丢 → 放行。
    #[test]
    fn drift_guard_passes_stutter_dedupe_prefix() {
        let (released, verdict) = run_drift("好的好的好的好的好的好的", &[], &["好的"]);
        assert_eq!(released, "好的");
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 两字同音纠错（部分重叠）不在零重叠判据内 → 放行。
    #[test]
    fn drift_guard_passes_two_char_partial_homophone_fix() {
        let (released, verdict) = run_drift("在见", &[], &["再见"]);
        assert_eq!(released, "再见");
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    #[test]
    fn history_extraction_strips_bracket_heads_and_meta() {
        let entries = extract_history_entries(FEEDBACK_HISTORY);
        assert!(entries.contains(&"特写".to_string()));
        assert!(entries.contains(&"B 同时入画上车".to_string()));
        assert!(entries.contains(&"上午九点十五分".to_string()));
        assert!(!entries.iter().any(|e| e.contains("分钟前")));
        assert!(!entries.iter().any(|e| e.contains("focusTitle")));
    }

    // 2026-09-22 事故原型：requestTime 09:15 被填成用户说的时间。7 个字不够前缀预判，
    // 全程 hold，终判离题 → 从未 emit → 可兜底。
    #[test]
    fn drift_guard_falls_back_when_request_time_leaks_into_output() {
        let (released, verdict) = run_drift(
            "上午行程结束后，下午的行程是点点点点点。",
            &[FEEDBACK_HOTWORDS],
            &["上午", "九点", "十五", "分"],
        );
        assert_eq!(released, "");
        assert!(matches!(verdict, DriftFinalize::Fallback(_)));
    }

    // 事故第二条：坏输出进了 history 被原样抄出，正文里连「上午」都没有。
    #[test]
    fn drift_guard_falls_back_when_output_copies_history_entry() {
        let (released, verdict) = run_drift(
            "行程结束后，下午的行程是。",
            &[FEEDBACK_HOTWORDS],
            &["上午九点", "十五分"],
        );
        assert_eq!(released, "");
        assert!(matches!(verdict, DriftFinalize::Fallback(_)));
    }

    // 模型把孤立短问句当成在问它、开始作答。
    #[test]
    fn drift_guard_falls_back_when_model_answers_the_question() {
        let (released, verdict) = run_drift(
            "这个是什么意思？",
            &[],
            &["这句话", "的意思是", "指代前文", "提到的权限", "检查逻辑"],
        );
        assert_eq!(released, "");
        assert!(matches!(verdict, DriftFinalize::Fallback(_)));
    }

    // 模型违反 r4 把中文翻成了英文：字母全部 novel。
    #[test]
    fn drift_guard_falls_back_when_output_switches_language() {
        let (released, verdict) = run_drift(
            "帮我把这个翻译成英文",
            &[],
            &["Please ", "translate ", "this into ", "English"],
        );
        assert_eq!(released, "");
        assert!(matches!(verdict, DriftFinalize::Fallback(_)));
    }

    // 正常整理：前 8 个内容字与正文一致 → 第三个 chunk 起放行，之后透传。
    #[test]
    fn drift_guard_releases_prefix_early_for_faithful_rewrite() {
        let mut guard =
            StreamingDriftGuard::new("那个搜索框现在支持的快捷见太少了啊，可以加一些快捷见。", []);
        assert_eq!(guard.push("搜索框"), "");
        assert_eq!(guard.push("现在支持"), "");
        assert_eq!(guard.push("的快捷键"), "搜索框现在支持的快捷键");
        assert_eq!(guard.push("太少了，"), "太少了，");
        assert!(matches!(guard.finalize(), DriftFinalize::Release(ref rest) if rest.is_empty()));
    }

    // 撤回覆盖只留后半句：丢了正文大半（dropped 高）但一个新字都没添 → 不算离题。
    #[test]
    fn drift_guard_passes_retraction_override() {
        let (released, verdict) = run_drift(
            "嗯，帮我写个邮件给客户，主题是续约，啊不对算了，刚刚那那句不算，当我没说啊。然后呢，发送一条消息给项目群，告诉大家明天的会议改到下午三点。",
            &[],
            &["发送一条消息给项目群，", "告诉大家明天的会议改到下午三点。"],
        );
        assert_eq!(
            released,
            "发送一条消息给项目群，告诉大家明天的会议改到下午三点。"
        );
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 数字形态归一（中文数字 → 阿拉伯数字 / 版本号）不算新增内容。
    #[test]
    fn drift_guard_passes_numeral_and_brand_normalization() {
        let (released, verdict) = run_drift(
            "你去 git 哈伯的 release 那拿一下，文件名是 v 一点儿二点儿三 杠 mac 点 zip。",
            &[],
            &[
                "你去 GitHub 的 release 那拿一下，",
                "文件名是 v1.2.3-mac.zip",
            ],
        );
        assert_eq!(
            released,
            "你去 GitHub 的 release 那拿一下，文件名是 v1.2.3-mac.zip"
        );
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 按词典把音译还原成品牌名：hotword 的字母算 known，不能被当 novel 误伤。
    #[test]
    fn drift_guard_counts_hotword_letters_as_known() {
        let (released, verdict) = run_drift(
            "克劳德代码怎么用",
            &[FEEDBACK_HOTWORDS],
            &["Claude Code", " 怎么用"],
        );
        assert_eq!(released, "Claude Code 怎么用");
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 第三轮反馈：正文「我主要担心的是…会不会被封」被抄成 history 里那条 Cloudflare 请求
    // （只少了「帮我」）。旧实现按字母豁免 HotWords，长词典把字母凑齐，novel 只有 0.31 漏网；
    // 改成整词豁免后 novel ≈ 0.9、dropped ≈ 0.76 → 主判据命中，从未 emit → 兜底。
    #[test]
    fn drift_guard_falls_back_when_latin_heavy_history_copy_slips_past_long_hotwords() {
        let (released, verdict) = run_drift(
            "我主要担心的是，用这个方法的话，会不会被封。",
            &[FEEDBACK_HOTWORDS_LONG, FEEDBACK_HISTORY_CLOUDFLARE],
            &[
                "用 Cloudflare",
                " 的 API 创建一个 DNS 记录，",
                "域名是 example.com，类型 A，值 1.2.3.4",
            ],
        );
        assert_eq!(released, "");
        match verdict {
            DriftFinalize::Fallback(stats) => {
                assert!(
                    stats.novel_ratio > DRIFT_NOVEL_RATIO,
                    "novel={}",
                    stats.novel_ratio
                );
                assert!(stats.dropped_ratio > DRIFT_DROPPED_RATIO);
            }
            _ => panic!("expected Fallback"),
        }
    }

    // 同一条输出即使主判据没到阈值，抄 history 的子串判据也要能兜住：
    // 输出比 history 条目少了「帮我」，完全相等判不到，子串关系判得到。
    #[test]
    fn drift_guard_history_echo_matches_substring_of_entry() {
        let guard = StreamingDriftGuard::new(
            "我主要担心的是，用这个方法的话，会不会被封。",
            [FEEDBACK_HISTORY_CLOUDFLARE],
        );
        assert!(guard.echoes_history(&content_key(
            "用 Cloudflare 的 API 创建一个 DNS 记录，域名是 example.com，类型 A，值 1.2.3.4"
        )));
        // 太短的子串不算：「一个」几乎必然出现在某条 history 里。
        assert!(!guard.echoes_history(&content_key("一个")));
        // 无关句不算。
        assert!(!guard.echoes_history(&content_key("我主要担心的是会不会被封")));
    }

    // 用户重复口述 history 里那句（少了「帮我」）：输出是 history 子串，但与正文完全重叠
    // （novel = 0）→ 放行，不能因为子串关系就当抄。
    #[test]
    fn drift_guard_passes_repeated_dictation_that_is_history_substring() {
        let text = "用 Cloudflare 的 API 创建一个 DNS 记录，域名是 example.com，类型 A，值 1.2.3.4";
        let (released, verdict) = run_drift(
            text,
            &[FEEDBACK_HOTWORDS_LONG, FEEDBACK_HISTORY_CLOUDFLARE],
            &[text],
        );
        assert_eq!(released, text);
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 长词典下按词典还原仍然豁免：「塞坝」→「sidebar」、「type」→「tab」都是整词命中，
    // 剔掉后剩余字符全在正文里 → novel = 0 → 放行。
    #[test]
    fn drift_guard_exempts_whole_hotword_matches_under_long_dictionary() {
        let (released, verdict) = run_drift(
            "帮我在塞坝里加一个 type，然后把 harness 的日志打出来。",
            &[FEEDBACK_HOTWORDS_LONG],
            &[
                "帮我在 sidebar 里加一个 tab，",
                "然后把 harness 的日志打出来",
            ],
        );
        assert_eq!(
            released,
            "帮我在 sidebar 里加一个 tab，然后把 harness 的日志打出来"
        );
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 字母不再按词典整体豁免：词典里没有 Cloudflare，它的字母就得按正文判——
    // 正文完全无关时整段都是 novel。
    #[test]
    fn drift_guard_no_longer_exempts_letters_outside_matched_hotwords() {
        let guard = StreamingDriftGuard::new("会不会被封", [FEEDBACK_HOTWORDS_LONG]);
        let (novel, _) = guard.ratios("Cloudflare DNS");
        assert!(novel > 0.9, "novel={novel}");
    }

    // 没有词典兜底的音译还原：novel 60% 但 dropped 43%、膨胀 1.4× → 不算离题。
    #[test]
    fn drift_guard_passes_modest_transliteration_without_hotword() {
        let (released, verdict) = run_drift("帮我打开克劳德", &[], &["帮我打开 ", "Claude"]);
        assert_eq!(released, "帮我打开 Claude");
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 输出太短（< 4 个内容字）不终判：「十五」→「15」这种不能兜底回原文。
    #[test]
    fn drift_guard_skips_verdict_for_tiny_output() {
        let (released, verdict) = run_drift("十五", &[], &["15"]);
        assert_eq!(released, "15");
        assert!(matches!(verdict, DriftFinalize::Release(_)));
    }

    // 前缀已放行后才发现整体离题：来不及撤回，照常放行剩余、只标记 drifted 供记日志。
    // 构造：前 8 个内容字里 7 个是正文有的（「点点点点上午」+「点」），预判放行；
    // 后面整段都是正文没有的字，且正文大半字从未出现 → 终判离题但 emitted 非空。
    #[test]
    fn drift_guard_reports_late_drift_without_fallback() {
        let mut guard = StreamingDriftGuard::new("上午行程结束后，下午的行程是点点点点点。", []);
        assert_eq!(guard.push("点点点点上午九点"), "点点点点上午九点");
        assert_eq!(guard.push("十五分开始拍摄"), "十五分开始拍摄");
        let verdict = guard.finalize();
        match verdict {
            DriftFinalize::ReleaseDrifted { pending, stats } => {
                assert_eq!(pending, "");
                assert!(stats.novel_ratio > DRIFT_NOVEL_RATIO);
                assert!(stats.dropped_ratio > DRIFT_DROPPED_RATIO);
            }
            _ => panic!("expected ReleaseDrifted"),
        }
    }

    // 正文没有内容字符（纯标点）时无从比较，直接透传。
    #[test]
    fn drift_guard_passes_through_when_source_has_no_content_chars() {
        let mut guard = StreamingDriftGuard::new("……", []);
        assert_eq!(guard.push("上午九点十五分"), "上午九点十五分");
        assert!(matches!(guard.finalize(), DriftFinalize::Release(ref rest) if rest.is_empty()));
    }

    // 关闭态（翻译 / 润色路径）：译文与原文零重叠也不能被兜底掉。
    #[test]
    fn drift_guard_disabled_is_transparent() {
        let mut guard = StreamingDriftGuard::disabled();
        assert_eq!(guard.push("Please translate"), "Please translate");
        assert_eq!(guard.push(" this"), " this");
        assert!(matches!(guard.finalize(), DriftFinalize::Release(ref rest) if rest.is_empty()));
    }

    #[test]
    fn hotword_extraction_keeps_terms_and_aliases_but_drops_notes() {
        let terms = extract_hotword_terms(FEEDBACK_HOTWORDS);
        assert!(terms.iter().any(|t| t == "Codex"));
        assert!(terms.iter().any(|t| t == "Codecs"));
        assert!(terms.iter().any(|t| t == "Claude Code"));
        assert!(terms.iter().any(|t| t == "Cloud Code"));
        assert!(terms.iter().any(|t| t == "芯片厂"));
        assert!(!terms.iter().any(|t| t.contains("误识别")));
        assert!(!terms.iter().any(|t| t.contains("aliases")));
    }

    // 多 alias 用逗号分隔，每个 alias 各成一条词条。
    #[test]
    fn hotword_extraction_splits_comma_separated_aliases() {
        let terms = extract_hotword_terms(FEEDBACK_HOTWORDS_LONG);
        assert!(terms.iter().any(|t| t == "tab"));
        assert!(terms.iter().any(|t| t == "type"));
        assert!(terms.iter().any(|t| t == "table"));
        assert!(terms.iter().any(|t| t == "F 和 N"));
        assert!(!terms.iter().any(|t| t == "type, table"));
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
