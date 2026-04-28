---
name: openspeech-dev
description: OpenSpeech 项目（跨平台 AI 语音输入桌面应用，Tauri 2 + React 19 + Rust）的开发规约入口。**当用户在 OpenSpeech 仓库里提出任何开发请求时都应触发**——加功能、改 UI、调快捷键/录音/注入、装依赖、读 docs/ 业务规则都先加载本技能。触发关键词：OpenSpeech、语音输入、听写、录音、快捷键、Tauri、shadcn、Rust 插件、业务规则、词典、历史记录、TypeLess、REST STT、realtime ASR。
---

# OpenSpeech 开发技能

跨平台 AI 语音输入桌面应用：按住快捷键说话 → 录音 → OpenLoaf SaaS realtime ASR（默认）转写 → 把文字注入当前焦点输入框。

---

## ⚠️ 铁律：SKILL.md 只写源码读不出的事实

**写入本技能前先问自己一句：这条信息能不能用一次 grep / 一次 Read 从源码里直接拿到？能，就不要写。**

| ❌ 不要写进来 | ✅ 应该写进来 |
|---|---|
| 函数 / 类 / 字段 / 模块名（grep 即得） | 决策理由、踩过的坑、外部约束 |
| 配置项的值（读 `package.json` / `Cargo.toml` / `tauri.conf.json` / `capabilities/*.json` 即得） | "为什么必须这样选"——用源码无法表达的取舍 |
| 流程的逐步描述（读对应模块源码即得） | 跨文件 / 跨进程的隐性协作契约 |
| 事件名、命令名、payload 结构（读源码即得） | 哪些 docs/ 文件是该话题的 SSoT |
| 业务规则细节（已在 `docs/*.md` 里） | 指向 docs/ 的索引 |

**当源码已经是 SSoT 时，本技能只列路径 + 一行用途，让 Claude 自己去读。**

> 对应反模式：见到"为什么不用 X"的大段历史叙事、列出三个以上事件 payload、把 store action 全列一遍、复述 capability 文件——都该删，改成"读 `path/to/file.rs`"。

---

## 自更新约定

**本技能必须与项目规则保持同步。** 改动以下任一项时，同会话内一并更新本文件：

| 项目变更 | 更新章节 |
|---|---|
| 升降级 / 增删 **前端依赖** 或 **Rust crate / Tauri 插件** | "技术栈"表 |
| 变更 **目录结构**（新增 src 子目录、移动文件） | "目录索引" |
| 变更 **构建脚本 / 包管理器 / 工具链** | "包管理与脚本" |
| **新增 / 重命名 / 删除 `docs/*.md`** | "业务规则索引" |
| 出现一条新的、源码读不出的决策 / 跨文件协作 / 踩坑 | 找最贴近的章节加一行；若无章节再开 |

不确定要不要更新时，默认更新。

---

## 项目本质

| 维度 | 约定 |
|---|---|
| 形态 | 桌面应用（Win / macOS / Linux），非 Web、非 CLI |
| 后端 | Rust（`src-tauri/`）：全局快捷键、录音、文本注入、本地 SQLite |
| 前端 | React（`src/`）：主窗口（首页/历史/词典/设置）+ 悬浮录音条子窗口 |
| 模型 | **默认走 OpenLoaf SaaS realtime ASR**（WebSocket 流式）；保留"BYO REST 端点"扩展槽，MVP 仅 SaaS 一路 |
| 隐私立场 | 录音仅落盘本机（`app_data_dir/recordings/<id>.wav`）；除登录态下的 SaaS realtime ASR 外不发任何服务器；详见 `docs/privacy.md` |

---

## 技术栈

> **真相来源在 `package.json` 与 `src-tauri/Cargo.toml`**。本表只列"读不出的取舍"。

### 关键版本约束（不可随意改）

- **Tailwind v4**（不再走 PostCSS，入口 `src/App.css` 用 `@import "tailwindcss"`）
- **React Router v7**（API 与 v6 不兼容，禁止降级）
- **Rust edition 2024**
- **`rdev` = `rustdesk-org/rdev` fork，pin commit `a90dbe11`**
  - 不用 crates.io 0.5.3：上游在 macOS 子线程跑 listen 遇首个 key event 进程静默 abort（无 panic、无报错）。
  - fork 还修了 `Key::Function` 映射（macOS CGEventTap）。
  - `rdev::listen` **进程内只能调一次**——新订阅扩展 `src-tauri/src/hotkey/modifier_only.rs`，不要另起 listen。
  - 国内网络拉不到 git 时走 `path = "vendor/rdev"` 本地兜底。
