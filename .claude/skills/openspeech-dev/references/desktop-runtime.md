# 桌面运行时（窗口 / 托盘 / 权限 / Autostart）

> 何时读：改窗口配置、改关闭/最小化行为、改托盘菜单、加新 invoke、加系统权限申请、改开机自启。
> 真相来源：`src-tauri/src/lib.rs`、`src-tauri/tauri.conf.json`、`src-tauri/capabilities/`、`src/components/Layout.tsx`。本文只写源码读不出的取舍。

---

## 窗口与标题栏

- 主窗口 `titleBarStyle: "Overlay"` + `hiddenTitle: true`：macOS 红绿灯嵌入内容区左上角。
- 实际启动尺寸由 `lib.rs setup` 按主显示器 work area 自适应计算（取上限与屏幕可用空间的小值）。
- **全屏被全局禁用**：
  - `tauri.conf.json` 初始 `fullscreen: false`。
  - macOS 端 `lib.rs::disable_macos_fullscreen` 清 `FullScreenPrimary` / 加 `FullScreenNone`，绿按钮降级为 zoom。
  - **不要**再加"进入全屏"菜单项或调 `set_fullscreen(true)`。

---

## 关闭流程（Rust 是唯一拦截入口）

- 拦截链：`WindowEvent::CloseRequested` + `RunEvent::ExitRequested` 双层兜底 → emit `openspeech://close-requested` → 前端读 `settings.closeBehavior`（`ASK / HIDE / QUIT`）决定。
- **不要**在前端用 `getCurrentWindow().onCloseRequested()` —— StrictMode 下时序不稳。
- 托盘菜单"退出"**直接** `app.exit(0)`，不走 close-requested（用户已明确选）。

---

## macOS Cmd+Q 必须自建 App Menu 接管

- Tauri 2 在 macOS 下若无 `app.set_menu`，Cmd+Q 走 NSApp `terminate:` **绕过** Rust 与前端所有拦截直接退出。
- 在 `#[cfg(target_os="macos")]` 块里建含 `quit_app` accelerator 的 App Menu，由菜单系统接管后再 emit close-requested。
- Edit / Window 子菜单同步补全。

---

## listen 订阅必须 cancelled flag + unsub()

- `useEffect` 里 `await listen(...)` 返回前组件可能已重挂，dev 下 emit 一次会回调两次。
- Pattern 见 `Layout.tsx`。

---

## macOS Dock 图标切换

- 仅 `window.hide()` 不会隐藏 Dock。
- `hide_main_window` hide 后切 `Accessory`；`show_main_window` show 前切 `Regular`。
- **前端不要直接 `window.hide()/show()`**，一律走 `invoke("hide_to_tray")` / `invoke("show_main_window_cmd")`。

---

## macOS 输入监控授权策略（避免首启系统弹框被遮挡）

- `hotkey::modifier_only::init` 在 spawn `rdev::listen` 前先用 `permissions::input_monitoring_granted()`（`IOHIDCheckAccess`，**静默不弹框**）。
- 未授权则跳过 listen，本会话内 modifier-only 不工作。
- Onboarding 通过 `IOHIDRequestAccess` + `relaunch_app` 引导授权。
- **为什么**：避免首启时 listen 自动触发的"Keystroke Receiving"系统弹框被随后 show 的主窗口遮挡。
- 新增"首启即触发系统弹框"的能力（如 enigo / cpal）遵循同模式。

---

## 悬浮录音条（透明非交互浮窗）

> 窗口配置 / 尺寸读 `tauri.conf.json` 的 overlay window 段。本节只写读不出的契约。

- **豁免** drag region —— 不应被拖。
- macOS 跨 Space / 全屏可见：`visible_on_all_workspaces(true)`（Tauri 2.1+）；低版本走 `objc2` 设 `collectionBehavior |= canJoinAllSpaces | fullScreenAuxiliary`。
- 全屏态下仍不可见时回退"靠声音兜底"，已知平台限制。
- 尺寸是 logical px，由系统按 DPI 缩放，**不要自乘 `devicePixelRatio`**。

---

## Quick Panel（通用快速操作面板，Spotlight 风格）

> 真相来源：`src-tauri/src/quick_panel/mod.rs`、`src/pages/QuickPanel/`、`capabilities/quick-panel.json`。

