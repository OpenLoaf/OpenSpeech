import type { SupportedLang } from "@/i18n";

// raw → 各语种显示名。raw 用全小写、去空格做归一化 key。
// 只收"用户大概率会在历史里看到、又有公认本地化译名"的应用；
// 没收的直接回落到原始 raw（保留系统给的那串）。
type Entry = {
  zhCN: string;
  zhTW: string;
  en: string;
};

const TABLE: Record<string, Entry> = {
  // 即时通讯 / 协作
  wechat: { zhCN: "微信", zhTW: "微信", en: "WeChat" },
  weixin: { zhCN: "微信", zhTW: "微信", en: "WeChat" },
  qq: { zhCN: "QQ", zhTW: "QQ", en: "QQ" },
  tim: { zhCN: "TIM", zhTW: "TIM", en: "TIM" },
  dingtalk: { zhCN: "钉钉", zhTW: "釘釘", en: "DingTalk" },
  钉钉: { zhCN: "钉钉", zhTW: "釘釘", en: "DingTalk" },
  feishu: { zhCN: "飞书", zhTW: "飛書", en: "Lark" },
  lark: { zhCN: "飞书", zhTW: "飛書", en: "Lark" },
  飞书: { zhCN: "飞书", zhTW: "飛書", en: "Lark" },
  wecom: { zhCN: "企业微信", zhTW: "企業微信", en: "WeCom" },
  wxwork: { zhCN: "企业微信", zhTW: "企業微信", en: "WeCom" },
  "wechatwork": { zhCN: "企业微信", zhTW: "企業微信", en: "WeCom" },
  企业微信: { zhCN: "企业微信", zhTW: "企業微信", en: "WeCom" },
  tencentmeeting: { zhCN: "腾讯会议", zhTW: "騰訊會議", en: "Tencent Meeting" },
  腾讯会议: { zhCN: "腾讯会议", zhTW: "騰訊會議", en: "Tencent Meeting" },
  voovmeeting: { zhCN: "腾讯会议", zhTW: "騰訊會議", en: "Tencent Meeting" },

  // 办公 / 文档
  wps: { zhCN: "WPS Office", zhTW: "WPS Office", en: "WPS Office" },
  wpsoffice: { zhCN: "WPS Office", zhTW: "WPS Office", en: "WPS Office" },
  tencentdocs: { zhCN: "腾讯文档", zhTW: "騰訊文檔", en: "Tencent Docs" },
  腾讯文档: { zhCN: "腾讯文档", zhTW: "騰訊文檔", en: "Tencent Docs" },
  yuque: { zhCN: "语雀", zhTW: "語雀", en: "Yuque" },
  语雀: { zhCN: "语雀", zhTW: "語雀", en: "Yuque" },

  // 内容 / 娱乐
  bilibili: { zhCN: "哔哩哔哩", zhTW: "嗶哩嗶哩", en: "Bilibili" },
  哔哩哔哩: { zhCN: "哔哩哔哩", zhTW: "嗶哩嗶哩", en: "Bilibili" },
  xiaohongshu: { zhCN: "小红书", zhTW: "小紅書", en: "Xiaohongshu" },
  小红书: { zhCN: "小红书", zhTW: "小紅書", en: "Xiaohongshu" },
  rednote: { zhCN: "小红书", zhTW: "小紅書", en: "Xiaohongshu" },
  douyin: { zhCN: "抖音", zhTW: "抖音", en: "Douyin" },
  抖音: { zhCN: "抖音", zhTW: "抖音", en: "Douyin" },
  weibo: { zhCN: "微博", zhTW: "微博", en: "Weibo" },
  微博: { zhCN: "微博", zhTW: "微博", en: "Weibo" },
  zhihu: { zhCN: "知乎", zhTW: "知乎", en: "Zhihu" },
  知乎: { zhCN: "知乎", zhTW: "知乎", en: "Zhihu" },

  // 音乐
  qqmusic: { zhCN: "QQ 音乐", zhTW: "QQ 音樂", en: "QQ Music" },
  qq音乐: { zhCN: "QQ 音乐", zhTW: "QQ 音樂", en: "QQ Music" },
  neteasemusic: { zhCN: "网易云音乐", zhTW: "網易雲音樂", en: "NetEase Music" },
  cloudmusic: { zhCN: "网易云音乐", zhTW: "網易雲音樂", en: "NetEase Music" },
  网易云音乐: { zhCN: "网易云音乐", zhTW: "網易雲音樂", en: "NetEase Music" },

  // 出行 / 生活
  alipay: { zhCN: "支付宝", zhTW: "支付寶", en: "Alipay" },
  支付宝: { zhCN: "支付宝", zhTW: "支付寶", en: "Alipay" },
  baidunetdisk: { zhCN: "百度网盘", zhTW: "百度網盤", en: "Baidu Netdisk" },
  百度网盘: { zhCN: "百度网盘", zhTW: "百度網盤", en: "Baidu Netdisk" },

  // macOS 系统应用
  terminal: { zhCN: "终端", zhTW: "終端機", en: "Terminal" },
  finder: { zhCN: "访达", zhTW: "Finder", en: "Finder" },
  访达: { zhCN: "访达", zhTW: "Finder", en: "Finder" },
  calendar: { zhCN: "日历", zhTW: "行事曆", en: "Calendar" },
  mail: { zhCN: "邮件", zhTW: "郵件", en: "Mail" },
  notes: { zhCN: "备忘录", zhTW: "備忘錄", en: "Notes" },
  reminders: { zhCN: "提醒事项", zhTW: "提醒事項", en: "Reminders" },
  messages: { zhCN: "信息", zhTW: "訊息", en: "Messages" },
  photos: { zhCN: "照片", zhTW: "照片", en: "Photos" },
  music: { zhCN: "音乐", zhTW: "音樂", en: "Music" },
  maps: { zhCN: "地图", zhTW: "地圖", en: "Maps" },
  preview: { zhCN: "预览", zhTW: "預覽", en: "Preview" },
  systemsettings: { zhCN: "系统设置", zhTW: "系統設定", en: "System Settings" },
  systempreferences: { zhCN: "系统偏好设置", zhTW: "系統偏好設定", en: "System Preferences" },
  textedit: { zhCN: "文本编辑", zhTW: "文字編輯", en: "TextEdit" },
  activitymonitor: { zhCN: "活动监视器", zhTW: "活動監視器", en: "Activity Monitor" },
  appstore: { zhCN: "App Store", zhTW: "App Store", en: "App Store" },
  facetime: { zhCN: "FaceTime 通话", zhTW: "FaceTime 通話", en: "FaceTime" },
  contacts: { zhCN: "通讯录", zhTW: "通訊錄", en: "Contacts" },
  shortcuts: { zhCN: "快捷指令", zhTW: "捷徑", en: "Shortcuts" },
};

function normalize(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, "").replace(/\.app$/, "");
}

export function localizeAppName(raw: string | null | undefined, lang: SupportedLang): string {
  if (!raw) return "";
  const entry = TABLE[normalize(raw)];
  if (!entry) return raw;
  if (lang === "zh-CN") return entry.zhCN;
  if (lang === "zh-TW") return entry.zhTW;
  return entry.en;
}
