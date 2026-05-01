# 前端规约（i18n / TE 样式 / Drag region / Dialog）

> 何时读：改 UI、加文案、改样式、新建组件、新建 Dialog。
> 真相来源：`src/i18n/`、`src/App.css`、`src/components/`。本文只写源码读不出的取舍。

---

## i18n（zh-CN / zh-TW / en）

### 加载机制
- `src/i18n/index.ts` 用 `import.meta.glob("./locales/*/*.json", { eager: true })` 编译期收齐所有 namespace。**新增 namespace 只需加 3 个语言下同名 json**，不必改 `index.ts`。
- 当前 ns：`common / settings / pages / onboarding / overlay / dialogs / errors / hotkey / tray`。

### defaultNS = `common`
- 通用 key（`actions / lang / value`）写在 `common.json`，调用 `t("actions.cancel")` 不带前缀。
- 其他 ns 一律 `t("ns:section.key")` 形式（如 `t("settings:lang.label")`）。

### 语言来源唯一入口
- `useSettingsStore.general.interfaceLang`，类型 `LanguagePref = "system" | "zh-CN" | "zh-TW" | "en"`。
- **不要直接 `i18n.changeLanguage`** —— 一律 `setGeneral("interfaceLang", v)`，store 内会自动调 `syncI18nFromSettings`（`src/lib/i18n-sync.ts`）：切 i18n 当前语言 + 把翻好的托盘 labels 推给 Rust。

### 托盘菜单文案前端推
- Rust 不嵌 i18n。`src-tauri/src/lib.rs` 的 `TrayLabels` 全局态由 invoke `update_tray_labels` 写入；空时英文兜底。
- `tray.json` 的 key 名与 `src/lib/i18n-sync.ts::pushTrayLabels` 严格一致，**改 key 名两边一起改**。
- 占位符用 `{{name}}` / `{{version}}`（双花括号，Rust 端 `replace` 用这个语法）。

### 后端只发 stable code，不发翻译文案
- 例：`Err("AUTH_LOGIN_TIMEOUT".into())`。
- 前端 `src/lib/errors.ts::translateBackendError` 做 code → `t("errors:auth.login_timeout")` 映射。
- **Rust 内部 log（`log::warn!` 等）保留中文/英文随意，不翻译** —— 日志不是用户面。

### 保留不翻清单（跨语言原样保留）
- 品牌：`OpenSpeech / OpenLoaf / Tauri / React / Whisper / TypeLess / GitHub / shadcn / Apple / macOS / Windows / Linux`
- 按键名：`Fn / Ctrl / Cmd / Alt / Shift / Space / Esc / Tab / Enter / Caps`
- 技术缩写：`STT / API / WAV / PCM / VAD / ASR / LLM / SDK / OS / URL / Key / Token / WebSocket / REST / SaaS / BYO / TCC`
- **TE 装饰性全大写英文 mono 小标签**（section 标题如 `GENERAL` / `PERSONALIZATION`）—— 这是 TE 美学的一部分，跨语言保留有视觉统一感。

### 新增文案标准动作
1. 找最贴近的 ns，不够再开新 ns。
2. zh-CN / zh-TW / en **同时**加，不要只加一个。
3. zh-TW 必须真正繁体化（设置→設定 / 软件→軟體 / 录音→錄音 / 用户→使用者 / 网络→網路 / 保存→儲存 / 登录→登入），按台湾正体习惯，不要简单繁简机翻。
4. en 用 sentence case，不滥用 Title Case。

### 不翻
- 注释、`console.log/warn/error` / `log::*` / `tracing::*` 中的中文、import 路径、内部对比用的字面量。

### 调用约定
- Zustand store / 非 React 模块 → `import i18n from "@/i18n"; i18n.t(...)`。
- React 组件 → `useTranslation` hook。

---

## TE 工业风样式

> 详细组件模板见同目录软链 `te-industrial-frontend` skill。本节只写 OpenSpeech 项目级硬约束。