通用容器 + 按 `mode` 字符串路由不同视图（首版 `edit-last-record`，后续翻译/问答等同模式挂上来）。Rust 端 `quick_panel::show(app, mode)` 在 emit 之前把 mode 推给前端，前端按 `openspeech://quick-panel-mode` 事件切视图。

### 必须做对的几件 macOS 事

**1. show 不能让 OpenSpeech 成为 frontmost。**
- `Tauri set_focus` 底层调 `[NSApp activateIgnoringOtherApps:]` —— OpenSpeech 一旦 active，**所有 visible window**（包括主窗、即便它被其他 app 挡着）都被 z-order 抬到最前，用户感知就是"按快捷键主窗冒出来"。
- 解法：把 NSWindow 切到 **nonactivating NSPanel**（mask `1 << 7`） —— `[NSApp activate]` 路径短路。
- 但 nonactivating panel 默认 `canBecomeKeyWindow = NO`，textarea 收不到键盘事件。

**2. 动态 NSPanel 子类 + override `canBecomeKeyWindow = YES`。**
- overlay 注释里的"动态子类撞 wry KVO"指的是给 **wry NSWindow class** 创建子类。给 system **NSPanel** 创建子类不撞 —— wry 的 KVO observer 链注册在原 wry class 那侧，跟我们 `object_setClass` 切到的新 panel 子类无关。
- 实现：`objc_allocateClassPair(NSPanel, "OpenSpeechKeyableNonactivatingPanel", 0)` + `class_addMethod(canBecomeKeyWindow → YES)` + `class_addMethod(canBecomeMainWindow → NO)` → `objc_registerClassPair` → `object_setClass`。class 用 `OnceLock` 缓存只注册一次。

**3. hide 时绝对不要用 `[NSApp deactivate]` 或 `[NSApp hide:nil]`。**
踩过的失败方案：
| 尝试 | 失败原因 |
|---|---|
| `[NSApp deactivate]` | **异步**生效，`panel orderOut` **同步**触发 AppKit "find next key window"，主窗（normal NSWindow，canBecomeKey=YES）被 makeKey + raise 到 z-order 最前；deactivate 还没生效主窗已经露脸 |
| `[panel resignKeyWindow]` + `[NSApp deactivate]` | 同上，仍异步 |
| `[NSApp hide:nil]` | 同步够狠，但等价 Cmd+H —— **主窗如果本来 visible 也跟着藏**，下次按快捷键 unhide 时主窗与 panel "一起出现一起消失"，不可接受 |

**正解（Spotlight / Raycast 同款）**：
- `show` 入口最早处用 `[[NSWorkspace sharedWorkspace] frontmostApplication]` 拿 PID，**排除 OpenSpeech 自己的 pid**，存进全局 `AtomicI32`。
- `hide` 时 `[NSRunningApplication runningApplicationWithProcessIdentifier:] activateWithOptions:0` 把前一个 app 拉回前台 —— 那个 app 一旦 active，OpenSpeech 自动让出 frontmost，AppKit 不会再去 OpenSpeech 内部找 next key，主窗 z-order/visible 完全不动。
- 边角：show 时 frontmost == self（用户在主窗里按快捷键）→ 不记录 PID，hide 时 fallback 走 `[NSApp deactivate]`，主窗保持原状。

**4. capability 必加 `core:window:allow-start-dragging`。** drag region 才工作。

### 视觉：transparent 圆角窗口的 shadow

- `.shadow(true)`（NSWindow 系统 shadow）+ transparent + 圆角内容 → 底部圆角外露出**矩形 shadow 角**，看起来像两个直角。
- 解法：`.shadow(false)` + CSS `shadow-2xl` 自己画，shadow 跟着 `rounded-2xl` 边界。但 webview 必须**比 panel 视觉尺寸大一圈**（每边 +40px 透明边距），否则 CSS shadow 被 webview 边界裁掉。

> 前端侧契约（drag region 子元素逐个标注、quick panel 多 webview 数据契约）见私仓 `openspeech-frontend` skill。

---

## Tauri 权限关键项（`capabilities/default.json` 必显式声明）

`core:default` **不含**以下，必须额外加：

| 权限 | 用途 | 漏了会怎样 |
|---|---|---|
| `core:window:allow-start-dragging` | `data-tauri-drag-region` 工作 | 拖拽窗口失效 |
| `clipboard-manager:allow-write-text` | `inject_paste` 写剪贴板 | 文本注入失败（`clipboard-manager:default` 只放 readText） |
| `core:window:allow-hide / -show / -set-focus / -unminimize` | 我们目前通过 Rust 命令包装，capability 留着防误用 | 直接前端调用会被拒 |