- **`reqwest` 走 `rustls`**（关 default-features，避免拖入 native-tls）
- **`tauri` 启用 `tray-icon` feature**（托盘依赖，不可移除）
- **`openloaf-saas` 跟随 `@openloaf-saas/sdk` Node 包对齐版本号**

### 添加依赖的规范动作

| 类型 | 命令 |
|---|---|
| Tauri 插件 | `pnpm tauri add <name>` —— 同步处理 Cargo / npm / capabilities / `lib.rs` 注册 |
| Rust 非 Tauri crate | `cargo add --manifest-path src-tauri/Cargo.toml <crate>` |
| shadcn 组件 | `pnpm dlx shadcn@latest add <name>` |

> 任何能被脚手架生成的东西禁止手写同等内容。

### 字体 / UI 体系

- shadcn `base-nova` 风格、`neutral` 基色
- 正文 `@fontsource-variable/inter`，mono `@fontsource/space-mono`
- 视觉语言 = **TE 工业风**（详见同目录软链 `te-industrial-frontend` skill）

### 机密存储

API Key 等机密 **不走 `tauri-plugin-store`**，只走 `keyring` crate（系统密钥链）。前端封装在 `src/lib/secrets.ts`。

---

## 目录索引

```
docs/                           业务规则 SSoT（见"业务规则索引"）
src/
├── components/
│   ├── ui/                     shadcn 生成产物（不要手写）
│   ├── Layout.tsx              应用壳 + 关闭流程订阅
│   ├── SettingsContent.tsx     设置内容（Dialog 与 /settings 共享）
│   ├── *Dialog.tsx             各类弹窗
│   ├── HotkeyPreview.tsx       快捷键视觉预览（Home / Onboarding 共用）
│   ├── LiveDictationPanel.tsx  录音波形 + realtime 转写面板
│   └── LoadingScreen.tsx       启动 splash
├── pages/                      每页一个目录 + index.tsx
│   └── Onboarding/             4 步引导（当前为 UI mock，未接业务）
├── stores/                     Zustand：hotkeys / recording / settings / ui / history / dictionary / playback
├── lib/                        invoke 封装：audio / stt / secrets / db / ids / autostart / permissions / i18n-sync / errors
├── i18n/
│   ├── index.ts                i18next 初始化（auto-glob locales/*/*.json）
│   └── locales/{zh-CN,zh-TW,en}/{common,settings,pages,onboarding,overlay,dialogs,errors,hotkey,tray}.json
├── router.tsx                  React Router v7 createBrowserRouter
├── App.css                     Tailwind v4 + shadcn vars + TE 双主题 vars
└── main.tsx                    bootPromise 解析后切到 RouterProvider
src-tauri/
├── src/
│   ├── lib.rs                  tauri::Builder + 插件注册 + setup
│   ├── audio/                  cpal 采集 + WAV 落盘 + PCM16 喂 stt
│   ├── stt/                    OpenLoaf SaaS realtime ASR worker
│   ├── hotkey/                 combo / modifierOnly / doubleTap 三路编排
│   ├── permissions/            macOS 系统权限检测 / 请求 / 跳转
│   ├── secrets/                keyring 包装
│   ├── inject/                 文本注入（剪贴板 + 粘贴）
│   ├── openloaf/               SaaS 登录 / token / 用户档案 / 支付
│   └── db/                     SQLite 迁移 + recordings_dir 帮手
├── capabilities/               权限声明（default.json + desktop.json）
├── examples/                   离线诊断脚本（如 test_realtime_asr）
└── tauri.conf.json
.claude/skills/
├── openspeech-dev/             本技能
├── te-industrial-frontend/     软链：TE 风实现指南
└── openloaf-saas-sdk-rust/     软链：SaaS SDK 用法
```

> 子模块的具体函数 / 字段 / 事件名 **直接读对应文件**，不在本技能复述。

---

## 包管理与脚本

包管理器：**pnpm**（corepack 已启，10+）。不要换 npm/yarn/bun。

