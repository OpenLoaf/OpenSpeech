---
name: openspeech-dev
description: OpenSpeech 项目（跨平台 AI 语音输入桌面应用，Tauri 2 + React 19 + Rust）的开发规约与业务规则入口。**当用户在 OpenSpeech 仓库里提出任何开发请求时都应触发**——无论是加功能、改 UI、调快捷键/录音/文本注入、装依赖、调整项目结构，还是只是想读 docs/ 下的业务规则。只要你发现自己在 `src/` / `src-tauri/` / `docs/` / `package.json` / `Cargo.toml` 等 OpenSpeech 文件里工作，即使用户没点名"OpenSpeech"，也应立即加载本技能获取项目约定、技术栈版本、目录结构、插件清单、shadcn 组件添加方式、Tauri 插件添加方式，以及业务规则文档索引。触发关键词包括：OpenSpeech、语音输入、听写、录音、快捷键、Tauri、shadcn、Rust 插件、业务规则、docs/features、docs/voice-input-flow、词典、历史记录、TypeLess、REST STT。
---

# OpenSpeech 开发技能

OpenSpeech 是一个跨 Windows / macOS / Linux 的 AI 语音输入桌面应用：按住快捷键说话 → 录音 → 走用户自配的 REST 大模型转写 → 把文字注入到当前焦点输入框。本技能是在这个仓库里做开发时的"项目手册"。

---

## ⚠️ 自更新约定（硬性条款）

**本技能必须与项目规则保持同步。** 当你（或协作的其他 Claude 实例）在本次对话中做出以下任一变更时，**同一次会话内**必须更新 `.claude/skills/openspeech-dev/SKILL.md` 的对应章节后才算任务完成：

| 项目变更 | 必须同步更新的章节 |
|---|---|
| 升级 / 降级 / 新增 / 删除 **前端依赖** | "技术栈 · 前端" 表格 |
| 升级 / 新增 / 删除 **Rust crate / Tauri 插件** | "技术栈 · Rust" 与 "Tauri 插件清单" |
| 变更 **目录结构**（新增 src 子目录、移动文件、引入 monorepo 等） | "目录结构" 树 |
| 变更 **构建脚本 / 包管理器 / 工具链** | "包管理与脚本" |
| 变更 **路径别名、TS 编译选项、Rust edition** | "开发规约" 中相关小节 |
| 变更 **capabilities / 权限配置** | "Tauri 权限配置" |
| **新增 / 重命名 / 删除 `docs/*.md`** 业务规则文件 | "业务规则入口" 索引表 |
| 重大**业务规则变化**（如新增功能模块、改变快捷键方案） | 在"业务规则入口"里加一行简述，并在对应 docs 文件中同步更新 |

不要只改代码不改本技能——下一个接手的 Claude 会拿着过期信息开工。如果你不确定是否需要更新，默认更新。

---

## 项目本质

| 维度 | 约定 |
|---|---|
| 形态 | 桌面应用（Win / macOS / Linux），非 Web、非 CLI |
| 后端 | Rust（在 `src-tauri/`）——处理系统级能力：全局快捷键、录音、文本注入、本地 SQLite |
| 前端 | React（在 `src/`）——主窗口（首页/历史/词典/设置）+ 悬浮录音条子窗口 |
| 模型 | **默认走 OpenLoaf SaaS realtime ASR**（`client.realtime().connect("realtimeASR")` WebSocket 流式）；未来保留"配置 REST 端点 BYO 供应商"的可扩展槽位，但当前 MVP 只此一路 |
| 隐私立场 | 录音**仅落盘本机**（`app_data_dir/recordings/<id>.wav`，见 [docs/privacy.md](../../../docs/privacy.md)）；历史 / 词典 / WAV 均不上传；除用户登录态下的 OpenLoaf SaaS realtime ASR 之外不向任何服务器发数据 |

---

## 技术栈（真相来源）

以下版本须与 `package.json` / `src-tauri/Cargo.toml` 完全一致；修改依赖时同步更新本表（见自更新约定）。

### 前端

| 依赖 | 版本（约定） | 用途 |
|---|---|---|
| `react` / `react-dom` | 19.x | UI 框架 |
| `typescript` | 5.8.x | 类型 |
| `vite` | 7.x | 构建 |
| `@vitejs/plugin-react` | 4.x | React 插件 |
| `tailwindcss` | **v4.x** | CSS；配置通过 `@tailwindcss/vite`，入口 `src/App.css` 的 `@import "tailwindcss";` |
| `@tailwindcss/vite` | 4.x | Tailwind v4 的 Vite 集成（不再用 PostCSS） |
| `tw-animate-css` | 1.x | shadcn 动画 |
| `shadcn` + `@base-ui/react` | base-nova 风格，neutral 基色，Geist 字体 | UI 组件库 |
| `lucide-react` | 1.x | 图标 |
| `zustand` | 5.x | 客户端状态 |
| `react-router-dom` | **7.x** | 路由（注意 v7 和 v6 API 不同） |
| `i18next` + `react-i18next` | 26.x / 17.x | 界面多语言 |
| `clsx` + `tailwind-merge` + `class-variance-authority` | shadcn 必需 | 类名组合 |
| `framer-motion` | 12.x | 页面/组件入场动画；TE 风格用 `whileInView` + `once: true` |
| `@fontsource-variable/inter` | 5.x | 正文字体（Inter Variable） |
| `@fontsource/space-mono` | 5.x | mono 字体（标题/标签/按钮/编号） |

### Rust

| 依赖 | 版本 | 说明 |
|---|---|---|
| Rust edition | **2024** | 已用，见 Cargo.toml |
| `tauri` | 2.x（启用 `tray-icon` feature） | 框架；托盘图标依赖此 feature，不可移除 |
| `tauri-build` | 2.x | 构建脚本 |
| `serde` + `serde_json` | 1.x | 序列化 |
| `rdev` | **`rustdesk-org/rdev` fork**，按 commit `a90dbe11` pin（desktop-only target） | 全局键盘监听：modifier-only 绑定（Fn / Ctrl+Win / Right Alt 按住触发，见 `src-tauri/src/hotkey/modifier_only.rs`），以及未来的 Esc 按状态订阅、PTT 松开 keystate 轮询兜底。**`rdev::listen` 只能调一次**，新的订阅需求必须扩展 modifier_only 模块而不是另起 listen。**为什么不用 crates.io 0.5.3**：上游 0.5.3 在 macOS 上有致命 bug——子线程跑 listen 遇到第一个 key event 就让进程静默 abort（无 panic，无报错，直接退出）。Handy 切 fork 的真正原因就是这个。fork 的 `Key::Function` 映射也存在（macOS 内部走 CGEventTap）。Windows / Linux 的 Fn 无硬件支持，这点切不切 fork 都一样。**新环境首次 clone** 若 `~/.cargo/git/db/` 没这个 commit，cargo 需要联网拉一次；后续 `--offline` 可用。国内网络卡时走 `path = "vendor/rdev"` 本地 clone 兜底。 |
| `cpal` | 0.17.x | 跨平台音频输入采集 |
| `hound` | 3.5.x | WAV 编码（PCM → multipart 上传） |
| `tokio` | 1.52.x（features: macros/rt-multi-thread/sync/time/signal） | 异步 runtime |
| `reqwest` | 0.13.x（`default-features = false` + `rustls, http2, json, multipart, stream`） | 调用用户 REST STT 端点；默认 native-tls 太重，走 rustls |
| `enigo` | 0.6.x | 模拟键盘输入（剪贴板粘贴的备选注入方式） |
| `keyring` | 3.6.x | 系统密钥链存储 API Key（macOS Keychain / Windows Credential Manager / Linux Secret Service） |
| `zeroize` | 1.8.x（`zeroize_derive` feature） | 内存安全：录音 PCM buffer 使用 `Zeroizing<Vec<u8>>` 确保崩溃时清零 |
| `objc` | 0.2.x（`cfg(target_os = "macos")` only） | 通过 `msg_send!` 调用 NSWindow API，用于关闭主窗口的全屏能力（`collectionBehavior` 清 `FullScreenPrimary` / 加 `FullScreenNone`） |
| `openloaf-saas` | **0.2.7**（crates.io 纯 Rust 源码 crate，版本号跟 `@openloaf-saas/sdk` Node 包对齐） | OpenLoaf SaaS 官方 Rust SDK；覆盖 auth / user / ai（v3 工具 REST）/ realtime（WebSocket ASR 语音识别流）/ payment（plans / subscribe / recharge / upgrade / order_status / refund，0.2.7 新增）。**用法见软链 skill `.claude/skills/openloaf-saas-sdk-rust/`**。历史 vendored 0.3.0（FFI + 闭源 staticlib）已于 2026-04-24 删除；API 面一致，唯一区别是纯 Rust 版不再有 `check_abi()` 调用。`payment().list_plans()` 是公开端点（`GET /api/public/plans`，无需 token），在 OpenSpeech 内被复用为"网络/SaaS 健康探针"——见 `openloaf::openloaf_health_check` 命令。|

