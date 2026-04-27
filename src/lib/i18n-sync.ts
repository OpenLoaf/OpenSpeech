import { invoke } from "@tauri-apps/api/core";
import i18n, { resolveLang, type LanguagePref } from "@/i18n";

// settings.interfaceLang 改动后唯一入口：切 i18n 当前语言 + 把翻好的托盘菜单文案推给 Rust。
// Rust 侧不嵌 i18n 库，托盘文案完全由前端按当前语言推过去。
export async function syncI18nFromSettings(pref: LanguagePref): Promise<void> {
  const lang = resolveLang(pref);
  if (i18n.language !== lang) {
    await i18n.changeLanguage(lang);
  }
  await pushTrayLabels();
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
