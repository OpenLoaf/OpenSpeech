// 用户词典 → 热词数组：取所有 enabled=true 的词条，按写入序去空。

import { useDictionaryStore } from "@/stores/dictionary";

export function getHotwordsArray(): string[] {
  return useDictionaryStore
    .getState()
    .entries.filter((e) => e.enabled)
    .map((e) => e.term.trim())
    .filter((s) => s.length > 0);
}