### Tauri 插件清单

**必须通过 `pnpm tauri add <name>` 添加**，它会同时处理 Cargo 依赖、npm 绑定、capabilities/permissions 与 `src-tauri/src/lib.rs` 的注册。

已装插件：

| 插件 | 用途 |
|---|---|
| `global-shortcut` | 注册全局快捷键（听写/问 AI/翻译） |
| `sql` | SQLite，用于历史记录与词典 |
| `store` | 轻量 KV 配置存储（非机密） |
| `clipboard-manager` | 文本注入默认方式（写剪贴板 + 粘贴） |
| `autostart` | 开机自启 |
| `updater` | 应用内更新 |
| `log` | 日志（接入 `tracing` 风格） |
| `opener` | 打开外部 URL（脚手架默认带入） |

**非 Tauri 插件的 Rust 依赖已装**（见上"Rust" 表）：`rdev / cpal / hound / tokio / reqwest / enigo / keyring / zeroize / openloaf-saas`。用 `cargo add --manifest-path src-tauri/Cargo.toml <crate>` 继续添加新 crate；**不要**用 `pnpm tauri add`（那是 Tauri 插件专用）。

可能还会用到：
- `opus` —— 若需 OPUS 压缩降低 STT 上传体积
- `sqlx` —— 若需要比 `tauri-plugin-sql` 更细粒度的 SQL 控制

API Key 等机密**不走 `store` 插件**，应使用 `keyring` crate 走系统密钥链（macOS Keychain / Windows Credential Manager / Linux Secret Service）。

---

## 目录结构

```
OpenSpeech/
├── docs/                       # 业务规则（单一事实来源，见下方索引）
├── src/                        # React 前端
│   ├── components/
│   │   ├── ui/                 # shadcn 生成的组件（dialog 等，按需增加）
│   │   ├── Layout.tsx          # 应用壳：240px 侧边栏 + <Outlet /> + 顶部 drag region + 关闭拦截
│   │   ├── SettingsContent.tsx # 设置内容（两列布局），被 Dialog 与 /settings 共享
│   │   ├── SettingsDialog.tsx  # 设置弹窗（侧边栏底部入口触发）
│   │   ├── AccountDialog.tsx   # 账户弹窗（侧边栏底部入口触发）
│   │   ├── CloseToBackgroundDialog.tsx # 关闭主窗口时的"后台运行 / 退出"提示
│   │   ├── LoadingScreen.tsx   # 启动 splash（TE 风：黑底 + 黄点缀 + Space Mono + PulsarGrid 背景）
│   │   ├── PulsarGrid.tsx      # LoadingScreen 专用的 TE 风脉冲网格 canvas 背景
│   │   ├── HotkeyPreview.tsx   # 听写快捷键的视觉预览 + DOM/rdev 双源按键监听 hook（Home + Onboarding Step 1 共用）
│   │   └── LiveDictationPanel.tsx # 录音中的波形 + realtime 转写面板（Home + Onboarding Step 4 共用）
│   ├── pages/                  # 页面（每页一个目录 + index.tsx）
│   │   ├── Home/index.tsx
│   │   ├── History/index.tsx
│   │   ├── Dictionary/index.tsx
│   │   ├── Settings/index.tsx
│   │   └── Onboarding/         # 首次启动 4 步引导（StepWelcome / StepPermissions / StepLogin / StepTryIt + types.ts）；当前为纯 UI mock，业务未接
│   ├── router.tsx              # React Router v7 createBrowserRouter
│   ├── lib/utils.ts            # cn() 等工具
│   ├── assets/                 # 静态资源
│   ├── App.css                 # Tailwind v4 + shadcn 变量 + TE 双主题变量 (并存)
│   └── main.tsx                # 装配：bootPromise（stores init + syncBindings）解析完后 Root 才切到 RouterProvider；之前显示 LoadingScreen
├── src-tauri/                  # Rust 后端
│   ├── src/
│   │   ├── lib.rs              # tauri::Builder，注册所有插件 + invoke handler
│   │   └── main.rs             # 调 openspeech_lib::run()
│   ├── capabilities/           # 权限声明（desktop.json, default.json）
│   ├── Cargo.toml
│   ├── tauri.conf.json
│   └── icons/
├── .claude/skills/
│   ├── openspeech-dev/SKILL.md          # 本技能（开发规约）
│   └── te-industrial-frontend → 软链     # TE 工业风实现指南
├── components.json             # shadcn 配置
├── index.html                  # 默认 <html class="dark">（TE 风优先 Dark 主题）
├── package.json
├── tsconfig.json / tsconfig.node.json
└── vite.config.ts
```

