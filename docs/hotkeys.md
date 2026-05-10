# 快捷键规则

## 默认快捷键

四个 binding 的默认值按平台选取——**对齐行业标杆**（Wispr Flow / TypeLess / FreeFlow），保证首启即用、冲突概率最低：

| Binding ID | macOS | Windows | Linux | 形态 |
|---|---|---|---|---|
| `dictate_ptt`（听写） | `Fn + Ctrl(L)` | `Alt(L) + Win` | `Ctrl(L) + Super(L)` | modifierOnly |
| `translate`（翻译听写） | `Fn + Shift(L)` | `Ctrl(R)` | `Alt(L) + Super(L)` | modifierOnly |
| `show_main_window`（唤起主窗口） | `Shift(L) + Cmd(L) + O` | `Shift(L) + Win + O` | `Shift(L) + Super(L) + O` | combo |
| `open_toolbox`（打开 AI 工具） | `Shift(L) + Cmd(L) + T` | `Shift(L) + Win + T` | `Shift(L) + Super(L) + T` | combo |

> **Windows translate 为何用单 Right Ctrl？** 早期默认 `Shift + Win`（modifierOnly）会在按下 Shift+Win 的瞬间触发录音，与 Windows 自带 `Win+Shift+S`（截图）以及 PowerToys 的 `Win+Shift+V/H/C/?` 系列正面对撞——所有这些 combo 都被 translate 抢先一步起录。改成 `Right Ctrl` 单键后零冲突 PowerToys，代价是落 W3 软警告（吞 RCtrl 全部原生组合），但 RCtrl+? 在 Windows 上几乎无人使用，可接受。

> 标记 `(L)` = 必须左侧物理键；右侧不命中（详见"左右匹配"章节）。`Fn` 没有左右概念。**Win 键（meta）在 Windows 上不区分左右**：UI 上不渲染 `L`/`R` 角标，因为绝大多数 Windows 键盘只有左 Win，且产品上"Windows 键就是 Windows 键"。

| 行为 | 形态 | 可否自定义 | 可否清空 |
|---|---|---|---|
| 听写 | toggle（按一下开始 · 再按一下结束，全系统统一） | ✅ | ❌（必须保留绑定） |
| 翻译听写 | toggle | ✅ | ✅ |
| 唤起主窗口 | 单次触发 | ✅ | ✅ |
| 打开 AI 工具 | 单次触发 | ✅ | ✅ |
| 取消录音 | `Esc`（仅录音态生效，见下） | ❌ | ❌ |

> 早期版本听写 PTT / Toggle 各占一行，且 `mode` 字段支持 `hold`（按住说话）。现在合并为单一 `dictate_ptt`，全系统统一为 toggle 语义。`hotkeys` store 的 `normalizeBinding` 会自动丢弃 v1/v2 残留的 `dictate_toggle`、`mode` 字段。

> **听写为何用 modifier-only 而非 combo？** modifier-only（如 `Fn+Ctrl` 一起按住）触发肌肉记忆更轻，不用同时按 `Ctrl+Shift+Space` 三个键才能说话。三端主流语音输入产品共识。

## 通用规则

1. 所有可自定义快捷键**必须支持全局捕获**：在任何前台应用下都能触发。
2. 快捷键支持三种形态（`BindingKind`）：
   - **`combo`** —— 0+ 修饰键 + 1 主键（如 `Ctrl + Shift + Space`、单按 `F8`、单按 `Home`）。修饰键可省，但单按字母/数字/Space/标点等输入键会被硬拦（B7）；单按 F1-F12 会落软警告 W2。
   - **`modifierOnly`** —— 1+ 修饰键按住即触发（如 `Ctrl + Win`、`Fn + Ctrl`、单 `Fn`、单 `Option`）。听写的默认形态；单修饰键会落软警告 W3。
   - **`doubleTap`** —— 双击单个修饰键（如 `2× Right Shift`）。
