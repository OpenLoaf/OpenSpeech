# 设置项定义

设置分为 5 个区块：**账户 / 设置（通用）/ 个性化 / 关于 / 帮助中心**。

## 账户（Account）

| 项 | 说明 |
|---|---|
| 电子邮件 | 当前登录账户（若启用账户体系；开源版可为可选） |
| 订阅 | 显示当前订阅状态；有"升级"入口 |
| 礼品卡 | 兑换码入口 |
| 退出 | 清空本地登录态，不删除本地数据 |

> 开源版 / BYO-Model 版本可将账户体系简化为"仅邮箱登录用于同步词典/设置"，或完全去除。

## 设置（Settings）

### 键盘快捷键

- 听写 —— 默认 `Ctrl + Shift + Space`；默认 `mode=hold`（按住说话）。录入按钮**左侧的 Switch** 打开后切为 `mode=toggle`（单击切换：按一下开始、再按一下停止）——内部仍是同一个 `dictate_ptt` 绑定，仅 `binding.mode` 在 `hold` / `toggle` 之间翻转，不再维护独立的 `dictate_toggle` 绑定。
- 问 AI —— 默认 `Ctrl + Shift + A`
- 翻译 —— 默认 `Ctrl + Shift + T`

每条支持：自定义录入、清除、↺ 恢复默认、▶ 测试诊断、冲突就地提示与 [替换] 一键切换。操作按钮 cluster（Reset / Test / Clear）显示在 label **左侧**并**常驻**——恢复默认按钮即使当前已是默认值也保留（灰色 disabled），Clear 按钮无值时 disabled。设置区域底部提供"全部恢复默认"。听写至少保留一个可用绑定：听写行 `canClear=false`，不提供 Clear。

详见 [hotkeys.md](./hotkeys.md)。

### 语言

| 项 | 说明 |
|---|---|
| 界面语言 | UI 显示语言；默认跟随系统 |
| 听写语种 | `自动检测`（默认）/ 指定语种 |
| 翻译目标 | 翻译功能的目标语言 |
| 语言变体 | 例如 en-US / en-GB、zh-CN / zh-TW |

### 音频

| 项 | 说明 |
|---|---|
| 输入设备 | 下拉选择麦克风。持久化字段 `inputDevice`：`""` = 跟随系统（默认）；非空 = 用户显式选中的设备名。"跟随系统"的 label 会拼上**当前系统默认设备名**（如 `跟随系统（当前：MacBook Pro Microphone）`），用户能看清此刻实际走的是哪一个 |
| 输入声音 | 实时麦克风电平（5 格）。下方 hint 显示"正在监听：<设备名>"，和**实际在用**的设备保持一致（而非仅仅是用户的偏好） |

**设备离线时的 fallback**：用户手动选了一个设备（如 AirPods），之后把它拔掉——`inputDevice` 持久化值**不被改写**，运行时按以下规则解析 effective device：`wanted=""` → 系统默认；`wanted ∈ 枚举列表` → `wanted`；`wanted ∉ 枚举列表` → 系统默认（持久化保留，设备插回后自动恢复）。Rust 侧 `audio::start()` 的 `or_else(default_input_device)` 是同一套逻辑的兜底；前端只负责在 Select 里追加一条 `"<wanted> · 已断开，暂用系统默认（<sysName>）"` 占位项，让 `<select value>` 不失匹配且让用户知情。
| 开始/结束提示音 | 开关 |

> 最长录音时长不再作为独立设置项；录音状态机内部默认上限见 `voice-input-flow.md`。

### 大模型（REST）

独立 tab，侧边栏名"模型"。

| 项 | 说明 |
|---|---|
| STT 端点 URL | 必填；用户自行填写 |
| API Key | 必填，加密存储 |
| 模型名称 | 可选，部分服务需要 |
| 请求超时 | 默认 30 秒 |
| 音频编码 | `wav` / `opus`，取决于端点支持 |
| 连接测试按钮 | 发送一个 1 秒静音样本验证连通性 |

### 文本注入

| 项 | 说明 |
|---|---|
| 注入方式 | `剪贴板粘贴`（默认）/ `模拟键盘输入` |
| 粘贴后恢复剪贴板 | 开关（默认开） |

### 行为

| 项 | 说明 |
|---|---|
| 开机自启 | 开关 |
| 在 Dock 中显示应用（macOS 独占） | 开关（持久化字段 `showDockIcon`，默认 on）。**仅 macOS 渲染**（其他平台无 Dock 概念）。on ⇒ `ActivationPolicy::Regular`，Dock 显示应用图标；off ⇒ `ActivationPolicy::Accessory`，应用变为纯菜单栏应用，仍可通过系统托盘打开主窗口。前端 onChange 持久化到 settings.json + `invoke("sync_dock_icon")` 让 Rust 立即重读并切 policy；`show_main_window` 也按本字段决定 policy（否则 `hide_main_window` 先切 Accessory 再 show 会把用户的 on 偏好洗掉）；setup 启动时调 `apply_dock_icon_policy` 同步一次，避免上次关过 Dock 图标而启动瞬间闪烁 |
| 悬浮录音条常驻显示 | 开关（持久化字段 `overlayAlwaysVisible`，默认 off）。开启后悬浮录音条在未录音时也悬停在屏幕上；off 时只有录音期间才显示。Rust overlay 需读此字段决定启动时是否 show；目前 UI 与持久化已接，overlay 行为接入为后续任务 |
| 关闭时最小化到托盘 | 开关。开启 ⇒ 关闭主窗口（红叉 / Cmd+Q / Alt+F4）直接隐藏到系统托盘；关闭 ⇒ 每次弹 CloseToBackgroundDialog 让用户选"继续后台"/"退出"。对话框里勾"不再提醒 + 继续后台"会把本开关置 on；勾"不再提醒 + 退出"会把内部 `closeBehavior` 设为 `QUIT`（开关显示为 off，再次 on → HIDE） |

## 个性化（Personalization）

| 项 | 说明 |
|---|---|
| AI 自动润色 | 开关；开启后删除口误/填充词 |
| 上下文风格 | 开关；开启后把当前前台应用名传给模型 |
| 学习速度 | 影响自动词典收录的灵敏度（迭代） |

## 关于（About）

显示版本号、许可证、开源地址（若适用）、第三方依赖列表。

## 帮助中心 / 版本说明

外部链接，跳转到官方文档与 changelog。

## 关于（About）· 维护入口

- 重新运行首次启动向导（见 [onboarding.md](./onboarding.md)）
- 检查系统权限（打开实时权限状态面板）
- 版本号 / 许可证 / 开源地址 / 第三方依赖

## 通用规则

1. 所有设置变更**实时生效**，不需要"保存"按钮；快捷键变更通过 `unregister → register` 热重载。
2. 设置文件 schema 带 `schemaVersion` 字段；升级时按版本运行迁移脚本；解析失败则将文件重命名为 `.corrupt.bak` 并以默认值启动，同时 Toast 告知用户。
3. 设置存储在本地（而非账户同步），除非用户显式启用同步。
4. API Key 使用系统 Keychain / Credential Manager / Secret Service 存储，不明文落盘。