已建立的关键子目录（按本表展开）：
- `src/stores/` —— Zustand stores：`hotkeys.ts`（快捷键） / `recording.ts`（录音状态机 + 实时 ASR 事件订阅 / `liveTranscript` / **触发 Gate**：① 未登录且未配 BYO endpoint → `useUIStore.openLogin()`；② SAAS 路径且 `navigator.onLine === false` → 同步拦截 + `useUIStore.openNoInternet()`；③ SAAS 路径下乐观启动后异步 `invoke("openloaf_health_check")`，false 且仍在 preparing/recording 时回滚 + 弹无网络对话框；任一拦截即放弃本次录音） / `settings.ts`（通用 + 个性化设置，tauri-plugin-store 持久化，schemaVersion 2） / `ui.ts`（全局 UI 调度：LoginDialog / SettingsDialog / NoInternetDialog 的 open 状态 + `openLogin()` / `openSettings(tab)` / `openNoInternet()`，内部 `invoke("show_main_window_cmd")` 兼容主窗在托盘场景） / `history.ts`、`dictionary.ts`、`playback.ts`（SQLite 支撑的列表数据 + 单实例播放）
- `src/lib/secrets.ts` —— 机密 invoke 封装（`setSecret` / `getSecret` / `deleteSecret`），对应 `src-tauri/src/secrets/`
- `src/lib/audio.ts` —— 麦克风 invoke 封装：`listInputDevices` / `startAudioLevel` / `stopAudioLevel` / `startRecordingToFile` / `stopRecordingAndSave` / `cancelRecording` / `loadRecordingBytes`；对应 `src-tauri/src/audio/`。start/stop 成对调用，Rust 侧靠 ref_count 复用 stream
- `src/lib/stt.ts` —— OpenLoaf SaaS realtime ASR invoke 封装（`startSttSession` / `finalizeSttSession` / `cancelSttSession`），对应 `src-tauri/src/stt/`；事件 `openspeech://asr-{partial,final,error,closed,credits}` 在 `recording.ts::initListeners` 里订阅
- `src/lib/db.ts` / `src/lib/ids.ts` —— SQLite 客户端单例 + `newId()`（17 位本地时间 ms + 4 位 base36 随机，字典序 == 时间序，供 history / WAV 共用同一 ID）
- `src/lib/autostart.ts` —— `syncAutostart(desired)` 封装 `@tauri-apps/plugin-autostart` 的 `enable` / `disable` / `isEnabled`：仅在期望与 OS 实际不一致时写注册项；`main.tsx` bootPromise 启动时按 `settings.launchStartup` 同步一次（OS 注册被外部清除后下次启动会自动补回），设置页 Switch 改动时立即同步。失败只记日志，不阻断启动 / 设置切换
- `src-tauri/src/hotkey/` —— 全局快捷键编排（combo / modifierOnly / doubleTap 三种）。**macOS 首启权限策略**：`modifier_only::init` 在 spawn `rdev::listen` 线程之前先调 `permissions::input_monitoring_granted()`（走 `IOHIDCheckAccess`，静默不弹框）；未授权则**跳过 listen**，返回空 state，本会话内 modifier-only 绑定不工作。Onboarding StepPermissions 通过 `IOHIDRequestAccess` 引导用户授权 + `relaunch_app` 重启进程后，下次启动检测到 granted 才正式启动。**目的**：避免首启时 listen 自动触发的「Keystroke Receiving」系统弹框被随后 show 的主窗口遮挡。新增其他需要"首启即触发系统弹框"的能力（如 enigo / cpal）请遵循同模式。
- `src-tauri/src/permissions/` —— macOS 系统权限检测 / 请求 / 跳转设置（`permission_check_*` / `permission_request_*` / `permission_open_settings` / `permission_reset_tcc`）。检测走真系统 API：麦克风 = `AVCaptureDevice authorizationStatusForMediaType:`；辅助功能 = `AXIsProcessTrustedWithOptions`；输入监控 = `IOHIDCheckAccess`。`request_*` 用对应平台的"请求版"API（`IOHIDRequestAccess` / `AXIsProcessTrustedWithOptions(prompt=YES)` / cpal 临时 stream）——**这是把 App 写入系统设置隐私列表的唯一方式**，否则用户打开系统设置看不到 OpenSpeech 这条可勾选项。`permission_reset_tcc` 走 `tccutil reset` 清旧条目（dev / ad-hoc 重签名漂移恢复路径）。Windows / Linux 一律返回 `granted`（cpal/rdev 直接尝试）。前端封装在 `src/lib/permissions.ts`。**还暴露内部用 `pub fn input_monitoring_granted() -> bool`**（非 invoke），供 `hotkey::modifier_only::init` 在 setup 阶段静默判断是否启动 rdev::listen。
- `src-tauri/src/secrets/` —— 系统密钥链命令
- `src-tauri/src/audio/` —— cpal 采集：电平监控（`audio_level_*` + `openspeech://audio-level` 20Hz）**和**录音会话（`audio_recording_{start,stop,cancel,load}`，归一化 f32 → hound 编码 16-bit WAV 落 `recordings/<id>.wav`）。回调还把 PCM16 mono downmix 后喂 `stt::try_send_audio_pcm16`。`pub fn current_stream_info()` 暴露 sample_rate/channels 给 stt 模块。
- `src-tauri/src/stt/` —— OpenLoaf SaaS realtime ASR orchestrator（session 独占线程 + mpsc 控制通道 + Tauri emit 事件转发）；命令 `stt_start` / `stt_finalize` / `stt_cancel`；**见 cookbook "对接 realtime ASR" + 软链 skill `openloaf-saas-sdk-rust`**
- `src-tauri/src/openloaf/` —— OpenLoaf SaaS 登录 / token refresh / 用户档案 / 支付订单；`authenticated_client()` 对下游（如 stt）暴露已登录 `SaaSClient`
- `src-tauri/src/db/` —— SQLite 迁移（`history` / `dictionary` 表）+ `recordings_dir()` / `ensure_recordings_dir()` 帮手
- `src-tauri/src/inject/` —— 文本注入：当前实现为剪贴板写入 + 系统粘贴快捷键模拟（命令 `inject_paste`），由 `recording.ts` 在 final 文本到位后调用，把转写结果送回当前焦点输入框；enigo 直敲路径暂未启用
- `src/pages/Onboarding/` —— 首次启动 4 步引导：Welcome（复用 `HotkeyPreview`）→ Permissions（按 `detectPlatform()` 平台分支 cards：mac 显示 Mic/Accessibility/Input Monitoring；Win 显示 Mic + UAC 警告；Linux 显示设备选择 + 注入工具检测）→ Login（强制 OpenLoaf SaaS，新户送 200 积分；底部折叠"自定义 STT 端点"高级口子）→ Try It（用本地状态机 + 假波形 + 假 partial 序列演示完整流程，复用 `LiveDictationPanel`）。**当前所有"授权 / 登录 / 录音"按钮都是 UI mock，不调 Rust 业务**——这样测试 UI 时不需反复清系统权限。完成后 `navigate("/", { replace: true })`。`main.tsx` 通过 `FORCE_ONBOARDING_ON_BOOT` 常量在 boot 完成后强制 `router.navigate("/onboarding")`，**测试期开关；接业务后改成读 `settings.onboardingCompleted`**。详见 `docs/onboarding.md`

规划中但尚未建立（在开发对应功能时再建，并同步本表）：
- `src/lib/tauri.ts` —— invoke 的统一封装（暂各功能自管自的 lib/\*.ts）
- `src/locales/` —— i18n 文案（当前硬编码中文）

---

## 包管理与脚本

- 包管理器：**pnpm**（`corepack` 已生效，版本 10+）。不要换成 npm/yarn/bun。
- 常用脚本：
  | 命令 | 作用 |
  |---|---|
  | `pnpm dev` | Vite 前端 dev server（独立，调试 UI 时用） |
  | `pnpm build` | `tsc && vite build`，验证前端能过类型检查 |
  | `pnpm tauri dev` | **桌面开发主命令**：启动 Vite + 编译 Rust + 打开窗口 |
  | `pnpm tauri build` | 打包安装包 |
  | `pnpm tauri add <plugin>` | 添加 Tauri 官方插件（见上文清单） |
  | `pnpm dlx shadcn@latest add <component>` | 添加 shadcn 组件（如 `button dialog input`） |

---

## 开发规约

### 通用原则
- **任何可被脚手架生成的东西都用脚手架**：初始化项目、加 Tauri 插件、加 shadcn 组件、初始化 rust crate 都走官方 CLI，禁止手写同等内容。
- 路径别名 `@/` 已配好（`tsconfig.json` paths + `vite.config.ts` resolve.alias），新建文件时优先用 `@/...` 引用。
- 前端所有新组件优先复用 `src/components/ui/` 下的 shadcn 基础件；缺什么就用 CLI 加。
- Rust 新模块在 `src-tauri/src/<domain>/mod.rs` 下组织，`lib.rs` 只做装配。
- 任何面向用户的行为先读 `docs/` 里对应的业务规则（见下方索引），**不要凭感觉实现**。

### 添加 shadcn 组件（规范动作）
```bash
pnpm dlx shadcn@latest add button dialog input select
# 生成到 src/components/ui/，按需 import
```

### 添加 Tauri 插件（规范动作）
```bash
pnpm tauri add <name>   # 会同时改 Cargo、package.json、capabilities、lib.rs
```
添加后**务必在本技能"Tauri 插件清单"表里补一行**（自更新约定）。

