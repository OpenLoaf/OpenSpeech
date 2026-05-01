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

---

## 任务路由（先按类别加载对应 reference，再动手）

| 任务类别 | 触发词 | 先读 |
|---|---|---|
| 改 UI / 加文案 / 改样式 / 新建组件 / 新建 Dialog | i18n、文案、TE 风、样式、Logo、drag region、Dialog | `references/frontend.md` |
| 改窗口 / 托盘 / 关闭行为 / 加 invoke / 加系统权限 / 改开机自启 | 窗口、托盘、关闭、Cmd+Q、Dock、capability、autostart | `references/desktop-runtime.md` |
| 改录音 / STT / 调 SaaS realtime ASR / 改触发录音 gate | 录音、STT、ASR、PCM、SaaS、未登录 | `references/asr-recording.md` |
| 发版 / 改签名 / 测 updater / 加 NSIS 语言 | 发版、签名、updater、NSIS、entitlement | `references/release.md`（执行流程走 `openspeech-release` skill） |
| 让 Claude 自己看 / 操作运行中的 UI | 截图、看一下界面、控制 UI、读 console | `references/tauri-mcp.md` |
| 改业务规则 / 实现新功能 | 录音状态机、快捷键策略、词典、历史、隐私、订阅 | 见下方"业务规则索引" |

---

## 自更新约定

**本技能必须与项目规则保持同步。** 改动以下任一项时，同会话内一并更新本文件或对应 reference：

| 项目变更 | 更新位置 |
|---|---|
| 升降级 / 增删 **前端依赖** 或 **Rust crate / Tauri 插件** | 本文"技术栈关键约束" |
| 变更 **目录结构**（新增 src 子目录、移动文件） | 本文"目录索引" |
| 变更 **构建脚本 / 包管理器 / 工具链** | 本文"包管理与脚本" |
| **新增 / 重命名 / 删除 `docs/*.md`** | 本文"业务规则索引" |
| 出现一条新的、源码读不出的决策 / 跨文件协作 / 踩坑 | 找最贴近的 reference 加一行；若无对应 reference 再开 |

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

## 技术栈关键约束（不可随意改）

> 真相来源：`package.json` + `src-tauri/Cargo.toml`。本节只列"读不出的取舍"。

- **Tailwind v4**（不再走 PostCSS，入口 `src/App.css` 用 `@import "tailwindcss"`）
- **React Router v7**（API 与 v6 不兼容，禁止降级）
- **Rust edition 2024**
- **`rdev` = `rustdesk-org/rdev` fork，pin commit `a90dbe11`**
  - 不用 crates.io 0.5.3：上游在 macOS 子线程跑 listen 遇首个 key event 进程静默 abort（无 panic、无报错）。
  - fork 还修了 `Key::Function` 映射（macOS CGEventTap）。
  - `rdev::listen` **进程内只能调一次** —— 新订阅扩展 `src-tauri/src/hotkey/modifier_only.rs`，不要另起 listen。
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
- 视觉语言 = **TE 工业风**（详见同目录软链 `te-industrial-frontend` skill 与 `references/frontend.md`）

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
│   ├── SKILL.md                入口（本文）
│   └── references/             按任务类别拆分的细则
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
| `pnpm version patch\|minor\|major` | 唯一发版动作（详见 `references/release.md`） |

---

## 通用开发规约

- 路径别名 `@/` 已配；新建文件优先用 `@/...`。
- Rust 新模块在 `src-tauri/src/<domain>/mod.rs`；`lib.rs` 只装配。
- 任何面向用户的行为**先读 `docs/` 对应文件**，不要凭感觉实现。
- 状态管理：跨窗口持久化 → `tauri-plugin-store` 或 SQLite；单窗口 UI → Zustand；**不用 Redux / Jotai / Context 大杂烩**。

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

- ❌ 在 SKILL.md 或 reference 里复述能从源码 grep 出来的事实（违反铁律）
- ❌ 直接在主窗口写内联颜色 / 硬编码 `bg-black` 等
- ❌ 跳过 `pnpm tauri add` 手动改 Cargo.toml + lib.rs
- ❌ 手写 `src/components/ui/*.tsx` 而不用 shadcn CLI
- ❌ 为了"兼容" v6 API 降级 react-router-dom
- ❌ API Key 明文存 `tauri-plugin-store`（应走 `keyring`，详见 `references/desktop-runtime.md`）
- ❌ Rust 侧重写 Tauri 官方插件已覆盖的能力
- ❌ 改了技术栈 / 目录 / docs 不同步本技能

---

## 协作技能

- **`te-industrial-frontend`**（软链）—— TE 工业风实现指南，做 UI 时优先激活。
- **`openloaf-saas-sdk-rust`**（软链）—— 任何登录 / 用户档案 / AI 工具 / realtime ASR 实现先读它。
- **`openspeech-release`** —— 发版执行流程入口（本技能 `references/release.md` 只讲"为什么这样"）。
- 写 PRD / 提案 → `create-prd` / `create-proposal`，但 OpenSpeech 业务规则主位 `docs/`。
- Tauri / Claude API / 前端通用最佳实践 → `claude-api` / `vercel-react-best-practices` / `document-skills:frontend-design`，**本技能优先**。
