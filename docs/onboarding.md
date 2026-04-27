# 首次启动向导

首次启动引导用户完成最少配置以跑通"按快捷键说话 → 文字插入"的核心闭环。

## 触发时机

1. 应用启动时检查 `store` 的 `onboarding.completed` 标志；未 true 则弹出向导。
2. 设置页 → 关于 → "重新运行首次向导"提供**可重入入口**；用户可随时完整再走一遍。
3. 向导是**全屏 Dialog**（覆盖主窗口内容，不可点击外部关闭），但每一步都可 "稍后" / "跳过"（两者语义不同，见下表）。
4. 每一步都有 "上一步 / 下一步"；完成第 4 步或任一步点 "完成向导" 后设置 `onboarding.completed = true`。

### "稍后" vs "跳过" 术语定义（全文统一）

| 按钮 | 行为 | `onboarding.completed` | 下次启动 |
|---|---|---|---|
| **稍后** | 关闭向导，但**本步未完成**的状态保留 | `false` | **仍会弹**向导，从首个未完成 blocking 步骤继续 |
| **跳过** | 关闭向导或跳到下一步，**标记本步为"主动放弃"** | 视整体进度而定；若剩余步骤全 skippable 则 `true` | 不再自动弹 |
| **下一步** | 本步完成，进入下一步 | — | — |
| **完成向导** | 标记整个向导完成 | `true` | 不再自动弹 |

本文档后续章节描述每一步时统一使用上述词汇，不再出现"稍后处理/稍后再配"这类混用。

### Blocking vs Non-Blocking 步骤

| 步骤 | 类型 | 原因 |
|---|---|---|
| Step 1 欢迎 | 非 blocking | 仅展示，可随时跳过 |
| Step 2 麦克风 | **blocking** | 不授权则所有语音功能无法使用 |
| Step 3 STT 端点 | 非 blocking | 允许延后，主界面挂黄色横条 |
| Step 4 试一次 | 非 blocking | 仅演示，不影响功能可用性 |

`completed=false` 时下次启动从**第一个未完成的 blocking 步骤**起；其 fall-through 逻辑：已完成 Step 2 → 直接跳到 Step 3；Step 3/4 从未走过则再走一次；Step 1 已看过则跳过。

## 4 步

### Step 1/4 · Welcome（欢迎）

内容：一句话介绍 + 展示默认快捷键 + 按钮"开始使用"。

- 本步**不要求用户真按快捷键**。理由：此时麦克风未授权，真按会失败并教育用户"按了没反应"；与第 4 步的测试体验冲突。
- 仅视觉展示：`Ctrl + Shift + Space` = 听写 / `Ctrl + Shift + A` = 问 AI / `Ctrl + Shift + T` = 翻译，使用 `Kbd` 键帽样式；右侧链接"我想换成别的组合"→ 跳到 Step 1.5（可选）或直接在此步提供快捷键编辑入口。

底部按钮：`下一步`（右）、`稍后`（左）。

### Step 2/4 · Microphone（麦克风权限）· 必选

内容：解释为什么需要麦克风 + 权限状态 + "授权"按钮。

- 调用平台 API 检查当前麦克风权限状态：
  - macOS: `AVCaptureDevice.authorizationStatus(for: .audio)`
  - Windows: 读 `Settings → Privacy → Microphone`
  - Linux (X11): 假定授权（取决于 PulseAudio/PipeWire）
- 状态 = `authorized` → 显示 ✓ + 自动进入 Step 3。
- 状态 = `notDetermined` → 按钮"授权"触发系统弹窗。
- 状态 = `denied` → 显示"已拒绝"+ "前往系统设置"按钮直达权限页 + 平台特定"重置步骤"（macOS 展示 `tccutil reset Microphone` 截图）。
- **本步 blocking，不提供"跳过"**：按钮为"稍后"（关闭向导，保持 `completed=false`，主界面顶部挂红色横条"麦克风未授权，点击修复"直到授权成功）。
- macOS 同时引导 Accessibility 权限（用于 enigo 键盘注入）：次要区块，显示状态 + "前往授权"链接，但允许用户"稍后授权"——注入时若未授权会自动降级到剪贴板。

### Step 3/4 · Model（STT 端点配置）· 可跳过但持久提示

内容：提示 OpenSpeech 不自带模型，用户需填入自己的 REST STT 端点。

字段：
- `URL`（必填，`https://...`）
- `API Key`（必填，写入 Keychain；输入框默认 type=password）
- `模型名称`（可选）
- 底部"测试连接"按钮：发送 1 秒静音样本验证连通性；成功显示 ✓，失败显示具体错误（网络 / 401 / 超时 / 端点格式错误）

**预设模板**（下拉选项）：`Groq / OpenAI Whisper / Deepgram / 自定义`，选中后自动填入对应的 URL 模板，用户只需粘贴 Key。