### 添加 Rust 非 Tauri 依赖（cpal / enigo / reqwest / 等）
```bash
cargo add --manifest-path src-tauri/Cargo.toml <crate>
# 若是桌面独有，加 --target 限定
```
添加后同步本技能的"Rust"表与"Tauri 插件清单"下方的备选清单。

### Tauri 权限配置
- `src-tauri/capabilities/default.json` —— 跨所有平台生效的基础权限
- `src-tauri/capabilities/desktop.json` —— 仅桌面三端（`macOS / windows / linux`）
- 添加新 invoke 命令或插件权限时，在对应 capabilities 里显式声明；避免用全量通配 `allow-*`。
- **已显式启用的关键权限**：
  - `core:window:allow-start-dragging` —— `data-tauri-drag-region` 能工作的前提（`core:default` 不含此项）。若拖拽失效先检查这里。
  - `clipboard-manager:allow-write-text` —— `inject_paste` 命令把转写文本写回剪贴板的前提（`clipboard-manager:default` 只放 readText，不含 writeText）。若粘贴注入失效先检查这里。

### 前端路由
- 使用 **React Router v7**（不是 v6）；API 差异点：`createBrowserRouter` / `RouterProvider`；`loader` / `action` 等数据 API 可选用。

### 本地化
- **当前阶段：直接硬编码中文**，暂不接入 i18next（已装依赖，但未启用）。
- 未来启用 i18next 时**一次性**把所有中文字符串提取到 `src/locales/zh.json` / `en.json`；在此之前保持硬编码简洁。
- **保留不翻的英文**（全局约定）：品牌词 `OpenSpeech` / `OPEN` / `SPEECH`；按键名 `Fn / Left Ctrl / Space / Left Shift / Esc / A`；缩写 `WPM / STT / API / REST / URL / WAV / OPUS / MIT`；语言代码 `EN-US / ZH-CN` 等；专有名词 `Tauri / React / Whisper / SQLite / cpal / enigo` 等；TE 装饰性 mono 小标签的英文节奏（`// LIVE METRICS` 等）可酌情保留。
- 默认语言跟随系统；设置里预留切换入口，详见 `docs/settings.md`。

### 状态管理
- 跨窗口共享的持久化状态：用 `tauri-plugin-store` 或 SQLite。
- 单窗口的 UI 状态：用 Zustand。
- **不用 Redux / Jotai / Context 大杂烩**。

### 样式 —— 当前视觉语言是 **TE 工业风（Teenage Engineering）**
- **默认主题为 Dark**：`index.html` 已设 `<html class="dark">`；主题切换只需 toggle 这个 class。
- **页面与组件只使用 `te-*` 语义 token**：`bg-te-bg` / `text-te-fg` / `text-te-accent` / `bg-te-surface` / `bg-te-surface-hover` / `border-te-gray` / `text-te-light-gray` / `text-te-accent-fg`。所有 `te-*` token 在 `src/App.css` 的 `@theme inline` 中映射，随 `:root` / `.dark` 自动双主题切换。
- **禁止硬编码** `bg-black` / `text-white` / `bg-white` / `text-black`。
- **字体**：`font-mono`（Space Mono）用于标题 / 标签 / 编号 / 按钮；`font-sans`（Inter Variable）用于正文。
- **shadcn 的 `bg-background` 等 token 与 `te-*` 并存**，但 **TE 页面里不要混用**——`te-*` 为准。shadcn token 保留用于未来可能的非 TE 场景或第三方组件。
- **Logo 规则**：`OPEN` 用 `text-te-fg`（白），`SPEECH` 用 `text-te-accent`（accent 色），两段紧贴同容器内。不要改动，品牌一致性。
- **shadcn Dialog 在 TE 风格下的覆盖**：强制方角（`rounded-none`）、加 `border border-te-gray`、背景 `bg-te-bg`、取消默认 `gap`（`!gap-0`），这是 `SettingsDialog` / `AccountDialog` 的既定写法，新增 Dialog 沿用。
- **不要**使用渐变填充、glow、重阴影、圆角 > `rounded-sm`、pill shape、emoji 装饰。TE 的细节规则与组件模板见 `.claude/skills/te-industrial-frontend/`（已软链到本仓库的 `.claude/skills/`），做 UI 时优先激活该技能。
- 动画：`framer-motion` 的 `whileInView` + `viewport={{ once: true }}`，时长 0.4–0.6s，禁用 spring bounce。
- **滚动行为**：`App.css` 已对 `html / body / #root` 设 `overscroll-behavior: none` + `height: 100%`，彻底禁用 Safari/Chrome 触控板滑到底后的"回弹"。新建全屏容器遵守此规范，若需要局部可回弹再在元素上显式 `overscroll-auto`。

### 窗口与标题栏（macOS Overlay + 全平台 drag）
- `src-tauri/tauri.conf.json` 已设 `titleBarStyle: "Overlay"` + `hiddenTitle: true`。**macOS 红绿灯嵌入应用内容区左上角**，无原生标题栏。
- **主窗口尺寸区间**：`minWidth: 1000` / `minHeight: 680`（侧边栏 240px，主内容至少 760px；配 Home Hero / History sticky header 的最小可用高度）；`maxWidth: 1600` / `maxHeight: 1100`（大屏上防止内容被拉过宽，绿色按钮 zoom 也会被这个上限 clamp）。尺寸均为 logical px。
- **全屏已被全局禁用**：`tauri.conf.json` 初始 `fullscreen: false`，macOS 端在 `lib.rs` 的 `disable_macos_fullscreen` 里把主窗口的 `NSWindow.collectionBehavior` 清 `FullScreenPrimary (1<<7)` / 加 `FullScreenNone (1<<9)`——绿色按钮降级为 zoom，双击标题栏不会进全屏，菜单里"进入全屏"项也被 AppKit 自动隐藏。**不要**再加 `View → Enter Full Screen` 菜单项或在任何地方调用 `window.set_fullscreen(true)`，会被 collectionBehavior 反制但产生视觉抖动。Windows/Linux 端由于缺少统一拦截点暂不强制，用户 F11 仍可能触发，评估必要性再补。
- **drag region 分布**：
  - **侧边栏顶部** `h-8 shrink-0 data-tauri-drag-region`（240×32）—— 红绿灯嵌入，logo 在其下方避让。
  - **主内容区 Layout 层不挂 drag 条**（避免压住 Hero 顶端 / 与 page sticky header 叠 z-index）。由每个 page 自己声明 drag 区：
    - **有 sticky header 的 page（Dictionary / History）**：给 sticky header 的外层 `<div>` 加 `data-tauri-drag-region`（可连带内部 `<div>` 一起加，冗余但稳妥），内部的 `<button>` / 搜索框等交互元素加 `data-tauri-drag-region="false"` 豁免。
    - **无 sticky header 的 page（Home）**：在 `<section>` 内顶部挂一条 `sticky top-0 h-8 data-tauri-drag-region` 的透明条；用 `-mx-[4vw] -mt-[...]` 抵消 section 的 padding，让它撑满整个可视宽度。