**新加 invoke / 插件时显式声明，避免全量通配 `allow-*`。**

---

## 机密存储

- API Key 等机密 **不走 `tauri-plugin-store`**。
- 前端封装在 `src/lib/secrets.ts`，对应后端 `secrets/mod.rs` 的 `secret_set / secret_get / secret_delete`。
- 后端按 `cfg(debug_assertions)` 拆双实现：
  - **release**：`keyring` crate（macOS Keychain / Win Credential Manager / Linux Secret Service），service `com.openspeech.app`。
  - **debug**：写 `~/.openspeech/dev-secrets.json`（`BTreeMap<String,String>` JSON，0600，进程级 `Mutex` 串行），**不进 Keychain**。
  - Why：debug 二进制每次 cargo build cdhash 都变，macOS Keychain ACL 绑 cdhash —— 即便点过"始终允许"，下次重 build 仍当作新进程弹密码框，开发者每天会被打断几十次。dev 数据非生产凭据，落本地文件足够；prod 行为不变。
  - 同款 dev/release 拆法见 `openloaf/storage.rs`（OpenLoaf SaaS token 存储）。
- `#[tauri::command]` 三件套签名不变，前端与 `ai_refine/mod.rs` 等调用方不感知。

### 听写自定义供应商（Dictation custom providers）的两半存储

一份 provider 配置在磁盘上**横跨两个文件**，dev / release 路径不同但结构一致。新增字段或排查"凭证读不到"时记得两边都看。

| 部分 | 字段 | dev 路径 | release 路径 |
|---|---|---|---|
| 非机密 | `dictation.customProviders[]` 的 `id / name / vendor / tencentAppId / tencentRegion`、`dictation.activeCustomProviderId` | `~/Library/Application Support/com.openspeech.app/settings.json`（tauri-plugin-store，dev/release 同路径，identifier 都是 `com.openspeech.app`，无 `.dev` 后缀） | 同 dev |
| 机密 | aliyun `apiKey` / 腾讯 `secretId + secretKey`，**整段 camelCase JSON** 存在 keyring entry 名 `dictation_provider_<provider-id>` 下 | `~/.openspeech/dev-secrets.json` 里的同名 key（值是 JSON 字符串，再被外层 BTreeMap 包一层） | macOS Keychain / Win Credential Manager / Linux Secret Service |

代码：前端 `src/lib/secrets.ts:43-95`（`saveDictationProviderCredentials` / `loadDictationProviderCredentials`），后端 `src-tauri/src/secrets/mod.rs:138-165`（`load_dictation_provider_credentials_for_rust`）；DTO 透传见 `src/lib/dictation-provider-ref.ts` + `src-tauri/src/asr/byok.rs` —— **AppID / region 走 IPC 透传，secretId / secretKey 永远不通过 IPC**。

**dev 调试 tips：**
- 想直接看 / 改本机 dev 凭证：`cat ~/.openspeech/dev-secrets.json`，找 `dictation_provider_<id>`，value 是字符串化的 `{"vendor":"tencent","secretId":"...","secretKey":"..."}` 或 `{"vendor":"aliyun","apiKey":"..."}`。
- 想看公开字段：读 `settings.json` 的 `dictation.customProviders[]`，按 `id` 跟 dev-secrets.json 对得上。
- 重 build / 清数据后丢失测试 provider：dev-secrets.json 不会因为重 cargo build 失效（与 release 的 Keychain cdhash 行为不同），所以正常情况只会丢公开字段（settings.json 是 `~/Library/Application Support/...` 不会被 cargo clean 清）。如果两边都丢了，要么手填 UI 一遍，要么自己写一个 dev-only seed 脚本（仓库里目前**没有**统一的 dev fixture loader，加之前先在 PR 描述里说清意图）。
- ❌ 别把 secretId/secretKey/apiKey 写进 settings.json 或 localStorage —— `src/lib/secrets.ts:4` 的注释里有"不要"二字。

---

## Autostart

- `syncAutostart(desired)` 只在期望 ≠ OS 实际时写注册项。
- boot 与设置 Switch 改动各同步一次。
- 失败只记日志，不阻断。
