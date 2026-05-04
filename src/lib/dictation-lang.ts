// 把 dictation.lang（含 follow_interface）解析成传给后端的稳定 ISO code。
// follow_interface 时按当前界面语言推导：zh-CN/zh-TW → zh，en → en，其它 → auto。

import type { LanguagePref } from "@/i18n";
import type { DictationLang } from "@/stores/settings";

export type ResolvedDictationLang = "auto" | "zh" | "en" | "ja" | "ko" | "yue";

export function resolveDictationLang(
  dictation: DictationLang,
  iface: LanguagePref,
): ResolvedDictationLang {
  if (dictation !== "follow_interface") return dictation;
  if (iface === "zh-CN" || iface === "zh-TW") return "zh";
  if (iface === "en") return "en";
  return "auto";
}