- **为什么不用 absolute overlay**：drag 元素必须是 `overflow-y-auto` scroll 容器的 **后代**，wheel 事件才能正常冒泡到 scroll 容器；absolute 覆盖在 scroll 容器外会吃掉顶部 32px 区域的滚轮。上面两种"page 内部"方案都满足这个约束。
- **新建 page 时择一套用**，忘了就只有 sidebar 那一小块能拖。
- Logo 不在 drag region 上（在 drag 区下方），避免拖动时误触。
- Windows / Linux 下 `titleBarStyle` 会被忽略，按系统默认装饰渲染；drag region 对三端都有效。
- **新建独立窗口**（悬浮录音条等）如果也用 Overlay / 无边框，在窗口顶部单独暴露一段 `data-tauri-drag-region`。
- **例外：透明非交互浮窗（悬浮录音条）豁免 drag region**。悬浮录音条采用 `focus: false` + `decorations: false` + `transparent: true` + `alwaysOnTop: true` + `skipTaskbar: true` 的属性组合，用户不会也不应该拖动它（MVP 定位固定屏幕底部中央），因此**不需要** `data-tauri-drag-region`；反而 drag 交互会让用户误以为可以点它，抢走焦点。这条例外仅限"完全透传、不可拖拽"的浮窗；普通带边框子窗口仍遵守 drag region 规则。
- **macOS 跨 Space / 全屏覆盖**：悬浮录音条在 macOS 全屏应用 Space 下也要可见，需额外调用 `WebviewWindowBuilder::visible_on_all_workspaces(true)`（Tauri 2.1+ 可用）。若目标 Tauri 版本更低，通过 `objc2` 手动设置 `NSWindow.collectionBehavior |= NSWindowCollectionBehavior.canJoinAllSpaces | .fullScreenAuxiliary`。任一失败则 MVP 接受"全屏态下悬浮条不可见、仅靠声音提示兜底"，这是已知平台限制。
- **悬浮条尺寸单位**：`280 × 56` 均为 **CSS/logical px**，通过 `WebviewWindowBuilder::inner_size(LogicalSize::new(280.0, 56.0))` 传入；高 DPI 屏幕下由系统缩放，不要自行乘 devicePixelRatio。

### 窗口生命周期与系统托盘
- **统一关闭流程**：Rust 端是唯一拦截入口，前端只做 UI。Rust 在拦到关闭请求后 `emit("openspeech://close-requested")`；前端 `Layout.tsx` 用 `listen()` 订阅该事件，读 `useSettingsStore.getState().general.closeBehavior`（枚举 `"ASK" / "HIDE" / "QUIT"`，持久化到 `settings.json`）决定：直接 `invoke("hide_to_tray")` / 直接 `invoke("exit_app")` / 弹 `CloseToBackgroundDialog` 让用户选。对话框里勾"不再提醒 + 继续后台" → 同步 `setGeneral("closeBehavior", "HIDE")`；勾"不再提醒 + 退出" → `"QUIT"`。设置页"关闭时最小化到托盘"开关正是 `closeBehavior === "HIDE"` 的双向映射（off 时回到 `ASK`）。历史遗留的 `localStorage["openspeech:close-behavior"]` 已弃用。**不要**在前端用 `getCurrentWindow().onCloseRequested()`——JS 回调有时序风险且被 StrictMode 放大。
- **listen 订阅的 StrictMode 防御**：`useEffect` 里 `await listen(...)` 返回前组件可能已经卸载重挂，必须用 `cancelled` flag + `unsub()` 兜底，否则 dev 下 emit 一次会触发两次回调。参考 `Layout.tsx` 里的 pattern。
- **Cmd+Q 必须由自建 App Menu 接管（macOS 特有陷阱）**：Tauri 2 在 macOS 下若没显式 `app.set_menu`，Cmd+Q 走 NSApp 的 `terminate:`，实测会**绕过** `WindowEvent::CloseRequested` 与 `RunEvent::ExitRequested` 直接 `exit()`，Rust 和前端都拦不住。修复方式：`#[cfg(target_os="macos")]` 里建一个含 `MenuItemBuilder::with_id("quit_app").accelerator("CmdOrCtrl+Q")` 的 App Menu，让 accelerator 被菜单系统吃掉，`app.on_menu_event` 收到 `quit_app` 后统一 `emit` close-requested。见 `lib.rs` `setup` 里的 macOS cfg 块。Edit / Window 子菜单同步补全，保证 Cmd+C/V/X/A/Z / Cmd+W / Cmd+M 正常。
- **红叉 / Cmd+W 拦截**：主窗口 `on_window_event` 里拦 `WindowEvent::CloseRequested` → `api.prevent_close()` + emit close-requested。同步调用、无时序风险。
- **ExitRequested 作为兜底**：`.run(|app, event| …)` 里仍保留 `code.is_none()` 分支 `api.prevent_exit()` + emit，用于极端情况（例如三方插件触发 app 级退出）。
- **macOS Dock 图标切换（ActivationPolicy）**：仅 `window.hide()` 无法把 Dock 图标一起隐藏；必须同时切 `ActivationPolicy`。`hide_main_window()` 在 hide 后切 `Accessory`，`show_main_window()` 在 show 前切回 `Regular`。这两个行为封装在 Rust 命令里，前端**不要直接调用 `window.hide()` / `window.show()`**，一律通过 `invoke("hide_to_tray")` / `invoke("show_main_window_cmd")`。
- **系统托盘**：`lib.rs` `setup` 中用 `TrayIconBuilder` 创建；左键点击托盘图标唤起主窗口（走 `show_main_window` 自动切 ActivationPolicy）。托盘依赖 `tauri` 的 `tray-icon` feature（已在 Cargo.toml 启用）。托盘菜单的"退出"**直接** `app.exit(0)`，不走 close-requested（用户明确选了退出，不再问）。
- **托盘右键菜单结构**（由 `build_tray_menu` 每次重建动态生成，见 `lib.rs`）：反馈意见 / 打开 OpenSpeech 主页 / 设置... (`⌘,`) / 选择麦克风 ▸（`CheckMenuItem` 列出 `audio_list_input_devices` 的所有设备 + Auto-detect，✓ 标记当前 `settings.general.inputDevice`） / 将词汇添加到词典 / 版本 x.y.z（`enabled(false)`，从 `app.package_info().version` 读） / 检查更新 / 退出 OpenSpeech (`⌘Q`)。菜单项 id 统一加 `tray::` 前缀；麦克风子菜单是 `tray::mic::<device-name>` + `tray::mic::__auto__`。
- **托盘菜单事件协议**（Layout.tsx 订阅）：`openspeech://tray-open-home` → `navigate("/")`；`openspeech://tray-open-settings` → `setSettingsOpen(true)`；`openspeech://tray-open-dictionary` → `navigate("/dictionary")`；`openspeech://tray-select-mic`（payload: `string | null`，null = Auto-detect）→ `setGeneral("inputDevice", device ?? "") + invoke("tray_refresh")`；`openspeech://tray-check-update` → 调 `@tauri-apps/plugin-updater` 的 `check()` 并用 sonner toast 反馈。"反馈意见"与"退出"由 Rust 直接处理（`opener.open_url(FEEDBACK_URL)` / `app.exit(0)`），不 emit 事件。
- **托盘菜单刷新**：Rust `tray_refresh` invoke 重建整个菜单（重读 `tauri-plugin-store` 的 `settings.json` 拿 `inputDevice` + 重新枚举 cpal 设备列表）。前端 `Layout.tsx` 用 `useSettingsStore.subscribe` 监听 `general.inputDevice` 变化时自动触发一次；Rust 侧从菜单点击 `tray::mic::*` 时只 emit 事件让前端写 store，写回后 subscribe 回调负责刷。这样"设置页切 mic → 托盘 ✓ 跟手"与"托盘切 mic → 设置页 ✓ 跟手"双向对齐。
- **Rust 暴露的命令**：`exit_app` / `hide_to_tray` / `show_main_window_cmd` / `tray_refresh` / `sync_dock_icon` / `open_network_settings` —— 前端关闭流程、托盘刷新、Dock 图标切换、网络设置跳转通过 `invoke` 调用它们；新增其他生命周期命令时在此节补一行。`sync_dock_icon` 仅 macOS 有效：重读 `settings.json` 的 `showDockIcon`，立即 `set_activation_policy(Regular | Accessory)`；`show_main_window` 也通过 `apply_dock_icon_policy` 每次读一次（因为 `hide_main_window` 始终切 Accessory，需要 show 时再 apply 用户偏好）；setup 启动时调 `apply_dock_icon_policy` 一次，让上次关过 Dock 图标的状态启动即生效，避免闪烁。`open_network_settings` 三端各自打开系统网络设置（macOS `x-apple.systempreferences:com.apple.Network-Settings.extension` deeplink / Windows `ms-settings:network-status` / Linux `gnome-control-center network` 回退 `kcmshell5 kcm_networkmanagement`）；**不走 `tauri-plugin-opener`**，因为后者默认 scope 不允许 `x-apple.systempreferences:` / `ms-settings:` 这种自定义 scheme，自己 spawn 命令更省事。
- **Capability 权限**：`core:default` **不含**窗口控制操作；如果前端需要 `window.hide/show/setFocus/unminimize` 等 IPC，必须在 `capabilities/default.json` 显式声明 `core:window:allow-hide` / `-show` / `-set-focus` / `-unminimize`。目前我们通过 Rust 命令包装这些动作，权限可保留（留着防误用）。
- **WebView 右键菜单**：`main.tsx` 在启动时 `window.addEventListener("contextmenu", e => e.preventDefault())` 全局禁用 WebView 默认右键菜单（后退/刷新）。若未来个别输入框需要原生上下文菜单，在该元素上 `stopPropagation`。

