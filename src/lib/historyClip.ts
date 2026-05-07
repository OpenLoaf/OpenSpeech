// 单条 history entry 长度上限 = 500 tokens：CJK 字符 = 1 token，连续 latin / 数字 = 1 token。
// 超过即从尾部截断 + 追加 i18n 化的 [省略 N 字] 标注。

import i18n from "@/i18n";

export const HISTORY_ENTRY_MAX_TOKENS = 500;

function isCjk(codePoint: number): boolean {
  return (
    (codePoint >= 0x4e00 && codePoint <= 0x9fff) ||
    (codePoint >= 0x3400 && codePoint <= 0x4dbf) ||
    (codePoint >= 0x20000 && codePoint <= 0x2a6df) ||
    (codePoint >= 0x3040 && codePoint <= 0x309f) ||
    (codePoint >= 0x30a0 && codePoint <= 0x30ff) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7af)
  );
}

function isWordChar(ch: string): boolean {
  return !/\s/.test(ch);
}

export function countTokens(text: string): number {
  let n = 0;
  let inWord = false;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (isCjk(cp)) {
      n += 1;
      inWord = false;
    } else if (!isWordChar(ch)) {
      inWord = false;
    } else if (!inWord) {
      n += 1;
      inWord = true;
    }
  }
  return n;
}

export function clipHistoryEntry(
  text: string,
  maxTokens: number = HISTORY_ENTRY_MAX_TOKENS,
): string {
  let n = 0;
  let cutAt = -1;
  let inWord = false;
  let i = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    const next = i + ch.length;
    if (isCjk(cp)) {
      if (n + 1 > maxTokens) {
        cutAt = i;
        break;
      }
      n += 1;
      inWord = false;
    } else if (!isWordChar(ch)) {
      inWord = false;
    } else if (!inWord) {
      if (n + 1 > maxTokens) {
        cutAt = i;
        break;
      }
      n += 1;
      inWord = true;
    }
    i = next;
  }
  if (cutAt < 0) return text;
  const head = text.slice(0, cutAt).replace(/\s+$/, "");
  const omitted = countTokens(text.slice(cutAt));
  if (omitted <= 0) return text;
  const label = i18n.t("ai.history_truncated", {
    ns: "settings",
    count: omitted,
    defaultValue: `+${omitted} more`,
  });
  return `${head}…[${label}]`;
}
