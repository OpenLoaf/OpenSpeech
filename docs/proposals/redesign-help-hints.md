# 重新设计帮助提醒系统（方向 B：渐进式教学层）

> 状态：提案 · 待 review · 一旦确认即按 P1-P5 阶段化交付。
> 落地后本文应归档；最终 spec 同步到 [`docs/hints.md`](../hints.md) / [`docs/onboarding.md`](../onboarding.md) / 新增 `docs/help-center.md`。

## 为什么改

当前 OpenSpeech 把"教会新用户"几乎全压在一次性 Onboarding 上，而 Onboarding 又被"过权限 + 强制登录"占满；真正的"我能用它做什么 / 现在该按什么键 / 刚才结果去哪里了"基本靠用户自学。Hints 系统设计本该补这个 gap，但只挂了 2/3、用户还不能管理它，导致：

1. **firstResultConfirm 注册了 + i18n 写了，却没有挂载点** — 注入到外部 App 的文本对盯着主窗口的新手完全不可见
2. **production 用户无任何入口**关掉提示气泡、重跑入门引导、查快捷键速查
3. **StepLogin 没有 skip** + recording gate 要求登录 → 注重隐私的新手陷入死局
4. **首次按热键看起来像卡死**：默认 UTTERANCE 模式录音中无流式回显，StepTryIt 临时改 REALTIME 又跟真实体验割裂
5. **ESC 单按删录音** → novice 误按就丢首录
6. **浮窗在主窗口聚焦时自动隐藏** → 新手第一次根本看不到这个核心 UI

详细诊断见会话历史中的 agent team 三份报告（现状清单 / 旅程模拟 / 竞品研究）。

## 设计原则

1. **从"3 条孤立气泡"升级为"里程碑驱动的事件序列"** — 每条提示对应一个用户"学会"事件，按旅程顺序解锁
2. **just-in-time**：贴在动作那一刻，不前置说教（避免 Wispr Flow 的不可跳过 tour anti-pattern）
3. **永远可关 / 永远可重跑**（user-facing，不再 dev-only）
4. **同一面板同一时刻只出一条**（防堆叠；按优先级排序）
5. **Layer 0 passive learning 永驻**（关不掉）：快捷键 glyph 印在每个按钮旁，关掉提示气泡也仍能学（Raycast 模式）

## 信息架构 — 三层

```
Layer 0  passive learning   ── 关不掉，永远在
         · 主窗 action button 旁印快捷键 glyph
         · 当前 hotkey + 模式 badge 加 hover tooltip
         · Tray menu label 直接写 "Hold {hotkey} to dictate"

Layer 1  contextual hints   ── 8 条里程碑 hint，可关、可重置
         · 单条 ✕ + 全局 toggle + 一键重置（用户可见）
         · 同面板同时刻只出一条（按优先级排）

Layer 2  help center        ── 用户主动求助入口
         · 设置加 Help tab：快捷键速查 / 重跑 onboarding /
           重置提示 / 反馈 / GitHub
         · 主窗右上角 "?" 圆按钮 → deeplink 到 Help tab
```

## 8 条里程碑 hint

把当前 3 条扩展到 8 条；每条单次只打扰一两秒，但覆盖完整旅程。

| # | HintId | 类别 | 触发条件 | 文案要点 | 学会判定 | 阈值 | autoHide |
|---|---|---|---|---|---|---|---|
| M1 | `recordingControls` | action | 进入 `recording`/`preparing` ≥ 500ms | 松开结束 · 长按 ESC 取消 | 累计成功录音 N 次 | 3 | 5000 ms |
| M2 | `firstResultConfirm` | confirm | **全局**首次出非空 result | ✓ 已输入到当前光标位置 · 编辑修改 | 点 ✓ 或 ✕ | 1 | 8000 ms |
| M3 | `overlayPurpose` | confirm | 浮窗首次显示 | 12s 展开教学态：宽 200→320，附说明 + ✕ | 倒计时结束或主动 ✕ | 1 | 12000 ms |
| M4 | `resultActions` | action | 进入 result 后 300ms | ⌘C 复制 · 编辑 · 润色 · 翻译 | 累计点任一按钮 N 次 | 3 | 6000 ms |
| M5 | `polishScenario` | action | 首次点 polish | 试试场景：日常 / 邮件 / 代码评论… | 切换任一场景或 ✕ | 1 | 8000 ms |
| M6 | `escCancelExplain` | confirm | 首次 ESC 长按取消后 | 下次完成录音直接松开热键即可，不用按 ESC | 显示过即标记 | 1 | 6000 ms |
| M7 | `overlayDismiss` | action | 浮窗首次出现的同一会话 | 浮窗内 micro-tip：✕ 取消 · ✓ 完成 · 双击折叠 | 用户交互过 ✕/✓ 任一 | 1 | n/a |
| M8 | `weekOneFollowup` | confirm | 首次启动 ≥ 7 天的那次开窗 | 用了一周了。看看进阶：自定义词典 / Polish 场景 / BYOK | 显示过或 ✕ | 1 | n/a (manual) |