### 应用全局入口：Dialog 优先
- **"设置" 与 "账户"** 采用 **Dialog 模式**，由 `Layout` 的侧边栏底部两个小图标按钮触发（`UserCircle` / `Settings`）。
- `SettingsContent` 是共享组件，`/settings` 路由与 `SettingsDialog` 都通过 `<SettingsContent />` 渲染，**修改设置内容只需动 `SettingsContent.tsx`**，两处自动同步。
- 如果未来把"账户"内容做大（例如需要子路由），再评估是否拆回独立页面。

### 提交与测试
- 目前未接入测试框架。加入时同步更新本节与"技术栈"表。
- CI 仅有 `.github/workflows/release.yml`（tag `v*` 触发发版），见下一节。

### 版本号 SSoT 与发版流程
- **版本号单一事实来源 = `package.json.version`**。不要手改 `src-tauri/Cargo.toml` 或 `src-tauri/tauri.conf.json` 的 version：
  - `tauri.conf.json.version` 已设为 `"../package.json"`，Tauri build 时自动 resolve。
  - `Cargo.toml` 通过 `scripts/sync-version.mjs` 在 `pnpm version <bump>` 的 lifecycle hook 里同步（`package.json` 的 `"version"` script 已配）。
- **发版动作** = `pnpm version patch|minor|major` → 自动改 `package.json` + `Cargo.toml`、commit、打 tag `v<x.y.z>` → `git push && git push --tags`。tag `v*` 被 `.github/workflows/release.yml` 捕获，按 6 个 target 矩阵并行构建：macOS ARM64 (`macos-latest`)、macOS Intel (`macos-13`)、Linux x86_64 (`ubuntu-22.04`)、Linux ARM64 (`ubuntu-22.04-arm`)、Windows x86_64 (`windows-latest`)、Windows ARM64 (`windows-11-arm`)——全部 native 构建，不 cross-compile。`tauri-apps/tauri-action@v0` 产出每 target 的 installer + `.sig` + 按 platform-arch 合并到同一个 draft Release 的 `latest.json`。手动在 GitHub UI 点 "Publish release" 后，客户端 updater 才能看到新版本。
- **ARM runner 可用性**：`ubuntu-22.04-arm` / `windows-11-arm` 是 GitHub 官方 ARM runner，2025 年陆续 GA。若某个 job 因 runner 未启用 / 配额不足跑不起来，可以临时降级为 cross-compile：把 `platform` 换回对应 x86_64 host，`args` 里追加 `--target <arm target>`，并在 `dtolnay/rust-toolchain` 的 `targets` 里装上。
- **本地裸 build 不走 updater 签名**：`tauri.conf.json` 的 `bundle.createUpdaterArtifacts` 默认 `false`，让任何人 clone 后 `pnpm tauri build` 都不会因 updater 私钥缺失而失败。CI 在 `release.yml` 的 build 命令里通过 `--config '{"bundle":{"createUpdaterArtifacts":true}}'` 临时打开，CI 的 `TAURI_SIGNING_PRIVATE_KEY` 已注入。本地若要测 updater 包，同样手动 `pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":true}}'`，且 `src-tauri/.env` 里要配 `TAURI_SIGNING_PRIVATE_KEY` / `_PASSWORD`。
- **首次启用 updater 前必做的一次性配置**（CI 发版前必须做完，否则 release.yml 的 build 步骤会失败；客户端 `check()` 会抛 pubkey 为空的错）：
  1. `pnpm tauri signer generate -w ~/.tauri/openspeech.key`（或不 `-w` 就默认 `~/.tauri/tauri.key`），设一个密码。
  2. 把生成的 **public key** 内容粘到 `src-tauri/tauri.conf.json → plugins.updater.pubkey`。
  3. GitHub 仓库 Secrets 里加两条：`TAURI_SIGNING_PRIVATE_KEY`（整个 key 文件内容）+ `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`（生成时输入的密码，无则空串）。
  4. **私钥** `*.key` 文件已被根 `.gitignore` 兜底排除，千万不要 commit。
- **更新端点**：`plugins.updater.endpoints` 指向 `https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json`，跟随每次 published Release 自动切换。换 CDN / 自建只需改这一处。
- **客户端自动更新**（`src/main.tsx` bootPromise）：默认 `settings.autoUpdate = true`；启动时 `check()` 带 5s 超时，发现新版本直接 `downloadAndInstall()`——macOS/Linux 原地替换 + relaunch，Windows 调起 NSIS installer。失败静默，不打扰启动。用户在"设置 → 行为 → 自动更新"里可以关，关闭后只能通过托盘"检查更新"手动触发（走 sonner toast 回显结果）。**Dev 模式（`import.meta.env.DEV`）一律跳过 `check()`**——pubkey 尚未配置 + `latest.json` 未发布时 Rust 侧 `tauri_plugin_updater` 会打 ERROR 污染 dev 日志；托盘"检查更新"仍可手动触发（用户主动点，接受报错结果）。
- **macOS 代码签名 + 公证（已接线，待填 GitHub Secrets 生效）**：`release.yml` 的 `tauri-action` step env 已注入签名所需的 6 个变量；**GitHub Secrets 命名跟 OpenLoaf 仓库 `publish-desktop.yml` 对齐**，便于同一个 Apple Developer 账户跨项目复用一套密钥管理——
  - `MAC_CER_BASE64` / `MAC_CER_PASSWORD` —— `Developer ID Application` 证书 `.p12` 的 base64 + 导出密码；CI 映射成 Tauri 认的 `APPLE_CERTIFICATE` / `APPLE_CERTIFICATE_PASSWORD`（注：OpenLoaf 用 electron-builder 认的是 `CSC_LINK` / `CSC_KEY_PASSWORD`，同源 Secret 在各项目 CI 里按需映射即可）
  - `APPLE_SIGNING_IDENTITY` —— 形如 `Developer ID Application: 你的名字 (TEAMID)`；直接透传给 Tauri
  - `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID` —— 前两者透传，app-specific password 在 CI 里映射到 Tauri 认的 `APPLE_PASSWORD`
  - 所有 Secrets 为空时 tauri-action 自动跳过签名，回退到未签名包（现状等价）；填齐后自动完成 codesign + notarize + staple。