| 命令 | 作用 |
|---|---|
| `pnpm tauri dev` | **桌面开发主命令** |
| `pnpm tauri build` | 打安装包 |
| `pnpm dev` | 仅 Vite，纯调 UI 时用 |
| `pnpm build` | `tsc && vite build`，验前端类型 |
| `pnpm version patch\|minor\|major` | 唯一发版动作（见"版本号 SSoT"） |

---

## 开发规约（源码读不出来的部分）

### 通用
- 路径别名 `@/` 已配；新建文件优先用 `@/...`。
- Rust 新模块在 `src-tauri/src/<domain>/mod.rs`；`lib.rs` 只装配。
- 任何面向用户的行为**先读 `docs/` 对应文件**，不要凭感觉实现。

### i18n（zh-CN / zh-TW / en，已启用）

> 真相来源：`src/i18n/index.ts` + `src/i18n/locales/{lang}/{ns}.json`。本节只讲源码读不出的规约。

- **加载机制**：`import.meta.glob("./locales/*/*.json", { eager: true })` 编译期收齐所有 namespace。**新增 namespace 只需加 3 个语言下同名 json**，不必改 `index.ts`。
- **defaultNS = `common`**：`actions / lang / value` 这类通用 key 写在 `common.json`，调用 `t("actions.cancel")` 不带前缀；其他 ns 一律 `t("ns:section.key")` 形式（如 `t("settings:lang.label")`）。
- **语言来源唯一入口**：`useSettingsStore.general.interfaceLang`，类型 `LanguagePref = "system" | "zh-CN" | "zh-TW" | "en"`。**不要直接 `i18n.changeLanguage`**——一律 `setGeneral("interfaceLang", v)`，store 内会自动调 `syncI18nFromSettings`（`src/lib/i18n-sync.ts`）：切 i18n 当前语言 + 把翻好的托盘 labels 推给 Rust。
- **托盘菜单文案前端推**：Rust 不嵌 i18n。`src-tauri/src/lib.rs` 的 `TrayLabels` 全局态由 invoke `update_tray_labels` 写入；空时英文兜底。tray.json 的 10 个 key 名固定，与 `src/lib/i18n-sync.ts::pushTrayLabels` 严格一致，**改 key 名两边一起改**。占位符用 `{{name}}` / `{{version}}`（双花括号，Rust 端 `replace` 用这个语法）。
- **后端面向用户的字符串发 stable code，不发翻译文案**：如 `Err("AUTH_LOGIN_TIMEOUT".into())`。前端 `src/lib/errors.ts::translateBackendError` 做 code → `t("errors:auth.login_timeout")` 映射。**Rust 内部 log（`log::warn!` 等）保留中文/英文随意，不翻译**——日志不是用户面。
- **保留不翻清单**（跨语言原样保留）：
  - 品牌：`OpenSpeech / OpenLoaf / Tauri / React / Whisper / TypeLess / GitHub / shadcn / Apple / macOS / Windows / Linux`
  - 按键名：`Fn / Ctrl / Cmd / Alt / Shift / Space / Esc / Tab / Enter / Caps`
  - 技术缩写：`STT / API / WAV / PCM / VAD / ASR / LLM / SDK / OS / URL / Key / Token / WebSocket / REST / SaaS / BYO / TCC`
  - **TE 装饰性全大写英文 mono 小标签**（section 标题如 `GENERAL` / `PERSONALIZATION`）—— 这是 TE 美学的一部分，跨语言保留有视觉统一感。
- **新增文案的标准动作**：
  1. 找最贴近的 ns（`common / settings / pages / onboarding / overlay / dialogs / errors / hotkey / tray`），不够再开新 ns。
  2. zh-CN / zh-TW / en **同时**加，不要只加一个语言。
  3. zh-TW 必须真正繁体化（"设置→設定 / 软件→軟體 / 录音→錄音 / 用户→使用者 / 网络→網路 / 保存→儲存 / 登录→登入"），按台湾正体习惯，不要简单繁简机翻。
  4. en 用 sentence case，不要滥用 Title Case。
- **不翻**：注释、`console.log/warn/error` / `log::*` / `tracing::*` 中的中文、import 路径、内部对比用的字面量。
- **Zustand store / 非 React 模块** 用 `import i18n from "@/i18n"; i18n.t(...)`；React 组件用 `useTranslation` hook。

### 状态管理
- 跨窗口持久化 → `tauri-plugin-store` 或 SQLite。
- 单窗口 UI → Zustand。
- **不用 Redux / Jotai / Context 大杂烩**。

