import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import i18n, {
  resolveLang,
  SUPPORTED_LANGS,
  type LanguagePref,
  type SupportedLang,
} from "@/i18n";

const LANG_CHANGED = "openspeech://lang-changed";

// settings.interfaceLang 改动后唯一入口：切 i18n 当前语言 + 把翻好的托盘菜单文案推给 Rust。
// Rust 侧不嵌 i18n 库，托盘文案完全由前端按当前语言推过去。
export async function syncI18nFromSettings(pref: LanguagePref): Promise<void> {
  const lang = resolveLang(pref);
  await applyLang(lang);
  await pushTrayLabels();
  // overlay 是独立 JS runtime，主窗里 i18n.changeLanguage 不会自动渗透过去。
  // 不广播的话用户改了语言只有主窗换文案，悬浮条仍停在旧语言（直到 app 重启）。
  void emit(LANG_CHANGED, lang);
}

// 只切 i18n.language；不推托盘、不广播——给 overlay 启动时 / 收到广播时用。
export async function applyLang(lang: SupportedLang): Promise<void> {
  if (i18n.language !== lang) {
    await i18n.changeLanguage(lang);
  }
}

// 任何窗口启动时调一次：监听别的窗口推过来的语言变更。
export function listenLangChanged(): Promise<UnlistenFn> {
  return listen<string>(LANG_CHANGED, (e) => {
    const lang = String(e.payload ?? "");
    if ((SUPPORTED_LANGS as readonly string[]).includes(lang)) {
      void applyLang(lang as SupportedLang);
    }
  });
}

async function pushTrayLabels(): Promise<void> {
  const t = i18n.getFixedT(null, "tray");
  const labels = {
    feedback: t("feedback"),
    open_home: t("open_home"),
    open_settings: t("open_settings"),
    mic_submenu: t("mic_submenu"),
    auto_detect: t("auto_detect"),
    auto_detect_with_name: t("auto_detect_with_name"),
    open_dictionary: t("open_dictionary"),
    version_prefix: t("version_prefix"),
    check_update: t("check_update"),
    quit: t("quit"),
  };
  try {
    await invoke("update_tray_labels", { labels });
  } catch (e) {
    console.warn("[i18n] update_tray_labels failed:", e);
  }
}