3. **听写快捷键必须始终有绑定**：听写行的 Clear 按钮恒 disabled；用户只能改绑到别的键，不能清空到"未绑定"状态。
4. **左右修饰键严格区分**（v3 起）：
   - 录入时按用户实际按下的物理键写入 `modSides`（`Left Ctrl` ≠ `Right Ctrl`）。
   - 触发匹配也必须左右一致——绑了 `Left Ctrl + Left Alt + O`，按 `Right Ctrl + Right Alt + O` 不响应。
   - **存量数据迁移**：v2 → v3 升级时，所有非 fn 修饰键的 `modSides` 自动填 `"left"`，对齐"旧绑定一律视为左"的产品决策。`fn` 没有左右概念，永远不出现在 `modSides` 中。
   - UI 在 chip / Kbd 上以小角标 `L` / `R` 标识；显示与匹配语义保持一致。
5. 快捷键变更实时生效，内部执行 `unregister(old) → register(new)` 热重载，无需重启应用；变更时若正处于录音中，该次录音立即视为取消（cancelled）。

## 录入校验规则

> 录入完成时由 `isLegalBinding` + `findBindingConflict` 双重校验，违反即拒绝保存（红字 + 抖动）；命中"软警告"则保存但红字提示。**启动自检** `auditBindings` 也跑同一套规则，存量违规会立刻弹 `HotkeyConflictDialog` 让用户重录。

### 拦死（block）

| ID | 规则 | 理由 |
|---|---|---|
| **B1** | `modifierOnly` 至少 1 个修饰键 | 0 修饰键的 modifierOnly 没有触发源；单修饰键允许，但走 W3 软警告告知"会吞掉该键所有原生组合" |
| **B2** | `combo` 永远禁主键 = `Tab` / `Backspace` / `Delete` / `CapsLock` / `NumLock` / `ScrollLock` | 误触代价过高（Tab=焦点切换、Backspace/Delete=误删文本、Lock 系列 release 在多平台不可靠） |
| **B3** | `combo` 不能含 `fn` 修饰键 | macOS Carbon `RegisterEventHotKey` / Win `RegisterHotKey` 都不接受 Fn 修饰位；Rust 端 `parse_mods` 之前是静默丢弃 fn，让用户误以为生效——必须前端拦死 |
| **B4** | macOS 上 `doubleTap` 不能是 `Fn` | macOS 系统默认双击 Fn = 启动 Dictation，会先吞我们的事件 |
| **B5** | 主键不能是修饰键本身 | 历史规则，沿用 |
| **B6** | `Esc / Enter / Arrow*` 主键需 `allowSpecialKeys` 开关启用 | 默认拦截，避免普通用户误绑 |
| **B7** | 单按"输入键"必须配修饰键（A-Z / 0-9 / Space / 主键盘标点 / Numpad 数字） | 裸绑会让每次正常打字都触发——成本极高，软警告不够，硬拦 |
| **B8** | `fn` 修饰键仅 macOS 合法 | Windows / Linux 硬件层就拦了 |

### 跨 binding 冲突（block）

| ID | 规则 | UX 后果 |
|---|---|---|
| **C1** | 完全相等（kind + mods + code + modSides 全等） | 触发 replace flow（"已被 X 使用，是否替换？" + 8s 撤销 toast） |
| **C2** | 两个 `modifierOnly` 的 (mod, side) 集合互为真子集 | 递进激活会"幻影录音"——A=Ctrl+Alt 命中后再按 Shift，A 释放 + B=Ctrl+Alt+Shift 触发，相当于一次错误的短录音 |
| **C3** | `modifierOnly` ⊊ `combo.mods` 的 (mod, side) 集合 | 按 modifierOnly 已 active，再按主键 combo 触发——双触发 |
| **C4** | `doubleTap.mod` 类型与某个 `modifierOnly.mods` 任一 mod 相同 | 双击窗口与子集匹配会冲突 |

> **C1 vs C2-C4 的不同 UX**：C1 触发 replace flow（替换/取消/重录三按钮 + 撤销 toast）；C2-C4 直接进 conflict 状态显示对应 reason 文案，让用户选择替换或重录。所有路径文案走 `dialogs:hotkey_field.conflict_reason.<kind>`。

