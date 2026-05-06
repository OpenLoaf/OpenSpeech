# 快捷键规则

## 默认快捷键

听写（`dictate_ptt`）默认按平台选取——**对齐行业标杆**（Wispr Flow / TypeLess / FreeFlow），保证首启即用、冲突概率最低：

| 平台 | 听写默认 | 形态 | 备注 |
|---|---|---|---|
| **macOS** | `Fn + Ctrl` | modifier-only | 按一次开始、再按一次结束。组合键避免 Intel Mac / 外接键盘上单 Fn 不可达 + 减少与系统 Fn 行为的歧义。需用户在 Settings → Keyboard → "Press fn key to" 设为 "Do Nothing"，否则 Fn 会弹出 Emoji 面板。 |
| **Windows** | `Ctrl + Win` | modifier-only | 按一次开始、再按一次结束。不占常规组合键；备选 `Right Alt`。 |
| **Linux** | `Ctrl + Super` | modifier-only | 按一次开始、再按一次结束。GNOME 在某些版本会拦截 Super，若冲突改用 `Right Alt`。 |

| 功能 | 默认组合 | 模式 | 可否自定义 | 可否清空 |
|---|---|---|---|---|
| 听写 | 见上表 | `toggle`（按一下开始、再按一下结束，全系统统一） | ✅ | ❌（听写必须保留一个绑定） |
| 取消录音 | `Esc`（仅录音态生效，见下） | — | ❌ | ❌ |

> 早期设计里听写有两个独立绑定（PTT / Toggle 各占一行），并支持 `hold`（按住说话）/ `toggle`（单击切换）两种模式。现在合并为单一 `dictate_ptt` 绑定，且**全系统统一为 toggle 语义**——不再有 hold 模式。持久化层的 `dictate_toggle` 旧字段与 `binding.mode` 字段由 `hotkeys` store 的 `sanitizeBindings` 读取时自动丢弃。

> **听写为何用 modifier-only 而非 combo？** modifier-only 绑定（如 `Fn + Ctrl` / `Ctrl + Win` 组合按住）触发肌肉记忆更轻——不想让用户同时按 `Ctrl + Shift + Space` 三个键才能说话。这种形态在三端主流语音输入产品里已成共识。

## 通用规则

1. 所有可自定义快捷键**必须支持全局捕获**：在任何前台应用下都能触发。
2. 快捷键**不允许重复**。录入时检测到重复，弹 Dialog 询问"是否替换"；确认后清空被占用的那一项，并提供撤销 Toast（8 秒，鼠标 hover 暂停倒计时）。
3. 快捷键支持三种形态（`BindingKind`）：
   - **`combo`** —— 1 修饰键 + 1 主键（如 `Ctrl + Shift + Space`）。所有平台通吃，最稳。
   - **`modifierOnly`** —— 1 到 N 个修饰键按住即触发（如 `Fn`、`Ctrl + Win`、`Right Alt`）。听写的默认形态。
   - **`doubleTap`** —— 双击单个修饰键（如 `2× Right Shift`）。适合 toggle 模式。
   - 不支持：纯字母组合（`A + B + C`）、超过 3 个键、混合左右修饰键（`LeftCtrl + RightShift`）。
4. **听写快捷键必须始终有绑定**：听写行的 Clear 按钮恒 disabled；用户只能改绑到别的键，不能清空到"未绑定"状态。
5. 左右修饰键 **MVP 默认合并**（按 Left Ctrl 或 Right Ctrl 都能触发"Ctrl"绑定）。UI 不暴露"区分左右"开关；未来版本视用户反馈再评估引入。**例外**：`Right Alt` / `Right Option` / `Right Ctrl` / `Right Shift` 作为 `modifierOnly` 绑定时需要精确匹配，避免被左侧同名键误触。
6. 快捷键变更实时生效，内部执行 `unregister(old) → register(new)` 热重载，无需重启应用；变更时若正处于录音中，该次录音立即视为取消（cancelled）。

## 按键行为

| 行为 | 规则 |
|---|---|
| 第一次按下 | 进入 Recording（前 300 ms 仅显示"准备中"悬浮态） |
| 第二次按下（**同 id**） | 结束录音，进入 Transcribing |
| 录音中按"另一种"激活键（**dictate_ptt ↔ translate**） | 仅 UTTERANCE 模式：切 `activeId` 不结束录音；REALTIME 模式：忽略 |
| 录音持续超过 SaaS realtime 会话 2 小时硬上限 | 服务端发 `closed{reason:"max_duration"}`，视为录音异常结束，history 标 failed |
| 第一次按下 < 300 ms 内立即再按一次 | 视为误触，悬浮条淡出，不调用大模型，不计入历史 |
| 录音期间 `Esc` | 立即取消录音，见下"Esc 处理" |
| 快捷键被其他应用占用 | 字段右侧显示冲突提示；仍尝试注册（见"冲突检测"）|