### 样式（TE 工业风）
- `index.html` 默认 `<html class="dark">`；主题切换只 toggle 此 class。
- 页面只用 `te-*` 语义 token（`bg-te-bg` / `text-te-fg` / `text-te-accent` 等），定义在 `src/App.css` 的 `@theme inline`。
- **禁硬编码** `bg-black` / `text-white` / `bg-white` / `text-black`。
- 字体：`font-mono` 用于标题/标签/编号/按钮；`font-sans` 用于正文。
- shadcn Dialog 的 TE 覆盖：`rounded-none` + `border border-te-gray` + `bg-te-bg` + `!gap-0`，新增 Dialog 沿用。
- Logo wordmark：`OPEN` 用 `text-te-fg`，`SPEECH` 用 `text-te-accent`，紧贴同容器，不改。
- Logo 图形资源（`public/`，三个一组按场景选用，不要混用）：
  - `logo-write.png` —— 白色线条 + 透明背景。**用于深色应用 UI 内的品牌头**（侧栏顶部 / Onboarding header / Welcome hero / LoadingScreen splash / Home hero 标签行）。
  - `logo-black.png` —— 黑色线条 + 透明背景。备用浅底前景，目前 UI 内未直接使用。
  - `logo-write-bg.png` —— 白色背景方图（自带底色）。**双用途**：① `index.html` favicon（浏览器 tab / dev 模式标题图标，需要不透明背景才不会被深色 tab 吞掉）；② `pnpm tauri icon` 的源图，生成 `src-tauri/icons/` 全平台 icon（macOS .icns / Windows .ico / iOS / Android / Linux PNG）——**应用 Dock / 任务栏图标统一走它**。
  - 替换图标流程：编辑 `public/logo-write-bg.png` → `pnpm tauri icon ./public/logo-write-bg.png` 一键再生全平台 icon；favicon 自动跟随（同一个文件）。手工裁切 / 单独换 `.icns` / 给 favicon 改用透明 PNG 都是反模式。
  - macOS Dock 图标更新后看不到变化：是系统 iconservices 缓存。`killall Dock` 通常即可；顽固时 `sudo rm -rf /Library/Caches/com.apple.iconservices.store && killall Dock`。
- 禁渐变 / glow / 重阴影 / 圆角 > `rounded-sm` / pill / emoji 装饰。
- 动画用 `framer-motion` 的 `whileInView` + `viewport={{ once: true }}`，0.4–0.6s，禁 spring bounce。
- `App.css` 已对 `html / body / #root` 关 overscroll bounce；新建全屏容器遵守。
- 详细组件模板见同目录软链 `te-industrial-frontend` skill。

### Tauri 权限关键项（不可遗漏）
`core:default` **不含**以下，需在 `capabilities/default.json` 显式声明：
- `core:window:allow-start-dragging` —— `data-tauri-drag-region` 工作的前提；拖拽失效先查这里。
- `clipboard-manager:allow-write-text` —— `inject_paste` 写剪贴板的前提；`clipboard-manager:default` 只放 readText。
- `core:window:allow-hide / -show / -set-focus / -unminimize` —— 我们目前通过 Rust 命令包装，capability 留着防误用。

新加 invoke / 插件时显式声明，**避免全量通配 `allow-*`**。

### 窗口与标题栏
- 主窗口 `titleBarStyle: "Overlay"` + `hiddenTitle: true`；macOS 红绿灯嵌入内容区左上角。
- 主窗口尺寸：`minWidth=800 / minHeight=600`，初始上限 `1060×740`，实际启动尺寸由 `lib.rs setup` 按主显示器 work area 自适应计算（上限与屏幕可用空间取小值），`maxWidth=1600 / maxHeight=1100`（均为 logical px）。
- **全屏被全局禁用**：`tauri.conf.json` 初始 `fullscreen: false`；macOS 端在 `lib.rs` 的 `disable_macos_fullscreen` 里清 `FullScreenPrimary` / 加 `FullScreenNone`，绿按钮降级为 zoom。**不要**再加"进入全屏"菜单项或调 `set_fullscreen(true)`。
- **Drag region 分布**（必读，否则只剩侧边栏一小块能拖）：
  - 侧边栏顶部 `h-8 shrink-0 data-tauri-drag-region`（240×32）。
  - 主内容区 Layout 层**不挂** drag 条；由 page 自己声明：
    - 有 sticky header 的 page（Dictionary / History）→ sticky header 外层加 `data-tauri-drag-region`，内部交互元素加 `data-tauri-drag-region="false"` 豁免。
    - 无 sticky header 的 page（Home）→ section 顶部挂 `sticky top-0 h-8 data-tauri-drag-region` 透明条，用负 margin 抵消 padding 撑满。
  - 不用 absolute overlay：drag 元素必须是 scroll 容器后代，否则 wheel 事件被吃。
