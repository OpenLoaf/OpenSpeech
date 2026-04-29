// OL-TL-005 热词缓存（v0.3.6+）的进程内 KV：
// - 首次调用 refine 时把当前用户词典派生的热词字符串送给服务端，拿到 cacheId；
// - 后续只要词典内容没变就改发 cacheId，省一次 Redis SET + SHA-256；
// - 词典变更（增删、改 enabled）→ contentSignature 不一致 → 重新发明文，
//   服务端会写新缓存返回新 cacheId。
//
// 不持久化：服务端 Redis TTL 7 天滑动，重启进程后第一次重新发明文即可，
// 不值得拉个 store 落盘 + 跨版本兼容。

import { useDictionaryStore } from "@/stores/dictionary";

let cachedId: string | null = null;
let cachedSignature: string | null = null;

/** 当前应该送给 refine 的热词字符串：取所有 enabled=true 的词条，term 半角逗号分隔。 */
export function buildHotwordsFromDictionary(): string {
  const entries = useDictionaryStore.getState().entries;
  return entries
    .filter((e) => e.enabled)
    .map((e) => e.term.trim())
    .filter(Boolean)
    .join(",");
}

/**
 * 调 refine 前调一次。返回 `{ hotwords, hotwordsCacheId }`：
 * - 永远返回当前最新的 hotwords（用于服务端 410 后端兜底回退路径）；
 * - 若内容签名与上次返回 cacheId 时一致，附带 cacheId 走 Redis 命中路径。
 */
export function getHotwordsForRefine(): {
  hotwords: string;
  hotwordsCacheId: string | undefined;
} {
  const hotwords = buildHotwordsFromDictionary();
  const sig = hotwords; // 内容即签名——hash 留给服务端做，前端只比串
  const id = cachedId && cachedSignature === sig ? cachedId : undefined;
  return { hotwords, hotwordsCacheId: id ?? undefined };
}

/** refine 返回新 cacheId 时调一次。content 是 *本次发出的* hotwords 字符串。 */
export function rememberHotwordsCacheId(content: string, id: string | null): void {
  if (!id) return;
  cachedId = id;
  cachedSignature = content;
}

/** 测试 / 登出 / 切账号时清掉。 */
export function clearHotwordsCache(): void {
  cachedId = null;
  cachedSignature = null;
}