- **Hardened Runtime entitlements**（`src-tauri/entitlements.plist`，通过 `tauri.conf.json → bundle.macOS.entitlements` 启用）：开放 `network.client`（REST STT）/ `device.audio-input`（cpal）/ `automation.apple-events`（enigo 模拟键盘）/ `cs.allow-jit` + `allow-unsigned-executable-memory` + `disable-library-validation`（WKWebView / rdev fork / 动态加载兜底）。
- **本地签名/公证**走 `src-tauri/.env`（已 gitignore），参考 `src-tauri/.env.example`；变量名跟 OpenLoaf 对齐（`APPLE_APP_SPECIFIC_PASSWORD` 等），同时多 export 一份 `APPLE_PASSWORD` 给 Tauri CLI 本地识别（两个名字同值）。`package.json` 的 `tauri` 脚本已改成 `set -a; [ -f src-tauri/.env ] && . src-tauri/.env; set +a; tauri`，**.env 存在自动加载、不存在跳过**，所以本地直接 `pnpm tauri build` 即可，不需要手动 source。`TAURI_SIGNING_PRIVATE_KEY` 在 .env 里写**绝对路径**，不要用 `~/...`（双引号里 shell 不展开 tilde，会被 Tauri 当 base64 字面量去 decode 然后 panic on symbol 126 = `~`）。证书每年到期需重新在 Apple Developer 后台生成并重新导出 `.p12` 更新 `MAC_CER_BASE64`。
- **Windows 代码签名**尚未做；首次打开会被 SmartScreen 拦截（"更多信息 → 仍要运行"）。商业化节奏到了再加 EV code signing（OV 证书需要积累信誉，EV 立即绿灯）。

---

## 业务规则入口（docs/）

**代码实现前先读对应 docs 文件。** 这是 OpenSpeech 的 single source of truth；本技能不重复其中内容。

| 任务 | 先读 |
|---|---|
| 聊产品定位 / 和 TypeLess 对比 | [docs/product.md](../../../docs/product.md) |
| 实现或讨论任一功能 | [docs/features.md](../../../docs/features.md) |
| **录音、快捷键触发、转写、文本注入** 的状态机与边界 | [docs/voice-input-flow.md](../../../docs/voice-input-flow.md) |
| 设计或改动快捷键 | [docs/hotkeys.md](../../../docs/hotkeys.md) — 三种 `BindingKind`（`combo` / `modifierOnly` / `doubleTap`）；平台默认 PTT：macOS=`Fn` / Windows=`Ctrl + Win` / Linux=`Ctrl + Super`；schemaVersion=2 |
| 历史记录页 / SQLite schema | [docs/history.md](../../../docs/history.md) |
| 词典页 / 自定义词汇 / hints | [docs/dictionary.md](../../../docs/dictionary.md) |
| 设置页任何一项 | [docs/settings.md](../../../docs/settings.md) |
| 数据流 / 本地存储 / 不上传什么 | [docs/privacy.md](../../../docs/privacy.md) |
| 麦克风 / 辅助功能 / Wayland 等平台权限 | [docs/permissions.md](../../../docs/permissions.md) |
| 首次启动向导（4 步）+ 持久横条 | [docs/onboarding.md](../../../docs/onboarding.md) |
| 计费 / 试用 / 账户（MVP 暂缓） | [docs/subscription.md](../../../docs/subscription.md) |

新增或重命名 `docs/*.md` 时，回来更新此索引（自更新约定）。

---

## 常见任务 cookbook

### "给我加一个『设置 → 音频』子项 / 新控件"
1. 读 [docs/settings.md](../../../docs/settings.md) 的"音频"小节。
2. 直接改 `src/components/SettingsContent.tsx`（Dialog 与 /settings 共享此组件）；**不要**再用 `useState` 占位——走 `useSettingsStore`。
3. 需要新的 shadcn 基础件时：`pnpm dlx shadcn@latest add <name>`。
4. **状态持久化约定（已接入）**：
   - 非机密配置（语言/音频/端点/行为/个性化）→ `useSettingsStore`（`src/stores/settings.ts`），onChange 调 `setGeneral("key", v)` / `setPersonalization("key", v)`，自动写 `settings.json` via `tauri-plugin-store`。**所有编辑实时生效，无保存按钮**（docs/settings.md 第 89 条）。
   - API Key 等机密 → 走 keyring，`setSecret(SECRET_STT_API_KEY, v)` / `getSecret(...)`；**禁止**放进 `useSettingsStore` 或 `tauri-plugin-store`。当前实现：`apiKey` 在组件内保持本地 state，`TextInput` 的 `onBlur` 触发 `flushApiKey()` 写入 keyring。
   - 新增非机密字段：在 `GeneralSettings` / `PersonalizationSettings` 类型 + `DEFAULT_*` + JSX 的 `setGeneral("xxx", v)` 三处加。
   - 新增机密字段：在 `src/lib/secrets.ts` 加常量 `SECRET_XXX`；存取用同一对 API。
5. 文案暂不走 i18next，直接中文硬编码；未来整体上 i18n 时统一迁移。

### "实现录音最小闭环"
1. 读 [docs/voice-input-flow.md](../../../docs/voice-input-flow.md)。
2. `cargo add --manifest-path src-tauri/Cargo.toml cpal hound`。
3. 在 `src-tauri/src/audio/mod.rs` 实现 `start_recording()` / `stop_recording() -> Vec<u8>`（WAV）。
4. 用 `#[tauri::command]` 暴露给前端。
5. 在 `default.json` 或 `desktop.json` 里声明对应 `allow` 权限。
6. 完成后更新本技能的"Rust"表和"目录结构"。

### "加全局快捷键"
1. 读 [docs/hotkeys.md](../../../docs/hotkeys.md)。**三种 `BindingKind`**：`combo`（修饰 + 主键）/ `modifierOnly`（1-N 修饰键按住，听写默认形态）/ `doubleTap`（双击单修饰键）。
2. **三层后端分工**（见 docs/hotkeys.md "平台限制"）：
   - **L1 `tauri-plugin-global-shortcut`** —— 处理 `combo`，三端最稳。Ask AI / Translate 走这层。
   - **L2 `rdev`**（需切到 `rustdesk-org/rdev` fork 才能识别 `Modifiers::FN`）—— 处理 `modifierOnly` / `doubleTap`，以及 Esc 订阅和 PTT 松开 keystate 轮询兜底。
   - **L3 `objc2-core-graphics` CGEventTap**（仅 macOS）—— 订阅 `FlagsChanged`，维护 `fn_is_down` 状态修正 `NSEvent.ModifierFlags.function` bit 的歧义（keyCode 63 专属更新）；作为 L2 Fn 检测的冗余兜底。
3. 快捷键配置走 `tauri-plugin-store`（`hotkeys.json`），**schemaVersion = 2**；`src/lib/hotkey.ts` 的 `normalizeBinding` 会把 v1 老数据自动补齐 `kind` 字段（`code === "" → modifierOnly`，否则 → `combo`）。
4. 默认值按平台动态（`getDefaultBindings(platform)`）：
   - macOS PTT = `Fn`（modifier-only）
   - Windows PTT = `Ctrl + Win`（modifier-only，对齐 Wispr Flow）
   - Linux PTT = `Ctrl + Super`
   - Ask AI / Translate 三端一致：`Ctrl + Shift + A` / `Ctrl + Shift + T`
5. **Esc 取消和 PTT 松开轮询**通过 `rdev` 订阅（非 register 快捷键）实现——仅 Recording / Transcribing 状态下响应 Esc，否则彻底不拦；Recording 中每 200ms 轮询修饰键 keystate 兜底"Released 事件丢失"。
6. 冲突检测规则与录入 UX 以 `docs/hotkeys.md` 为准。录入 UI 用 `event.code` 而非 `event.key`（避免 macOS Option+字母的 dead key）。
7. **Fn 键的现实**：Windows 硬件层吃掉，**彻底不支持**；Linux 视硬件；macOS 靠 L2 + L3 双路。蓝牙外接键盘的 Fn 多数读不到——这是硬件限制。

