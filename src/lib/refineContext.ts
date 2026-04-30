// OL-TL-005 referenceContext 拼装：把最近 3 条 history（< 1 小时）按时间正序拼成
// 一段参考上下文，帮模型在跨会话指代 / 缩略 / 接续式表达时消解。
// 服务端把它包在 `<system-tag>` 里作为首条 user 消息送给模型，**不会写入 refined 输出**。
//
// 每条带相对时间标记（如 `[3 分钟前]`），让模型能感知"刚刚说过的"与"略早说过的"
// 的远近，在指代消解（"那个东西"、"刚才那条"）时更精确。

import type { HistoryItem } from "@/stores/history";

const MAX_ITEMS = 3;
const MAX_AGE_MS = 60 * 60 * 1000;
// 服务端硬上限 50000 字符。预留 200 字符给分隔符 / 包裹文本，避免极端拼接超长被 400。
const MAX_CHARS = 49_800;

function formatRelativeTime(deltaMs: number): string {
  const sec = Math.max(0, Math.round(deltaMs / 1000));
  if (sec < 60) return `${sec} 秒前`;
  const min = Math.round(sec / 60);
  return `${min} 分钟前`;
}

export function buildRefineContext(
  items: readonly HistoryItem[],
  opts?: { excludeId?: string; now?: number },
): string | undefined {
  const excludeId = opts?.excludeId;
  const now = opts?.now ?? Date.now();
  const cutoff = now - MAX_AGE_MS;

  const picked: { createdAt: number; body: string }[] = [];
  for (const it of items) {
    if (picked.length >= MAX_ITEMS) break;
    if (excludeId && it.id === excludeId) continue;
    if (it.status !== "success") continue;
    if (it.created_at < cutoff) continue;
    const body = (it.refined_text ?? it.text ?? "").trim();
    if (!body) continue;
    picked.push({ createdAt: it.created_at, body });
  }

  if (picked.length === 0) return undefined;

  // items 在 store 里按 created_at DESC 存放，picked 顺序是"新→旧"。
  // 拼成 prompt 时要给模型"旧→新"的时间感，让最后一条最贴近当前 transcript。
  const ordered = picked.slice().reverse();
  let joined = ordered
    .map(({ createdAt, body }) => `[${formatRelativeTime(now - createdAt)}] ${body}`)
    .join("\n\n");

  if (joined.length > MAX_CHARS) {
    // 超长时优先保留尾部（更接近当前 transcript），从头部截断。
    joined = joined.slice(joined.length - MAX_CHARS);
  }
  return joined;
}