> 跨模式切换（dictate_ptt ↔ translate）的状态机细节、UI 反馈、REALTIME 不支持的原因见 [voice-input-flow.md §录音中切换模式](./voice-input-flow.md#录音中切换模式听写--翻译)。

## Esc 处理（状态化）

Esc 不注册为全局快捷键（否则会拦截用户在其他应用里的 Esc，造成骚扰）。实现方式：

1. 应用始终在后台挂一个全局 **键事件监听线程**（通过 `rdev` 实现），默认不对 Esc 做任何处理。
2. 仅当状态机处于 `Recording` 或 `Transcribing` 时，该线程订阅 Esc 键事件；一旦收到 Esc 立即触发取消并退订。
3. 状态机离开 Recording/Transcribing 后，Esc 订阅立即解除——其他应用的 Esc 行为完全不受影响。
4. Esc 取消 + 大模型已返回结果的情况：**保留转写文字到历史（标记 cancelled），但不执行注入**。详见 [history.md](./history.md#cancelled-状态规则)。

悬浮条上的 `×` 按钮和 `Esc` 行为完全等价。

## 冲突检测

### A. 应用内冲突（强约束）

录入时检测到组合与 OpenSpeech 其他功能重复：

- 不静默覆盖。弹出 Dialog："此组合已被使用。确认替换？[替换] [取消]"
- 替换 → 执行切换 + 底部 Toast 显示"快捷键已替换 [撤销]"，8 秒窗口期内可恢复；鼠标 hover 暂停倒计时。
- 取消 → 保持原绑定。
- **撤销 buffer 落盘**：最近一次替换操作的 `{被替换项, 原值, 新值, 时间戳}` 写入 `store` 的 `undo_buffer`；应用重启后若时间戳距今 < 8 秒仍可撤销，Toast 在主窗口启动时重新显示剩余秒数。
- Dialog 挂载后**延迟 250 ms 才启用按钮**并 swallow 这期间的 keydown——避免用户录入时仍按住的组合键误触发 Dialog 的 Enter/Space 默认按钮。

### B. 系统 / 第三方应用冲突（弱警告）

| 情形 | 处理 |
|---|---|
| 插件 `register()` 返回 Err | 字段下方红色文字 "系统拒绝注册" + `[换一个]`，绑定不保存 |
| 注册成功但后台"静默失败"（macOS 常见） | 通过"测试快捷键"诊断工具发现；见下 |
| 已知系统保留组合（`Cmd + Space` 等，内置名单） | 录入时黄色警告"可能与 Spotlight 冲突" + `[仍要使用]`，不阻止保存 |

### C. 自诊断工具

设置页"键盘快捷键"区域每个字段旁有 `▶ 测试` 图标。点击后倒计时 5 秒 Dialog："请按一次 `Ctrl + Shift + Space`..."：

- 5 秒内收到回调 → "✓ 工作正常"
- 超时未收到 → "⚠ 未收到按键事件，可能被其他应用拦截。建议更换组合或检查系统权限"

应用启动后还会在后台跑一次 **被动自检**：注册完所有快捷键后，若任一快捷键在首次预期触发时机（由用户真实按键触发）未产生回调，内部静默记录但**不主动弹提示**，直到下次打开设置页才在对应字段上显示"未检测到回响，点此诊断"。

## 平台限制

| 平台 | 限制 |
|---|---|
| **macOS** | `Fn` 键通过 Rust 侧 `CGEventTap` + `flagsChanged` 原生支持（Layer 3 兜底）+ `rustdesk-org/rdev` fork 的 `Modifiers::FN`（Layer 2）。需 Accessibility 权限（首启弹窗）。Option+字母会产生 dead key，录入组件必须用 `event.code` 而非 `event.key`。**蓝牙外接键盘的 Fn 多数被硬件层吃掉，系统 API 读不到——这是硬件层限制，无解**。提示用户在 Settings → Keyboard → "Press fn key to" 设为 "Do Nothing"，否则 Fn 会弹 Emoji。 |
| **Windows** | **Fn 键不支持**——大多数笔记本的 Fn 在键盘固件层被截获（改变 F5→音量等），根本不发送 scan code 到 OS，`WH_KEYBOARD_LL` 也拿不到。默认改用 `Ctrl + Win`（Wispr Flow 默认）或 `Right Alt`（TypeLess 默认）。若用户希望 Fn 触发，指引用 **PowerToys Keyboard Manager** 把 Fn 映射到 F20–F24 后再绑定。左右修饰键在底层 `RegisterHotKey` API 不区分，需 low-level hook 才能区分。 |
| **Linux / Wayland** | 全局快捷键依赖 `xdg-desktop-portal GlobalShortcuts` 接口；部分发行版 / 桌面环境（较老的 GNOME / 精简 WM）可能无法注册。MVP 仅保证 X11 下完全可用，Wayland 下若不可用则禁用快捷键设置 UI 并给出解释。Fn 键取决于硬件——Framework / ThinkPad 部分型号会上报 `KEY_FN (464)`，其他机型放弃。 |
| **IME 组字态** | 用户正在输入法组字过程中按下全局快捷键，可能被 IME 吃掉；这是 OS 级行为，无法绕过。 |

## 录入组件的交互规范

前端录入 UI 必须遵守：

1. 点击字段进入录入态 → 先空转 **150 ms** 等待用户可能仍按住的鼠标相关 keyup 事件清零，然后开始捕获。
2. 录入态下按下任意**主键**（非纯修饰键）即判定完成，**整组一次性显示**（不是逐键拼装"Ctrl + ..."的动画）。录入组件统一使用 `event.code`（基于物理键位）而非 `event.key`（基于合成字符），避免 macOS 上 Option+字母产生 dead key（Opt+A = å）导致识别错乱，以及不同键盘布局（QWERTY/AZERTY/Dvorak）下字母位置差异。
3. 5 秒内无任何 keydown → 静默取消，恢复原值。
4. 录入期间 **Esc = 取消录入**（固定语义，不可把 Esc 作为快捷键内容；如需绑 Esc/Tab/Enter，设置里提供"允许特殊键"开关，默认关闭）。
5. 录入期间点击字段外 / 窗口失焦 > 1 秒 → 取消录入。
6. 字母 / 数字 / 方向键 / Enter / Tab / Backspace 等单键不允许独立绑定，录入时若无修饰键按下即拒绝；拒绝反馈为字段抖动 4px + 下方小字提示，**不弹 Dialog**。
7. **清除按钮嵌入录入按钮内部右侧**：hover 录入按钮任意位置时右端淡入 `×` 图标，点击 stopPropagation 以避免触发 enterRecording；`canClear=false`（如听写行）或 `value===null` 时不渲染该 × 按钮。不再提供"恢复默认 / 测试快捷键"的行级图标按钮——前者在整个快捷键区域底部（若后续需要恢复）统一入口提供，后者等测试诊断功能真正接入后再加回来。
8. 键位在三端的显示：macOS 用符号（`⌃⌥⇧⌘`），Windows/Linux 用文字（`Ctrl / Alt / Shift / Super`），由前端本地化层统一渲染。
9. 无障碍：字段 `role="button"`、`aria-live="polite"`、录入态变更通过文本（前缀 `"按下新快捷键："`）而非仅颜色传达；所有 Error/Warning 必须带图标 + 文本前缀（`ERROR:` / `WARNING:`）双冗余。

## Canonical 存储 schema

为保证跨平台迁移与显示本地化，持久化格式与显示格式分离：

```jsonc
// store 中的 hotkeys.json 结构（schemaVersion = 2）
{
  "schemaVersion": 2,
  "bindings": {
    // macOS 默认：Fn + Ctrl
    "dictate_ptt": { "kind": "modifierOnly", "mods": ["fn", "ctrl"],   "code": "" },
    // Windows / Linux 默认：Ctrl + Win|Super
    // "dictate_ptt": { "kind": "modifierOnly", "mods": ["ctrl", "meta"], "code": "" },
  },
  "distinguish_left_right": false,   // MVP 固定 false
  "allow_special_keys":     false    // 允许 Esc/Tab/Enter 作为键内容；MVP 默认 false
}
```

约束：
- `kind` 枚举：`"combo"` | `"modifierOnly"` | `"doubleTap"`。详见上文"通用规则"第 3 条。
- `mods` 数组按 `ctrl < alt < shift < meta < fn` 固定顺序排列，存储时归一化。
- `code` 使用 UI Events KeyboardEvent `code` 规范（`"Space"` / `"KeyA"` / `"F1"`），**与键盘布局无关**。`kind === "modifierOnly"` 或 `"doubleTap"` 时必须为 `""`。
- `meta` 跨平台抽象：macOS = Command（⌘），Windows = Win 键，Linux = Super。
- `fn` 仅 macOS 合法；Windows / Linux 保存时会被 `isLegalBinding` 拒绝。
- **schemaVersion 迁移**：v1 数据（无 `kind` 字段）在读取时由 `normalizeBinding` 自动补齐——`code === ""` → `modifierOnly`，否则 → `combo`。未知 schemaVersion 一律重置为平台默认。
- 显示层本地化：macOS 用符号 `⌃⌥⇧⌘ fn`、Windows 用 `Ctrl / Alt / Shift / Win / Fn`、Linux 用 `Ctrl / Alt / Shift / Super / Fn`，由前端 `formatBinding(binding, platform)` 统一渲染。`doubleTap` 前缀 `2×`（如 `2× ⇧`）。

## 实现时序（开发补充）

- **误触 300 ms 计时**：用单调时钟 `std::time::Instant` 从首次 keydown 事件接收时起算，与 cpal 采样启动时序无关。
- **热重载非原子窗口**：前端在执行 `unregister(old) → register(new)` 期间设置软锁 `hotkeyReloading = true`，期间收到的所有快捷键 trigger 全部 drop（仅 debug 日志记录，不弹错、不抖动 UI），锁释放后恢复。
- **Recording 中忽略另一听写键**：仅当前会话内存计数，无持久化；仅 debug build 打 `tracing::debug!` 日志。