### "接入一个 STT 供应商"
1. 读 [docs/features.md](../../../docs/features.md) + [docs/voice-input-flow.md](../../../docs/voice-input-flow.md)。
2. 在 `src-tauri/src/stt/` 下定义 `trait TranscribeProvider`。
3. 具体 Provider 实现（`OpenAIWhisper`, `Deepgram`, `Gemini` 等）做成独立 `mod`。
4. 配置（端点、Key、模型名）从 `tauri-plugin-store` + Keychain 读。
5. 超时 30s、错误映射到 `docs/voice-input-flow.md` 的 Error 状态。

### "对接 / 扩展 realtime ASR（OpenLoaf SaaS）"
**当前默认 STT 走 OpenLoaf SaaS 的 realtime WebSocket**——不是 REST 批量上传。现状：`src-tauri/src/stt/mod.rs` + `src/lib/stt.ts` + `src/stores/recording.ts` 已接好最小闭环。

1. **先读** `.claude/skills/openloaf-saas-sdk-rust/` —— 这是 SDK 用法权威文档（`client.realtime().connect(feature)` → `send_start` / `send_audio` / `send_finish` / `recv_event_timeout` / Drop 自动 Close）。
2. 关键事实（踩过的坑）：
   - `RealtimeSession` 内部用 `std::sync::mpsc::Receiver`（!Sync），**不能 Arc 跨线程共享**。我们的 stt 模块采用"session 单所有者"——专用 worker 线程独占 session；音频 / finish / stop 都走 `mpsc::Sender<Control>` 进 worker。
   - `close(mut self)` 吃所有权，放 Arc 里取不出——**不要尝试显式调 close**；让 `RealtimeSession` 随 worker 退出 drop，Drop impl 会自动发 Close 帧 + 关 socket。
   - `send_start` 第二参数 `I: Serialize` 在 `None` 时必须显式标类型：`None::<serde_json::Value>`。
   - PCM 帧要求 **PCM16 LE bytes**；cpal 默认吐 f32（多数设备 44.1k / 48k，立体声）。`audio/mod.rs::push_to_stt_pcm16` 做 mono downmix + 量化，在 audio callback 里就地转换。
   - 采样率 / 声道数跟随设备原生；不做重采样——服务端接受任意 sr。`sampleRate`/`channels` 通过 `send_start` 告知服务端即可。
3. 事件协议（Rust emit → 前端 listen）：
   | Tauri event | payload | 前端处理 |
   |---|---|---|
   | `openspeech://asr-partial` | `string` | 写 `liveTranscript` 给 overlay 实时展示 |
   | `openspeech://asr-final`   | `string` | 覆盖 `liveTranscript`；finalize invoke 也会返回同一文本 |
   | `openspeech://asr-error`   | `{code,message}` | 打日志；不强切 error 态（让 finalize 按 failed 落 history） |
   | `openspeech://asr-closed`  | `{reason,totalCredits}` | `reason=="insufficient_credits"` → 切 Error「余额不足」 |
   | `openspeech://asr-credits` | `number`（remaining） | 预留给"余额低于阈值"预警 UI |
4. **未登录的路径**：`stt_start` 会 `return Err("not authenticated")`；前端 `startSttSession().catch()` 只打 warn，**录音继续**，history 以占位文字落。不要因为 SaaS 未登录就禁用录音。
5. **扩展思路**：
   - 加 `language` 下拉 → 把 `Settings` 的语言值透传到 `startSttSession(lang)` → `send_start({"lang":...})`。
   - 换成其他 feature（翻译 / 大模型问答）→ 复制 `stt/mod.rs` 改 `FEATURE_ID`；事件 payload 结构跟 `RealtimeEvent` 保持一致即可。
   - 加"余额不足"预警 → 订阅 `openspeech://asr-credits`，低于阈值时 Toast + 跳充值。
6. **别做**：在 Rust 里又手搓一遍 tungstenite / 自管 ws 重连——SDK 已经把 mpsc + worker + Close 帧 + Drop 清理全打包；信任它。
7. **离线快速测试链路**：debug build 在每次 `apply_session`（登录 / refresh）时把 `{access_token, refresh_token, base_url}` dump 到 `~/.openspeech/dev_session.json`（chmod 600，release build 编译掉）；`logout` / `clear_session` 会删除。配套脚本 `src-tauri/examples/test_realtime_asr.rs`：读 session + 取 `~/Library/Application Support/com.openspeech.app/recordings/` 里最新 WAV → SDK 连 `realtimeAsr` → 20ms 分帧发 → 打印所有事件。用法：
   ```bash
   cd src-tauri && cargo run --example test_realtime_asr
   # 或指定 WAV：cargo run --example test_realtime_asr -- path/to/file.wav
   ```
   这条路径绕开主进程 audio/stt/hotkey，专测 SDK ↔ SaaS 这一段，排查服务端 500 / feature name / 采样率协商等非常高效。
8. **channels 一律写 1**：`audio::push_to_stt_pcm16` 在 cpal 回调里就把任意 ch 下混到 mono，所以 `stt_start` 的 `send_start` 必须告诉服务端 `channels:1`，否则 server 按 2ch 解析 mono 流会完全错位。2026-04-25 栽过一次。
9. **feature ID 是 `realtimeAsr`**（小写 sr），**不是** `realtimeASR` 全大写。写错会在 WebSocket 握手阶段直接 500。2026-04-25 栽过一次。

---

## 反模式（做了就回滚）

- ❌ 直接在主窗口写内联颜色 / 硬编码中英文文案。
- ❌ 跳过 `pnpm tauri add` 手动在 Cargo.toml / lib.rs 里加插件。
- ❌ 手写 `src/components/ui/*.tsx` 而不用 shadcn CLI 生成。
- ❌ 为了"兼容"旧 React Router v6 API 降级 react-router-dom。
- ❌ 把 API Key 明文存 `tauri-plugin-store`。
- ❌ 在 Rust 侧写可以被 Tauri 官方插件覆盖的系统调用（比如自己写剪贴板）。
- ❌ 改了技术栈 / 目录 / docs 结构却不同步本技能。

---

## 与其他技能的协作

- **`te-industrial-frontend`**（已在 `.claude/skills/` 下软链）—— Teenage Engineering 工业风前端实现指南（Light / Dark 双主题 + 等宽字体 + 黄色点缀 + Framer Motion 动画）。当用户要求把 OpenSpeech 的页面做成"工业风 / TE 风 / 黑底黄点缀 / 深色极简"等视觉方向时优先查阅该技能的 `references/design-system.md`、`component-patterns.md`、`animation-guide.md`。软链指向 `OpenLoaf-saas/.agents/skills/te-industrial-frontend`，更新随源自动生效。
- **`openloaf-saas-sdk-rust`**（已在 `.claude/skills/` 下软链）—— OpenLoaf SaaS Rust SDK 使用指南。**任何涉及登录 / 用户档案 / AI 工具（v3 webSearch 等）/ realtime 语音识别 WebSocket 的实现都先读这个技能**。包含最小用法、OAuth 桌面端完整流程、realtime ASR 帧协议、错误码排查表。软链指向 `Tenas-All/OpenLoaf-saas/.agents/skills/openloaf-saas-sdk-rust`，SDK 升版时同步更新。
- 写业务规则 / PRD → 走 `create-prd` 或 `create-proposal`，但 OpenSpeech 的业务规则主位于 `docs/`，不走这些技能的模板。
- 涉及 Tauri / Claude API / 前端框架的一般性最佳实践 → 可参考 `claude-api`、`vercel-react-best-practices`、`document-skills:frontend-design`，但**本技能的约定优先**。