- 本步提供"跳过"按钮：用户明确表示后面再配，`completed=true`，但主界面挂一条**黄色**持久横条 "未配置 STT 端点，点击配置"，直到用户配完。
- 不测试连接就想"下一步"：提示"未测试连接，是否仍继续？"，二次确认。

### Step 4/4 · Try It（试一次）

**强制 AUTO 分句模式**：进入本步必须将 ASR 分句模式临时覆盖为 `AUTO`（服务端 VAD），离开本步立即恢复用户原值。

- 用户全局默认是 `MANUAL`（push-to-talk 场景下更准更便宜，见 `docs/settings.md` / settings.ts 注释）。
- 但 `MANUAL` 不发 partial 事件——按下快捷键到松手前 `liveTranscript` 一直为空字符串，本步面板的"实时转写"区会一直是 placeholder，用户会以为实时输出功能坏了 / 被 mute 了 / 没在录音。
- 解法：StepTryIt 挂载时调 `useRecordingStore.setSegmentModeOverride("AUTO")`，卸载时回 `null`。`getEffectiveSegmentMode()` 优先读 override，故只影响 onboarding，不污染用户的 `settings.general.asrSegmentMode`。
- 不要换成"直接修改用户 settings 然后再改回去"——任何中途崩溃 / 路由跳转 / 父组件强卸载都会留下错配。

内容：在向导窗口内嵌一个带 placeholder "Click here and try..." 的大号 `<textarea>` + 倒计时指示。

**关键：焦点循环的 override 机制**

问题：voice-input-flow.md 规则"注入目标 = 按下快捷键时快照的焦点应用 + 焦点输入框"在 Step 4 下不适用——向导窗口本身就是前台，用户可能还没 focus 到 textarea。

解法（实现规约）：

1. 进入 Step 4 时向导强制 `textarea.focus()`，四周加 accent 色 pulse 光晕。
2. 设置全局 flag `onboardingOverride = true`（由 Rust 后端侧维护）。
3. 注入管线在此 flag 下**跳过**焦点快照，固定注入到该 textarea（通过前端 `window.postMessage` 传递文本，textarea 自行 append）。
4. 用户触发快捷键瞬间若向导**非前台**（用户切走看别的）→ 弹 Toast "请先点击向导内文本框" 并**不进入 Recording**。
5. Step 4 流程结束（完成 or 跳过）后立即 `onboardingOverride = false`。

结果体验：

- 用户按住默认快捷键说话 → 悬浮录音条出现（跟正常使用一致）。
- 松开后文字写入向导内 textarea。
- 成功后 textarea 显示转写结果 + 下方 ✓ "配置完成，可以开始使用了" + 按钮 "完成向导"；同时提示 "实际使用时光标在哪，文字就写到哪"以避免用户形成"只能写到这个框"的误解。
- 失败（未配 STT / 网络 / 权限）：显示用户话术错误 + 一键跳回对应步骤修复。

- 本步提供"跳过"按钮直接完成向导。

## 可重入

- 设置 → 关于 → "重新运行首次向导" 按钮，清空 `onboarding.completed` 并立即重开。
- 若用户在某步点"稍后"，下次启动仍从 **第一个未完成的 blocking 步骤**继续（例如上次跳过了 Step 2，下次从 Step 2 开始）。

## 持久横条（主界面 fallback）

用户跳过某些步骤后，Layout 顶部展示一条横条，直到依赖满足为止：

| 情况 | 横条颜色 | 文案 | 点击 |
|---|---|---|---|
| 麦克风未授权 | 红 | `麦克风未授权，点击修复` | 直达系统权限页 |
| Accessibility 未授权（macOS） | 黄 | `辅助功能未授权，键盘注入将降级为剪贴板` | 直达系统权限页 |
| STT 端点未配置 | 黄 | `未配置 STT 端点，点击配置` | 打开设置 → STT 区块 |
| 多项同时存在 | 按最严重色 | 聚合为"待修复 N 项"，点击展开列表 | 展开 |

## 视觉规范

- TE 风：方角、`bg-te-bg`、mono 大标题 `01/04` → `04/04`、accent 色进度条。
- 每步顶部一条等高（约 3 px）`bg-te-gray` + `bg-te-accent` 进度填充。
- 关键按钮：主 = accent 底 + `text-te-accent-fg`；次 = transparent + border `te-gray`；跳过 = `text-te-light-gray` 下划线链接样式。
- 动画：步骤间过渡用 `framer-motion` 的 `AnimatePresence`，左右滑出 200 ms，非 bounce。

## 非目标（MVP 不做）

- 向导中加入高级设置（快捷键自定义、音频设备选择）——这些都在主设置页解决。
- 记账户登录/订阅流程——开源 BYO-Model 版本不走这条。
- 多语言 i18n——按 SKILL.md 当前阶段中文硬编码。
