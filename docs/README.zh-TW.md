<div align="center">
  <img src="images/logo-rounded.png" alt="OpenSpeech" width="120" />

  <h1>OpenSpeech</h1>

  <p><strong>按一下快捷鍵說話，文字就出現在游標所在的地方。</strong></p>

  <p>跨平台 AI 語音輸入桌面應用 · Voice typing for every app.</p>

  <p>
    <a href="https://github.com/OpenLoaf/OpenSpeech/releases/latest"><img src="https://img.shields.io/github/v/release/OpenLoaf/OpenSpeech?include_prereleases&style=flat-square" alt="Release" /></a>
    <a href="../LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange?style=flat-square" alt="License" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  </p>

  <p>
    <a href="../README.md">简体中文</a>
    · <a href="README.en.md">English</a>
    · <strong>繁體中文</strong>
  </p>
</div>

---

## 簡介

OpenSpeech 是一款跨平台的桌面端語音輸入工具：在任何應用、任何輸入框，按一下快捷鍵開始說話，再按一下就把轉寫文字寫到游標位置。Windows / macOS / Linux 三端同步發佈。

**說一段大白話，落到游標裡就是結構化文件。** 錄音 → 轉寫 → AI 清洗，口誤、語氣詞、自我糾錯全部抹平，再按你想要的格式重排：

<p align="center">
  <img src="images/demo-zh-TW.gif" alt="OpenSpeech 演示：錄音、轉寫、AI 清洗、寫入游標" width="640" />
</p>

## 功能

**把語音直接變成你想要的文字**
按一下快捷鍵開始說話，再按一下結束，文字落在游標位置。說話時的「嗯啊呃」、口誤、改口都會被 AI 整理成乾淨的文字，不是逐字打出來。VS Code、聊天視窗、信件、終端機全部通用。

**想發什麼語言就發什麼語言**
按翻譯快捷鍵說一段中文，游標位置直接出英文（或日、韓、法、德、西、簡中）。也可以讓它給你「原文 + 譯文」兩份。

**會議自動整理紀要**
長時間錄音、自動依發言人分段、AI 一鍵生成 Markdown 紀要——決策、待辦、關鍵討論點都幫你列好，可以匯出。中途斷網會自動重連，時間軸不會斷。

**它知道你的專業**
勾選你的領域（醫學、法律、心理、程式設計、設計、金融…共 16 個），AI 整理時不會把術語改成「通俗近義詞」。再加個人字典，把人名、品牌、專有名詞補上，辨識更穩。

**想用自己的 API 也行**
騰訊雲、阿里百煉，或任何相容 OpenAI 協定的 API，直接填進去就能用。憑證存在系統鑰匙圈裡，不會上送伺服器。

**歷史與用量都在本機**
每次錄音、AI 整理後的版本、當時在哪個 App 裡——全部存本機，可翻看、複製、重新轉寫。還能看本月用了多久、哪個 App 用得最多。

**快捷鍵隨你改**
聽寫、翻譯聽寫、喚起主視窗、打開 AI 工具——四個快捷鍵都能改成你順手的組合。會自動偵測衝突，也會提醒你按到了系統佔用的快捷鍵。

**桌面應用程式該有的都有**
常駐工具列、開機自動啟動、應用程式內自動更新、三語介面、明暗主題跟隨系統、電腦睡眠喚醒後不會被踢登入。

## 截圖

<p align="center">
  <img src="images/chinese.png" alt="OpenSpeech 中文介面" width="640" />
</p>

## 安裝

前往 [Releases](https://github.com/OpenLoaf/OpenSpeech/releases/latest) 下載對應平台安裝包：

- **macOS**：`OpenSpeech_x.y.z_universal.dmg`（macOS 10.15+）
- **Windows**：`OpenSpeech_x.y.z_x64-setup.exe`
- **Linux**：`.AppImage` / `.deb` / `.rpm`

首次啟動需授予麥克風權限；macOS 還需要輔助使用（Accessibility）權限。

## 路線圖

### 已實現
- [x] 雲端轉寫（即時 / 整段兩種模式）
- [x] AI 整理（去除 um/uh + 口誤 + 中文口語數字 → 阿拉伯數字）
- [x] 翻譯聽寫（8 種目標語言 + 雙語輸出）
- [x] 會議轉錄（說話人分離 + AI 紀要 + Markdown 匯出 + 斷網重連）
- [x] AI 領域系統（16 個專業領域多選）+ 個人字典
- [x] 自訂快捷鍵（聽寫 / 翻譯 / 喚起主視窗 / 打開 AI 工具，自動偵測衝突）
- [x] 用量統計（本月時長 / 字數 / Top App / 活躍時段）
- [x] 自訂 AI 供應商（相容 OpenAI 協定端點）
- [x] 自訂 ASR 供應商：騰訊雲、阿里百煉（DashScope）
- [x] 歷史紀錄與重試 / 401 自動續轉寫

### 待開發
更多 STT 供應商接入：

- [ ] Microsoft Azure Speech
- [ ] Google Cloud Speech-to-Text
- [ ] 火山引擎（豆包）語音識別
- [ ] 科大訊飛語音識別
- [ ] OpenAI Whisper API
- [ ] Deepgram
- [ ] AssemblyAI

## 快速上手

1. 啟動 OpenSpeech 並授予權限。
2. 在任意輸入框點擊游標。
3. 按一下快捷鍵開始說話——
   - macOS：`Fn + Ctrl`
   - Windows：`Alt + Win`
   - Linux：`Ctrl + Super`
4. 再按一下同樣的快捷鍵結束，文字自動寫入。

## 開發

技術棧：Tauri 2 · React 19 · TypeScript · Rust · Tailwind CSS 4。

```bash
git clone https://github.com/OpenLoaf/OpenSpeech.git
cd OpenSpeech
pnpm install
pnpm tauri dev
```

環境需求：Node.js ≥ 18、pnpm ≥ 9、Rust stable。平台相依套件請參閱 [Tauri 官方先決條件](https://tauri.app/start/prerequisites/)。

## 貢獻

歡迎提 Issue / Pull Request。較大的改動建議先開 Issue 討論方案。

## 授權

[PolyForm Noncommercial 1.0.0](../LICENSE) © OpenLoaf

個人、研究、教育、非營利組織等**非商業用途**可自由使用、修改和散布。如需商業授權（包含但不限於將本專案用於商業產品、SaaS 服務或閉源散布），請聯絡作者取得單獨授權。