**优先级（同时刻并发时只出一条）**：M2 > M6 > M5 > M1 > M4 > M8

**M3 / M7 在浮窗内独立渲染**，与主窗 M1/M2/M4 不抢位。

## Onboarding 改造

### StepLogin 加"稍后再说"

文件：`src/pages/Onboarding/StepLogin.tsx:83-99`

- 在 WeChat / Google 按钮下方加链接式按钮："稍后再说（接入自己的 ASR / AI 服务）"
- 点击后：`dictation.mode` 自动切 `custom` + `aiRefine.mode` 切 `custom` + 跳 Step3
- 完成 onboarding 入主窗后：Settings → Dictation 首屏加 banner "你需要先配一个 STT provider 才能开始使用 → 立即配置"，banner dismiss 后存到 settings 不再出现

### StepTryIt 用真实模式

文件：`src/pages/Onboarding/StepTryIt.tsx:41-46`

- 取消临时强制 REALTIME；保留用户的真实 UTTERANCE 设置
- 屏底加一句副文："录音中不显示文字，松开后才出结果 —— 这样 AI 拿到完整上下文，整理更准"
- 加可折叠的 "为什么这比系统输入法更准" 1 行展开 3 行

### 完成后的反悔通道

`onboardingCompleted=true` 后通过 Settings → Help → "重跑入门引导" 按钮可重新进入（复用现成的 navigate `/onboarding`）。

## Settings 改造

### General tab 顶部新增"教学与提示"折叠

```
┌─ 教学与提示 ─────────────────────────────┐
│  [✓] 显示交互提示                            │
│  [ 重置提示 ]    未学会 3 / 8               │
└────────────────────────────────────────┘
```

控件复用现有 store action：`setShowHints` / `resetAllHints`。"未学会"用 `ui.hints` 聚合统计。

### 新增 Help tab（独立 nav 项，紧贴 About 上方）

内容：

- 快捷键速查表（按当前 binding 渲染：dictate / translate / cancel / edit / polish / ...）
- `[ 重跑入门引导 ]` 按钮 → navigate `/onboarding` + 重置 `onboardingCompleted`
- `[ 重置交互提示 ]` 按钮 → 调 `resetAllHints`
- `[ 反馈 ]` 按钮 → 调 `openFeedback`
- `[ GitHub ]` 链接 → 现有 GitHub 地址

About tab **保持不变**（版本 / 更新 / 法律），不与 Help 合并。

### dev-only DevHintsTab 保持不变

仅 QA / 内部使用，不影响 production。

## 主窗 / 浮窗改造

### 主窗 `HotkeyDictationCard.tsx`

- 右上角加 16px "?" 圆按钮 → deeplink Help tab
- 当前两个 mono badge（"UTTERANCE" / "AI REFINE"）加 hover tooltip，每个一句话解释
- 顶部 hint 容器需要按上面"优先级"排序，同时刻只渲染一条（新增 `useTopHint(['firstResultConfirm', 'recordingControls', 'resultActions'])` helper）

### 浮窗 `pages/Overlay/index.tsx`

- 首次显示进入 12s 教学态：宽 200→320，挂副文 "你正在用 OpenSpeech 在当前 App 输入"
- 自带 ✕ + 倒计时；用户先关或倒计时结束 → 收缩回 200×36
- 后续每次进入 recording 都按现状 36 高度
- 浮窗内的 ✕/✓ 按钮首次出现时贴 micro-tip（M7 overlayDismiss）

## Layer 0 — passive learning（关不掉）

- 主窗每个 result action button 旁印 keybinding glyph（mac ⌘C / ⌘↵ / ⌘P；Win/Linux 用 Ctrl+ 同步）
- Tray menu 第一项改为 `Hold {hotkey} to dictate`（label 直接当 teach，仿 macOS Dictation）

## ESC 行为改造（breaking）