### 主题
- `index.html` 默认 `<html class="dark">`；主题切换只 toggle 此 class。
- 页面只用 `te-*` 语义 token（`bg-te-bg` / `text-te-fg` / `text-te-accent` 等），定义在 `src/App.css` 的 `@theme inline`。
- **禁硬编码** `bg-black` / `text-white` / `bg-white` / `text-black`。

### 字体
- `font-mono` 用于标题/标签/编号/按钮。
- `font-sans` 用于正文。

### shadcn Dialog 的 TE 覆盖
- `rounded-none` + `border border-te-gray` + `bg-te-bg` + `!gap-0`。新增 Dialog 沿用这套覆盖。

### Logo wordmark
- `OPEN` 用 `text-te-fg`，`SPEECH` 用 `text-te-accent`，紧贴同容器，不改。

### 禁用清单
- 渐变 / glow / 重阴影 / 圆角 > `rounded-sm` / pill / emoji 装饰。

### 动画
- 用 `framer-motion` 的 `whileInView` + `viewport={{ once: true }}`，0.4–0.6s。
- 禁 spring bounce。

### overscroll
- `App.css` 已对 `html / body / #root` 关 overscroll bounce。新建全屏容器遵守。

---

## Logo 资源（`public/`）

三个一组按场景选用，不要混用：

| 文件 | 形态 | 用途 |
|---|---|---|
| `logo-write.png` | 白色线条 + 透明背景 | **深色应用 UI 内的品牌头**：侧栏顶部 / Onboarding header / Welcome hero / LoadingScreen splash / Home hero 标签行 |
| `logo-black.png` | 黑色线条 + 透明背景 | 备用浅底前景，目前 UI 内未直接使用 |
| `logo-write-bg.png` | 白色背景方图（自带底色） | **双用途**：① `index.html` favicon（浏览器 tab / dev 模式标题图标，需要不透明背景才不会被深色 tab 吞掉）；② `pnpm tauri icon` 的源图，生成 `src-tauri/icons/` 全平台 icon |

### 替换图标
1. 编辑 `public/logo-write-bg.png`。
2. `pnpm tauri icon ./public/logo-write-bg.png` 一键再生全平台 icon。
3. favicon 自动跟随（同一个文件）。
- **反模式**：手工裁切 / 单独换 `.icns` / 给 favicon 改用透明 PNG。

### macOS Dock 图标更新后看不到变化
- 系统 iconservices 缓存。`killall Dock` 通常即可。
- 顽固时：`sudo rm -rf /Library/Caches/com.apple.iconservices.store && killall Dock`。

---

## Drag region 分布（必读，否则只剩侧边栏一小块能拖）

### 分布契约
- **侧边栏顶部**：固定一条 drag 条（高度对齐 macOS 红绿灯区，具体尺寸读 `Layout.tsx`）。
- **主内容区 Layout 层不挂 drag 条**，由 page 自己声明：
  - 有 sticky header 的 page（Dictionary / History）→ sticky header 外层加 `data-tauri-drag-region`，内部交互元素加 `data-tauri-drag-region="false"` 豁免。
  - 无 sticky header 的 page（Home）→ section 顶部挂 `sticky top-0` 透明 drag 条，用负 margin 抵消 padding 撑满。

### 反模式
- ❌ 用 absolute overlay 当 drag region —— drag 元素必须是 scroll 容器后代，否则 wheel 事件被吃。
- ❌ 给透明非交互浮窗（悬浮录音条）加 drag region —— 浮窗配置见 `tauri.conf.json`，不应被拖。

### Tauri 权限前提
- `core:default` 不含 `core:window:allow-start-dragging`。`capabilities/default.json` 必须显式声明，否则 drag region 静默失效。

---

## Dialog 优先：设置 / 账户

- 两者都用 Dialog，由 Layout 侧边栏底部图标按钮触发。
- **`SettingsContent.tsx` 是 Dialog 与 `/settings` 路由共享组件**，改设置只动一处。
- 账户内容若未来变重再评估拆页。

---

## WebView 右键菜单

- `main.tsx` 启动时全局 `preventDefault` `contextmenu`。
- 个别输入框需要原生菜单时单独 `stopPropagation`。
