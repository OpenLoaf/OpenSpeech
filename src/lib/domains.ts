// AI refine 常见领域：用户多选最多 3 个，作为 prompt 头部 <Domains> system-tag。
// 显示名走 i18n bundle（pages:dictionary.domains.items.<id>），切语言不丢勾选。

import type { LucideIcon } from "lucide-react";
import {
  Bot,
  Brain,
  Camera,
  Car,
  Clapperboard,
  Code2,
  GraduationCap,
  Leaf,
  Megaphone,
  Palette,
  Scale,
  Shield,
  Stethoscope,
  TrendingUp,
  Wrench,
} from "lucide-react";
import i18n from "@/i18n";

// 按大类聚合排序（每行 3 列时同组尽量相邻）：
//   科技数字：programming · ai_ml · cybersecurity
//   创意媒体：design · film_production · photography
//   商业 / 营销：marketing · finance
//   专业服务：law · academic
//   健康 / 心理：medicine · tcm · psychology
//   工业 / 硬件：engineering · automotive
export const DOMAIN_IDS = [
  "programming",
  "ai_ml",
  "cybersecurity",
  "design",
  "film_production",
  "photography",
  "marketing",
  "finance",
  "law",
  "academic",
  "medicine",
  "tcm",
  "psychology",
  "engineering",
  "automotive",
] as const;

export type DomainId = (typeof DOMAIN_IDS)[number];

const DOMAIN_ID_SET = new Set<string>(DOMAIN_IDS);

export function isDomainId(v: string): v is DomainId {
  return DOMAIN_ID_SET.has(v);
}

export const DOMAIN_ICONS: Record<DomainId, LucideIcon> = {
  programming: Code2,
  ai_ml: Bot,
  medicine: Stethoscope,
  law: Scale,
  finance: TrendingUp,
  academic: GraduationCap,
  engineering: Wrench,
  marketing: Megaphone,
  psychology: Brain,
  design: Palette,
  film_production: Clapperboard,
  cybersecurity: Shield,
  photography: Camera,
  tcm: Leaf,
  automotive: Car,
};

export const DOMAIN_LIMIT = 3;

export function getDomainName(id: DomainId): string {
  return i18n.t(`pages:dictionary.domains.items.${id}`, { defaultValue: id });
}

export function getDomainNamesForPrompt(ids: readonly string[]): string[] {
  return getDomainEntriesForPrompt(ids).map((e) => e.name);
}

/** 同 getDomainNamesForPrompt，但返回 id+name 元组让 ASR 路径能查 DOMAIN_KEYWORDS。 */
export function getDomainEntriesForPrompt(
  ids: readonly string[],
): { id: DomainId; name: string }[] {
  const seen = new Set<string>();
  const out: { id: DomainId; name: string }[] = [];
  for (const id of ids) {
    if (!isDomainId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: getDomainName(id) });
    if (out.length >= DOMAIN_LIMIT) break;
  }
  return out;
}