### 软提示（warn，不阻断）

| ID | 规则 | 提示 |
|---|---|---|
| **W1** | combo 命中已知系统快捷键（macOS: `Cmd+Q/W/H/M/Tab/Space`、`Cmd+Shift+3/4/5`、`Ctrl+Cmd+Q`、`Cmd+Option+Esc`；Windows: `Win+L/D/E/R/Tab/H/I/S`、`Alt+F4/Tab`、`Ctrl+Alt+Del`） | 该组合可能与系统常用快捷键冲突 |
| **W2** | 裸按 F1-F12（无修饰键） | F1-F12 在多数 Mac 默认是亮度 / 音量等系统功能键 |
| **W3** | `modifierOnly` 仅含 1 个修饰键 | 单修饰键会吞掉它的所有原生组合（如 Alt+Tab、Option+空格） |

## 启动自检

应用 boot 流程在 `syncBindings` 之后调用 `auditBindings(bindings, platform, allowSpecialKeys)`：

1. 对每条非空 binding 跑 `isLegalBinding` —— 命中 B1-B8 立即报。
2. 形态合法的再跑 `findBindingConflict` —— 命中 C1-C4 报第一个。
3. 一条 binding 可能违反多个规则，**只报第一个**（避免噪音；用户改完后下次启动会暴露下一个）。
4. 违规列表 push 到 `useUIStore.hotkeyConflicts`，触发 `HotkeyConflictDialog` 自动弹出：
   - 顶部用 `dialogs:hotkey_conflict.description_*` 通用文案（覆盖"系统占用"和"规则违规"两类成因）。
   - 中部列出每条 `{binding 名} — {具体 reason}`（reason 已渲染好的 i18n 文案）。
   - 内嵌 `HotkeyBinder filterIds={违规 id 列表}` 让用户在 Dialog 内直接重录。
5. 用户改完一条后 `setBinding` → `clearHotkeyConflict(id)` 自动从列表移除；全部清完 Dialog 自动关。

> 典型触发场景：v2 → v3 升级后存量绑定命中新规则（如用户曾手改成单 Option、子集冲突等）；Rust `apply_bindings` 注册失败也走同一个 Dialog。

## 按键行为

| 行为 | 规则 |
|---|---|
| 第一次按下 | 进入 Recording（前 300 ms 仅显示"准备中"悬浮态） |
| 第二次按下（**同 id**） | 结束录音，进入 Transcribing |
| 录音中按"另一种"激活键（**dictate_ptt ↔ translate**） | 仅 UTTERANCE 模式：切 `activeId` 不结束录音；REALTIME 模式：忽略 |
| 录音持续超过 SaaS realtime 会话 2 小时硬上限 | 服务端发 `closed{reason:"max_duration"}`，视为录音异常结束，history 标 failed |
| 第一次按下 < 300 ms 内立即再按一次 | 视为误触，悬浮条淡出，不调用大模型，不计入历史 |
| 录音期间 `Esc` | 立即取消录音，见下"Esc 处理" |
| 快捷键被其他应用占用 | 字段右侧显示冲突提示；仍尝试注册，失败时走 `HotkeyConflictDialog` |
| 录音期间按下不符合左右的物理键 | 不命中 binding，事件直接丢弃（既不 emit pressed 也不 emit released），与"按错键"等价 |