- 透明非交互浮窗（悬浮录音条）**豁免** drag region：`focus:false` + `decorations:false` + `transparent:true` + `alwaysOnTop:true` + `skipTaskbar:true`，不应被拖。
- macOS 跨 Space / 全屏可见：`visible_on_all_workspaces(true)`（Tauri 2.1+）；低版本走 `objc2` 设 `collectionBehavior |= canJoinAllSpaces | fullScreenAuxiliary`。失败回退"全屏态下浮窗不可见、靠声音兜底"，已知平台限制。
- 悬浮条尺寸 `280×56` 是 logical px，由系统按 DPI 缩放，不要自乘 `devicePixelRatio`。

### 窗口生命周期 & 托盘（关键约定）
- **关闭流程**：Rust 是唯一拦截入口（`WindowEvent::CloseRequested` + `RunEvent::ExitRequested` 双层兜底） → emit `openspeech://close-requested` → 前端读 `settings.closeBehavior`（`ASK / HIDE / QUIT`）决定。**不要**在前端用 `getCurrentWindow().onCloseRequested()`（StrictMode 下时序不稳）。
- **macOS Cmd+Q 必须自建 App Menu 接管**：Tauri 2 在 macOS 下若无 `app.set_menu`，Cmd+Q 走 NSApp `terminate:` **绕过** Rust 与前端所有拦截直接退出。在 `#[cfg(target_os="macos")]` 块里建含 `quit_app` accelerator 的 App Menu，由菜单系统接管后再 emit close-requested。Edit / Window 子菜单同步补全。
- **listen 订阅必须 `cancelled` flag + `unsub()`**：`useEffect` 里 `await listen(...)` 返回前组件可能已重挂，dev 下 emit 一次会回调两次。Pattern 见 `Layout.tsx`。
- **macOS Dock 图标切换**：仅 `window.hide()` 不会隐藏 Dock；`hide_main_window` hide 后切 `Accessory`，`show_main_window` show 前切 `Regular`。**前端不要直接 `window.hide()/show()`**，一律走 `invoke("hide_to_tray")` / `invoke("show_main_window_cmd")`。
- 托盘菜单"退出"**直接** `app.exit(0)`，不走 close-requested（用户已明确选）。
- 主窗口启动期 macOS 输入监控授权策略：`hotkey::modifier_only::init` 在 spawn `rdev::listen` 前先用 `permissions::input_monitoring_granted()`（`IOHIDCheckAccess`，**静默不弹框**）；未授权则跳过 listen，本会话内 modifier-only 不工作。Onboarding 通过 `IOHIDRequestAccess` + `relaunch_app` 引导授权。**为什么**：避免首启时 listen 自动触发的"Keystroke Receiving"系统弹框被随后 show 的主窗口遮挡。新增"首启即触发系统弹框"的能力（如 enigo / cpal）遵循同模式。

### realtime ASR 协作约定（OpenLoaf SaaS）
> 用法权威 = 同目录软链 `openloaf-saas-sdk-rust` skill；事件名 / 命令名 / payload **读 `src-tauri/src/stt/mod.rs` + `src/lib/stt.ts` + `src/stores/recording.ts`**，本技能只写源码不会写的事实。

