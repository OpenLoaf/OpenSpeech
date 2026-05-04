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

每条支持：自定义录入、清除、↺ 恢复默认、▶ 测试诊断、冲突就地提示与 [替换] 一键切换。操作按钮 cluster（Reset / Test / Clear）显示在 label **左侧**并**常驻**——恢复默认按钮即使当前已是默认值也保留（灰色 disabled），Clear 按钮无值时 disabled。设置区域底部提供"全部恢复默认"。听写至少保留一个可用绑定：听写行 `canClear=false`，不提供 Clear。

详见 [hotkeys.md](./hotkeys.md)。

### 语言

| 项 | 说明 |
|---|---|
| 界面语言 | UI 显示语言；默认跟随系统 |

> 「听写语种」已从「常规」节移到「听写」分区——它是听写通道的属性而不是 UI 属性。详见下文「听写」节。

### 音频

| 项 | 说明 |
|---|---|
| 输入设备 | 下拉选择麦克风。持久化字段 `inputDevice`：`""` = 跟随系统（默认）；非空 = 用户显式选中的设备名。"跟随系统"的 label 会拼上**当前系统默认设备名**（如 `跟随系统（当前：MacBook Pro Microphone）`），用户能看清此刻实际走的是哪一个 |
| 输入声音 | 实时麦克风电平（5 格）。下方 hint 显示"正在监听：<设备名>"，和**实际在用**的设备保持一致（而非仅仅是用户的偏好） |

**设备离线时的 fallback**：用户手动选了一个设备（如 AirPods），之后把它拔掉——`inputDevice` 持久化值**不被改写**，运行时按以下规则解析 effective device：`wanted=""` → 系统默认；`wanted ∈ 枚举列表` → `wanted`；`wanted ∉ 枚举列表` → 系统默认（持久化保留，设备插回后自动恢复）。Rust 侧 `audio::start()` 的 `or_else(default_input_device)` 是同一套逻辑的兜底；前端只负责在 Select 里追加一条 `"<wanted> · 已断开，暂用系统默认（<sysName>）"` 占位项，让 `<select value>` 不失匹配且让用户知情。
| 开始/结束提示音 | 开关 |

> 最长录音时长不再作为独立设置项；录音状态机内部默认上限见 `voice-input-flow.md`。

### 听写（Dictation）

独立 tab，承载所有听写通道相关设置。

#### 通道选择
| 项 | 说明 |
|---|---|
| 听写云通道 | `OpenLoaf 云端`（默认，saas）/ `自定义供应商`（custom）|
| 听写语种 | `跟随界面语言`（默认）/ `自动检测` / `中文` / `English` / `日本語` / `한국어` / `粤语`。`follow_interface` resolve 见 `src/lib/dictation-lang.ts`；后端按 ISO code 映射到各家专属字段（见 [cloud-endpoints.md §4.3](./cloud-endpoints.md)）|

#### 自定义供应商（mode=custom 时显示）
支持腾讯云 / 阿里云 BYOK，多个供应商共存但同时只能激活一个。所有密钥走 macOS Keychain。

| 供应商 | 必填字段 | 可选字段 |
|---|---|---|
| 腾讯云 | AppID / Region（默认 `ap-shanghai`） / SecretId / SecretKey / **COS Bucket（必填）**：录音先上传到 COS 再转写，单文件 ≤512MB。前端必填校验 + 后端拒绝空 bucket（错误码 `tencent_cos_bucket_required`）。 | — |
| 阿里云 DashScope | ApiKey | — |

每条 provider 卡片提供「测试」按钮，发一次最小握手验证凭证有效性。详见 [cloud-endpoints.md §3 / §4](./cloud-endpoints.md)。

#### 听写模式
| 项 | 说明 |
|---|---|
| 听写模式 | `实时转换`（REALTIME，server VAD 切句流式 partial）/ `整句听写`（UTTERANCE，松开后整段文件转写，默认） |
| 启用 AI 优化 | 开关，默认 on。仅 UTTERANCE 模式下生效；REALTIME 强制禁用 + 灰显 |

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
| 关闭时最小化到托盘 | 开关。开启 ⇒ 关闭主窗口（红叉 / Cmd+Q / Alt+F4）直接隐藏到系统托盘；关闭 ⇒ 每次弹 CloseToBackgroundDialog 让用户选"继续后台"/"退出"。对话框里勾"不再提醒 + 继续后台"会把本开关置 on；勾"不再提醒 + 退出"会把内部 `closeBehavior` 设为 `QUIT`（开关显示为 off，再次 on → HIDE） |

## 个性化（Personalization）

| 项 | 说明 |
|---|---|
| AI 自动润色 | 开关；开启后删除口误/填充词 |
| 上下文风格 | 开关；开启后把当前前台应用名传给模型 |
| 学习速度 | 影响自动词典收录的灵敏度（迭代） |

## AI（文本改写）

新增独立 tab，承载 AI_REFINE 听写松开后的改写策略：云端（saas）vs 自定义供应商（custom，OpenAI 兼容协议）。同一时刻只能激活一个自定义供应商；API Key 一律走系统 keyring，绝不进 settings.json。详见 [ai-refine.md](./ai-refine.md)。

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