> 跨模式切换（dictate_ptt ↔ translate）的状态机细节、UI 反馈、REALTIME 不支持的原因见 [voice-input-flow.md §录音中切换模式](./voice-input-flow.md#录音中切换模式听写--翻译)。

## Esc 处理（状态化）

Esc 不注册为全局快捷键（否则会拦截用户在其他应用里的 Esc，造成骚扰）。实现方式：

1. 应用始终在后台挂一个全局 **键事件监听线程**（通过 `rdev` 实现），默认不对 Esc 做任何处理。
2. 仅当状态机处于 `Recording` 或 `Transcribing` 时，Rust 通过 `esc_capture_start` 临时注册 Esc 为全局快捷键，**吞掉前台应用的 Esc**——避免用户在 Cursor/Vim/IME 里按 Esc 取消录音时同时把编辑器的 Esc 行为触发。
3. 状态机离开 Recording/Transcribing 时立即 `esc_capture_stop`——其他应用的 Esc 行为完全不受影响。
4. Esc 取消 + 大模型已返回结果的情况：**保留转写文字到历史（标记 cancelled），但不执行注入**。详见 [history.md](./history.md#cancelled-状态规则)。

悬浮条上的 `×` 按钮和 `Esc` 行为完全等价。

## 录入态 Esc 拦截（Dialog 内）

`HotkeyBinder` 在 Dialog 内被使用时（`SettingsDialog` / `HotkeyConflictDialog`），录入态按 Esc 必须**只退出录入回到 idle**，不能让 base-ui Dialog 的 `useDismiss` 把整个 Dialog 关掉。

实现：

1. `enterRecording()` 同步调用 `attachDomListeners()`——在 `setState(recording)` 之前就把 `document.addEventListener("keydown", ..., {capture: true})` 挂上。**不依赖 useEffect 调度**——之前 listener 注册放在 `useEffect [state.kind]` 里，React commit/effect 调度有微小延迟窗口，用户在窗口内按 Esc 会漏到 base-ui useDismiss 的 document bubble listener，把 Dialog 关掉。
2. listener 在 capture phase 收到 keydown 后立即调 `e.preventDefault() + e.stopPropagation() + e.stopImmediatePropagation()`，事件不再冒泡。base-ui useDismiss 在 document **bubble** phase 监听 keydown，被 capture phase 的 stopPropagation 阻止。
3. 离开录入态的所有路径（`exitToIdle` / `flashError` / conflict 分支 / 4s 超时 / 组件卸载）都同步调 `detachDomListeners()`，避免残留 listener。

## 冲突检测

### A. 应用内冲突（强约束）

录入完成时跑 `findBindingConflict`：

| Reason | 触发场景 | UI |
|---|---|---|
| `equal` | 完全相等（kind + mods + code + modSides 全等） | "已被 X 使用" + Replace/Rebind/Cancel 三按钮，替换走撤销 toast |
| `subset_modifier_only` | 两个 modifierOnly 互为真子集 | "与 X 修饰键集合互为子集，会出现幻影录音" |
| `subset_combo` | modifierOnly ⊊ combo.mods | "与 X 修饰键集合互为子集，按下时会双触发" |
| `double_tap_overlap_modifier` | doubleTap 与 modifierOnly 共用同种 mod | "与 X 共用同一颗修饰键，双击窗口会冲突" |

撤销 buffer 落盘：最近一次替换操作的 `{被替换项, 原值, 新值, 时间戳}` 写入 `store` 的 `undo_buffer`；应用重启后若时间戳距今 < 8 秒仍可撤销，Toast 在主窗口启动时重新显示剩余秒数。

### B. 系统 / 第三方应用冲突（弱警告）

| 情形 | 处理 |
|---|---|
| 插件 `register()` 返回 Err | Rust emit `openspeech://hotkey/register-failed{id, error}`，前端 push 到 `hotkeyConflicts`，`HotkeyConflictDialog` 弹出列出 |
| 注册成功但后台"静默失败"（macOS 常见） | 通过"测试快捷键"诊断工具发现；见下 |
| 已知系统保留组合（W1） | 录入完成后字段下方红字提示，**不阻止保存** |

### C. 自诊断工具（计划内）

设置页"键盘快捷键"区域每个字段旁有 `▶ 测试` 图标。点击后倒计时 5 秒 Dialog："请按一次 `Ctrl + Shift + Space`..."：

- 5 秒内收到回调 → "✓ 工作正常"
- 超时未收到 → "⚠ 未收到按键事件，可能被其他应用拦截。建议更换组合或检查系统权限"

应用启动后还会在后台跑一次 **被动自检**：注册完所有快捷键后，若任一快捷键在首次预期触发时机（由用户真实按键触发）未产生回调，内部静默记录但**不主动弹提示**，直到下次打开设置页才在对应字段上显示"未检测到回响，点此诊断"。

## 平台限制

| 平台 | 限制 |
|---|---|
| **macOS** | `Fn` 键通过 `rustdesk-org/rdev` fork 的 `Modifiers::FN` 原生支持。需 Accessibility 权限（首启弹窗）。Option+字母会产生 dead key，录入组件必须用 `event.code` 而非 `event.key`。**蓝牙外接键盘的 Fn 多数被硬件层吃掉，系统 API 读不到——这是硬件层限制，无解**。提示用户在 Settings → Keyboard → "Press fn key to" 设为 "Do Nothing"，否则 Fn 会弹 Emoji。 |
| **Windows** | **Fn 键不支持**——大多数笔记本的 Fn 在键盘固件层被截获（改变 F5→音量等），根本不发送 scan code 到 OS，`WH_KEYBOARD_LL` 也拿不到。默认改用 `Alt + Win` 或 `Right Alt`（TypeLess 默认）。若用户希望 Fn 触发，指引用 **PowerToys Keyboard Manager** 把 Fn 映射到 F20–F24 后再绑定。**左右修饰键**通过 `VK_LCONTROL/VK_RCONTROL/VK_LSHIFT/VK_RSHIFT/VK_LMENU/VK_RMENU/VK_LWIN/VK_RWIN` 细粒度 VK + `GetAsyncKeyState` 校准，可精确区分；但 UI 不给 Win 键加 L/R 角标——产品上"Windows 键就是 Windows 键"。 |
| **Linux / Wayland** | 全局快捷键依赖 `xdg-desktop-portal GlobalShortcuts` 接口；部分发行版 / 桌面环境（较老的 GNOME / 精简 WM）可能无法注册。MVP 仅保证 X11 下完全可用，Wayland 下若不可用则禁用快捷键设置 UI 并给出解释。Fn 键取决于硬件——Framework / ThinkPad 部分型号会上报 `KEY_FN (464)`，其他机型放弃。**左右修饰键校准**当前 fallback 到 rdev 维护的 pressed 缓存（macOS / Linux），Windows 用 OS 同步 API。 |
| **IME 组字态** | 用户正在输入法组字过程中按下全局快捷键，可能被 IME 吃掉；这是 OS 级行为，无法绕过。 |

## 左右匹配（D2 实现细节）

OpenSpeech 的快捷键有两条互不相同的执行路径，左右区分的实现也不同：

### modifierOnly 路径（PTT、translate）

走 `rdev::listen` 自己解析事件：
- `rdev_key_to_mod_side(key) → ModSide` 把 `Key::ControlLeft / ControlRight / ShiftLeft / ShiftRight / Alt / AltGr / MetaLeft / MetaRight / Function` 直接区分出 (Kind, Side)；`fn` 单独 `ModSide::Fn`。
- `state.pressed: HashSet<ModSide>` 维护实时按住集合。
- 匹配时 `binding.expected == state.pressed`（精确相等）。
- Windows 用 `query_real_modifier_state()` 通过 `VK_LCONTROL / VK_RCONTROL / ...` 等细粒度 VK 校准，避免 LL hook 漏报；macOS / Linux 当前用 rdev 缓存兜底。

### combo 路径（show_main_window、open_toolbox）

走 `tauri-plugin-global-shortcut`（macOS Carbon `RegisterEventHotKey` / Windows `RegisterHotKey`）：
- 这两个 OS API **不接受左右区分**——OS 注册的是"Control 修饰位被按下"，handler 拿不到具体哪一颗物理键。
- 我们采用**OS 注册 + handler 二次校验**方案：每条 combo 的 `expected: HashSet<ModSide>` 跟 BindingId 一起存进 `HotkeyState.active`；handler 触发时调 `modifier_only::current_pressed()` 拿到当前真实按键集合，校验 `expected.is_subset(actual)`，不符就静默丢弃事件（不 emit / 不 overlay / 不 cue）。
- 这意味着 OS 注册名额仍被占用——绑了 `Left Ctrl + Left Alt + O` 时其他应用想用 `Right Ctrl + Right Alt + O` 仍会冲突，但在 OpenSpeech 范围内左右严格生效。

### 不支持左右的 mod

`fn` 没有左右概念，永远不出现在 `modSides` 中。Windows / Linux 硬件层不可达 fn，所以无影响。

## 录入组件的交互规范

前端录入 UI 必须遵守：

1. 点击字段进入录入态 → 先空转 **150 ms** 等待用户可能仍按住的鼠标相关 keyup 事件清零，然后开始捕获。
2. 录入态下按下任意**主键**（非纯修饰键）即判定完成，**整组一次性显示**。`event.code`（基于物理键位）而非 `event.key`，避免 macOS 上 Option+字母产生 dead key、不同键盘布局的字母位置差异。
3. **左右捕获**：录入时按 `ControlLeft` / `ControlRight` / `AltLeft` / `AltRight` / `ShiftLeft` / `ShiftRight` / `MetaLeft` / `MetaRight` 把对应 mod 的 side 写入 `everPressedSidesRef`；`finishCandidate` 时 `pickSides` 只取本次 mods 集合内的 entry。fn 不进 `modSides`。
4. 4 秒内无任何 keydown → 静默取消，恢复原值。
5. 录入期间 **Esc = 取消录入**（固定语义，不可把 Esc 作为快捷键内容；如需绑 Esc/Enter/Arrow，设置里提供 `allowSpecialKeys` 开关，默认关闭）。
6. 录入期间点击字段外 / 窗口失焦 > 1 秒 → 取消录入。
7. 录入完成时按 `isLegalBinding`（B1-B8）+ `findBindingConflict`（C1-C4）双重校验：
   - 形态非法 → 字段抖动 4px + 红字 reason，**不弹 Dialog**。
   - 跨 binding 冲突 → 进入 conflict 状态，显示对应 reason 文案 + Replace/Rebind/Cancel 三按钮。
   - 软警告（W1/W2）→ 保存，但 idle 行下方显示红字 warning（`getBindingWarnings` 返回的 i18n key 列表）。
8. **清除按钮嵌入录入按钮内部右侧**：hover 录入按钮任意位置时右端淡入 `×` 图标，点击 stopPropagation 以避免触发 enterRecording；`canClear=false`（如听写行）或 `value===null` 时不渲染。
9. **键位显示统一**走 `src/lib/hotkeyVisual.tsx`：
   - `modIcon(mod, platform, size)` —— macOS 用符号 `⌃⌥⇧⌘`，Windows / Linux 仅 meta 键带 logo 图标，其他键纯文字。
   - `MAIN_ICON` 仅登记 icon ≠ formatCode 输出的字符（Enter ↵、Escape ⎋、Tab ⇥、Delete ⌦、Space ␣）；箭头键 / Backspace 等 icon 与文字相同的项 **不**登记，避免渲染时 icon 与 label 显示同一字符两次。
   - 左右标识：mod chip 内在文字前加 `L` / `R` 小角标（`text-[0.7em] font-bold opacity-70`）。
   - `keyEventLabel(code, platform)` 把 KeyboardEvent.code 翻译成 platform-aware label（macOS 上 `AltLeft` → `"Left Option"` 而非 `"Left Alt"`），用于 `useKeyPreview` fallback 显示。
10. 无障碍：字段 `role="button"`、`aria-live="polite"`、录入态变更通过文本（前缀 `"按下新快捷键："`）而非仅颜色传达；所有 Error/Warning 必须带图标 + 文本前缀（`ERROR:` / `WARNING:`）双冗余。

## Canonical 存储 schema

为保证跨平台迁移与显示本地化，持久化格式与显示格式分离：

```jsonc
// store 中的 hotkeys.json 结构（schemaVersion = 3）
{
  "schemaVersion": 3,
  "bindings": {
    // macOS 默认：Fn + Left Ctrl
    "dictate_ptt": {
      "kind": "modifierOnly",
      "mods": ["fn", "ctrl"],
      "code": "",
      "modSides": { "ctrl": "left" }   // fn 没有左右概念，不出现在 modSides
    },
    "translate": {
      "kind": "modifierOnly",
      "mods": ["fn", "shift"],
      "code": "",
      "modSides": { "shift": "left" }
    },
    "show_main_window": {
      "kind": "combo",
      "mods": ["ctrl", "alt"],
      "code": "KeyO",
      "modSides": { "ctrl": "left", "alt": "left" }
    },
    "open_toolbox": {
      "kind": "combo",
      "mods": ["ctrl", "alt"],
      "code": "KeyT",
      "modSides": { "ctrl": "left", "alt": "left" }
    }
  },
  "distinguishLeftRight": true,   // v3 起恒为 true，字段保留兼容性
  "allowSpecialKeys":     false   // 允许 Esc/Enter/Arrow 作为键内容；默认关闭
}
```

约束：
- `kind` 枚举：`"combo"` | `"modifierOnly"` | `"doubleTap"`。
- `mods` 数组按 `ctrl < alt < shift < meta < fn` 固定顺序排列，存储时归一化（`normalizeMods`）。
- `code` 使用 UI Events KeyboardEvent `code` 规范（`"Space"` / `"KeyA"` / `"F1"`），**与键盘布局无关**。`kind === "modifierOnly"` 或 `"doubleTap"` 时必须为 `""`。
- `meta` 跨平台抽象：macOS = Command（⌘），Windows = Win 键，Linux = Super。
- `fn` 仅 macOS 合法；其它平台保存时被 `isLegalBinding` 拒绝（B8）。
- `modSides` 是稀疏 map：每个非 fn 修饰键的 side（`"left"` / `"right"`）；缺失项视为 `"left"`。
- **schemaVersion 迁移**：
  - v1 → v2：`normalizeBinding` 按 `code === ""` 推断 `kind`。
  - v2 → v3：`normalizeBinding` 给 mods 中每个非 fn 修饰键自动补 `modSides[mod] = "left"`，对齐"旧绑定一律视为左"产品决策。
  - 未知 schemaVersion 一律重置为平台默认。
- 显示层本地化由 `formatMod` 统一渲染：macOS = `Ctrl / Option / Shift / Cmd / fn`、Windows = `Ctrl / Alt / Shift / Win / Fn`、Linux = `Ctrl / Alt / Shift / Super / Fn`。`doubleTap` 前缀 `2×`；左右用 chip 内 `L`/`R` 小角标渲染（不写入 label 文字）。**例外**：`meta`（Windows = Win 键）在 Windows 平台不渲染 L/R 角标——`hotkeyVisual.shouldShowSide` 单独拦截，因为产品上"Windows 键只有一个"。

## 实现时序（开发补充）

- **误触 300 ms 计时**：用单调时钟 `std::time::Instant` 从首次 keydown 事件接收时起算，与 cpal 采样启动时序无关。
- **热重载非原子窗口**：前端在执行 `unregister(old) → register(new)` 期间设置软锁 `hotkeyReloading = true`，期间收到的所有快捷键 trigger 全部 drop（仅 debug 日志记录，不弹错、不抖动 UI），锁释放后恢复。
- **Recording 中忽略另一听写键**：仅当前会话内存计数，无持久化；仅 debug build 打 `tracing::debug!` 日志。
- **左右二次校验竞态**：combo handler 触发瞬间到读 `modifier_only::current_pressed()` 之间有 µs 级窗口，rdev 可能还没更新 pressed 集合。Windows 用 OS 同步 API（`GetAsyncKeyState`）规避；macOS / Linux 实测 rdev 缓存与 OS 触发延迟 < 1ms，可接受。
- **rdev pressed 自愈**：App 长时间空闲后 macOS 会让 CGEventTap 进入低功耗，恢复时偶尔丢一个 release 事件。`modifier_only.rs` 在每次事件入口判断"距上次事件 > 30 秒"则 reset `pressed` / `active_ids`，避免幽灵 modifier 卡住下一次按下被误算成多键命中。
