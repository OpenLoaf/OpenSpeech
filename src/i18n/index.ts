import i18n from "i18next";
import { initReactI18next } from "react-i18next";

export const SUPPORTED_LANGS = ["zh-CN", "zh-TW", "en"] as const;
export type SupportedLang = (typeof SUPPORTED_LANGS)[number];
export type LanguagePref = "system" | SupportedLang;

// Vite 编译期把所有 locale json 抓进来；新增 namespace 只要按命名约定加文件即可。
const files = import.meta.glob("./locales/*/*.json", { eager: true }) as Record<
  string,
  { default: Record<string, unknown> }
>;

const resources: Record<SupportedLang, Record<string, Record<string, unknown>>> = {
  "zh-CN": {},
  "zh-TW": {},
  en: {},
};

const namespaceSet = new Set<string>();
for (const [path, mod] of Object.entries(files)) {
  const m = path.match(/\.\/locales\/([^/]+)\/([^/]+)\.json$/);
  if (!m) continue;
  const lang = m[1];
  const ns = m[2];
  if (!(lang in resources)) continue;
  resources[lang as SupportedLang][ns] = mod.default;
  namespaceSet.add(ns);
}

export function detectSystemLang(): SupportedLang {
  const nav = (typeof navigator !== "undefined" && navigator.language) || "en";
  if (nav.toLowerCase().startsWith("zh")) {
    if (/-(tw|hk|mo)$/i.test(nav) || /hant/i.test(nav)) return "zh-TW";
    return "zh-CN";
  }
  return "en";
}

export function resolveLang(pref: LanguagePref): SupportedLang {
  return pref === "system" ? detectSystemLang() : pref;
}

const initialLang = detectSystemLang();

void i18n.use(initReactI18next).init({
  resources,
  lng: initialLang,
  fallbackLng: "en",
  ns: Array.from(namespaceSet),
  defaultNS: "common",
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