- `RealtimeSession` 内含 `std::sync::mpsc::Receiver`（!Sync），**不能 Arc 跨线程**——必须"session 单所有者 + worker 线程独占 + `mpsc::Sender<Control>` 进 worker"模式。
- `close(mut self)` 吃所有权——**不要显式调**；让 Drop 自动发 Close 帧。
- `send_start` 第二参数 `None` 时显式标类型：`None::<serde_json::Value>`。
- PCM 帧 = **PCM16 LE bytes**，channels = **1**：cpal 默认 f32 多 ch，必须在 audio callback 里就地下混 mono + 量化。`stt_start` 的 `send_start` 也必须报 `channels:1`，否则服务端按 2ch 解析全错位（2026-04-25 栽过）。
- 采样率不重采样，跟随设备原生 sr 透传给服务端。
- **feature ID 是 `realtimeAsr`（小写 sr），不是 `realtimeASR`**——错了 WS 握手直接 500（2026-04-25 栽过）。
- **未登录路径**：`stt_start` 返 `"not authenticated"`，前端只 `warn`，**录音继续**，history 落占位文字。不要因 SaaS 未登录禁录音。
- **离线快速测试**：debug build 在 `apply_session` 时 dump session 到 `~/.openspeech/dev_session.json`（chmod 600，release 编译掉）；配套 `cargo run --example test_realtime_asr` 绕开 audio/hotkey 直测 SDK ↔ SaaS。

### 触发录音 Gate（`recording.ts::start`）
按顺序拦截，任一命中即放弃本次录音：
1. 未登录且未配 BYO endpoint → `useUIStore.openLogin()`
2. SAAS 路径 + `navigator.onLine === false` → 同步拦截 + `openNoInternet()`
3. SAAS 路径乐观启动后异步 `invoke("openloaf_health_check")`，false 且仍在 preparing/recording → 回滚 + 弹无网络

### Autostart
`syncAutostart(desired)` 只在期望 ≠ OS 实际时写注册项；boot 与设置 Switch 改动各同步一次。失败只记日志，不阻断。

### 版本号 SSoT 与发版
- **唯一事实源 = `package.json.version`**。`tauri.conf.json.version` 设为 `"../package.json"` 自动 resolve；`Cargo.toml` 由 `scripts/sync-version.mjs` 在 `pnpm version` lifecycle 同步。
- 发版 = `pnpm version patch|minor|major` → 自动 commit + tag → `git push && git push --tags` → `.github/workflows/release.yml` 按 6 个 native target 矩阵打包到 draft Release，手动 Publish 后 updater 才看得到。
- **本地裸 build 不走 updater 签名**：`bundle.createUpdaterArtifacts` 默认 `false`，CI 在 `release.yml` 临时开。本地要测 updater 包同样手动 `--config '{"bundle":{"createUpdaterArtifacts":true}}'` + `export TAURI_SIGNING_PRIVATE_KEY=...`（**绝对路径，不要 `~`**——Tauri 会把字面量 `~` 当 base64 解码 panic）。
- **Dev 模式跳过 `check()`**：`import.meta.env.DEV` 一律不调，pubkey 未配 + `latest.json` 未发布时 Rust 侧会打 ERROR 污染日志。托盘"检查更新"仍可手动触发。
- **macOS 签名/公证 Secrets** 复用 OpenLoaf 仓库命名（`MAC_CER_BASE64` / `MAC_CER_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`），CI 内映射成 Tauri 认的变量名。Secrets 为空时 tauri-action 自动跳签名。证书每年到期需重新导出 `.p12` 更新 `MAC_CER_BASE64`。
- **Hardened Runtime entitlements**（`src-tauri/entitlements.plist`）已开 `network.client / device.audio-input / automation.apple-events / cs.allow-jit / allow-unsigned-executable-memory / disable-library-validation`，分别为 STT / cpal / enigo / WKWebView / rdev fork / 动态加载兜底。

### Windows NSIS 安装包国际化
- NSIS 语言列表在 `tauri.conf.json` 的 `bundle.windows.nsis.languages`，与应用内 i18n 三语对齐。NSIS 启动时自动匹配 Windows 系统 UI 语言，无需用户手动选择；未命中则 fallback English。新增 i18n 语言时同步往此数组加对应 NSIS 语言名。

### Dialog 优先：设置 / 账户
两者都用 Dialog，由 Layout 侧边栏底部图标按钮触发。**`SettingsContent.tsx` 是 Dialog 与 `/settings` 路由共享组件**，改设置只动一处。账户内容若未来变重再评估拆页。

### WebView 右键菜单
`main.tsx` 启动时全局 `preventDefault` `contextmenu`。个别输入框需要原生菜单时单独 `stopPropagation`。

### 直接控制前端：tauri-mcp-server（dev 专用）

**用途**：当任务需要 Claude 自己看 / 操作运行中的 UI——截图复盘视觉、找元素、执行 webview JS、读 console 日志、监控 IPC、模拟点击/键入——优先走这个 MCP，不要让用户手动截屏粘贴或在 DevTools Console 里手敲命令再贴回来。