- 现状（`recording.ts:2503`）：单按 ESC 即 cancel
- 改为：长按 300ms 才 cancel；单按是 noop
- 配套 escCancelExplain（M6）首次解释一次

**影响**：老用户肌肉记忆变化。Risk 通过 M6 在首次"按了 ESC 但发现没反应"时主动 toast 抹平。

## 阶段化交付

| Phase | 内容 | 影响文件（主要） | 时长估 |
|---|---|---|---|
| **P1** | 修 firstResultConfirm 挂载 + StepLogin 加 skip + Help tab + General 教学控件 | `src/components/hints/FirstResultConfirmHint.tsx` (新) · `src/components/HotkeyDictationCard.tsx` · `src/pages/Onboarding/StepLogin.tsx` · `src/pages/Help/` (新) · `src/components/SettingsContent.tsx` · i18n 三语 | 2-3 天 |
| **P2** | overlayPurpose + ESC 长按取消 + escCancelExplain；P2 期间查 Rust inject 路径决定 firstResultConfirm 文案是否升级"已输入到「{App}」" | `src/pages/Overlay/index.tsx` · `src/stores/recording.ts` · hints registry · i18n | 1-2 天 |
| **P3** | polishScenario + weekOneFollowup + Layer 0 keybinding glyph + tray menu label + firstResultConfirm "编辑修改"接入 Cmd+Shift+E | `src/components/HotkeyDictationCard.tsx` · `src/components/PolishScenarioRow.tsx` (新) · Rust tray menu · i18n | 2-3 天 |
| **P4** | StepTryIt 改回真实模式 + 副文 + Help tab "重跑 onboarding" 接通 + Dictation 首屏 banner | `src/pages/Onboarding/StepTryIt.tsx` · `src/pages/Help/` · `src/components/SettingsContent.tsx` | 1 天 |
| **P5** | 重写 docs/hints.md + 同步 docs/onboarding.md + 新增 docs/help-center.md + changelog 三语 | `docs/hints.md` · `docs/onboarding.md` · `docs/help-center.md` (新) · `docs/changelogs/<ver>/` | 0.5 天 |

总计：6-9 工作日。**P1 上线就能修掉 5 个 Top friction 中的 4 个**（firstResultConfirm broken / login 死局 / 没有 reset / 没有 help 入口）。

## 已确认的取舍

| # | 取舍 | 决定 | 理由 |
|---|---|---|---|
| 1 | ESC 单按 → 长按 300ms cancel | 改长按 | escCancelExplain 配套抹平肌肉记忆 |
| 2 | firstResultConfirm 的"编辑修改"按钮 | P1 先单 ✓ 按钮，编辑挪 P3 | 不阻塞 P1 解决"看不见"主问题 |
| 3 | "已输入到「{App}」" 显示目标 App 名 | P2 期间查 Rust inject 路径；查不到则降级"已输入到当前光标位置" | 不为细节阻塞 P1 |
| 4 | Help tab vs 合并 About | 独立 Help tab + 保留 About | Linear / Raycast 都是分开的；语义不同 |

## 不在本提案范围

- 修改 ASR provider 选择策略 / 计费 UI
- 重做 AI Refine 系统提示词
- 任何 backend / SaaS 端改动（纯前端 + Tauri tray menu Rust）
- 多模态反馈（音频 ping 升级）— 现有 cue 已够；Layer 0 passive 优先

## Open questions（实施时再答）

- Tray menu label 动态显示 hotkey 在 Rust 端能否拿到 Tauri 当前 binding？（P3 验证）
- inject 目标 App owner name 在 macOS / Windows / Linux 三平台 Rust 端实现一致吗？（P2 验证）
- `weekOneFollowup` 的"首次启动 ≥ 7 天"如何记录起点？建议在 `general.installedAt` 字段保留首次 onboarding 完成时间戳（新增字段，老用户回退到 onboardingCompletedAt 或当下）

---

**Review checklist**（用户检查项）：

- [ ] 8 条里程碑覆盖度够吗？是否有漏掉的"新用户卡点"？
- [ ] 优先级排序（M2 > M6 > M5 > M1 > M4 > M8）合理吗？
- [ ] Help tab 内容是否够全？要不要加"常见问题"？
- [ ] ESC 改长按是否会影响某个高频用例？（如紧急想中止 SaaS 计费的录音）
- [ ] 阶段化时长估算是否符合发版节奏（看是否能塞进近期某个 release window）