**接入现状**（不可改，改了 webview 工具会全 2s timeout）：
- `src-tauri/Cargo.toml`：`tauri-plugin-mcp-bridge`（仅 `#[cfg(debug_assertions)]` 注册，release 自动剔除）
- `src-tauri/src/lib.rs`：`Builder::new().bind_address("127.0.0.1").build()`，**仅本机**，不暴露 0.0.0.0
- `src-tauri/capabilities/default.json`：`mcp-bridge:default` 已声明
- **`tauri.conf.json` 必须 `app.withGlobalTauri = true`**——这是 webview 端 bridge shim 调 invoke 的前提；缺了的话 `driver_session` 能连上、`manage_window list` 能跑（走 Rust 命令通道），但所有 `webview_*` 工具会全部在 2s 内超时。**默认是 false，新建 Tauri 工程时务必检查**。

**前端 npm 包不需要**——MCP server 直接走 WebSocket :9223 跟 Rust 插件通信，前端零依赖。

**触发条件**（满足即可启用）：
- 用户描述包含"看一下界面 / 截一下图 / 控制一下 UI / 模拟点一下 / 读一下 console / 监控一下 IPC / 元素长什么样"
- 调试涉及视觉回归、动效、布局错位、layout 抖动
- 排查录音条 / Onboarding / Dialog 等子窗口 / 临时 UI 状态

**典型用法**：
```
driver_session(start) → 看 status / manage_window list 找窗口 label
→ webview_screenshot {windowId: "main" | "overlay"}
→ webview_execute_js / webview_find_element / webview_interact / read_logs
→ 任务结束 driver_session(stop)
```

**子窗口（overlay）**：默认 hidden，截图前需先触发显示（按快捷键启动录音、或用 `webview_execute_js` 调对应 invoke），不要直接对 hidden 窗口截图。

---

## 业务规则索引（docs/）

**代码实现前先读对应 docs 文件。** 业务规则 SSoT 在这里，本技能不复述。

| 任务 | 先读 |
|---|---|
| 产品定位 / TypeLess 对比 | `docs/product.md` |
| 实现或讨论任一功能 | `docs/features.md` |
| **录音 / 快捷键触发 / 转写 / 注入** 状态机与边界 | `docs/voice-input-flow.md` |
| 设计或改动快捷键 | `docs/hotkeys.md` |
| 历史记录 + SQLite schema | `docs/history.md` |
| 词典 + hints | `docs/dictionary.md` |
| 设置页任一项 | `docs/settings.md` |
| 数据流 / 本地存储 / 上传边界 | `docs/privacy.md` |
| 麦克风 / 辅助功能 / Wayland 等权限 | `docs/permissions.md` |
| 首次启动向导 | `docs/onboarding.md` |
| 计费 / 试用 / 账户（MVP 暂缓） | `docs/subscription.md` |
| 多 Provider / Adapter / 不登录可用 / 开源接入 | `docs/speech-providers.md` |

新增或重命名 `docs/*.md` 时回来更新此表。

---

## 反模式

- ❌ 在 SKILL.md 里复述能从源码 grep 出来的事实（违反铁律）
- ❌ 直接在主窗口写内联颜色 / 硬编码 `bg-black` 等
- ❌ 跳过 `pnpm tauri add` 手动改 Cargo.toml + lib.rs
- ❌ 手写 `src/components/ui/*.tsx` 而不用 shadcn CLI
- ❌ 为了"兼容" v6 API 降级 react-router-dom
- ❌ API Key 明文存 `tauri-plugin-store`
- ❌ Rust 侧重写 Tauri 官方插件已覆盖的能力
- ❌ 改了技术栈 / 目录 / docs 不同步本技能

---

## 协作技能

- **`te-industrial-frontend`**（软链）—— TE 工业风实现指南，做 UI 时优先激活。
- **`openloaf-saas-sdk-rust`**（软链）—— 任何登录 / 用户档案 / AI 工具 / realtime ASR 实现先读它。
- 写 PRD / 提案 → `create-prd` / `create-proposal`，但 OpenSpeech 业务规则主位 `docs/`。
- Tauri / Claude API / 前端通用最佳实践 → `claude-api` / `vercel-react-best-practices` / `document-skills:frontend-design`，**本技能优先**。
