# 交互提示（Hints）

教学型小气泡，浮在悬浮条 / 主窗听写卡片附近，告诉用户"现在能按什么键 / 点什么按钮"。与首次启动向导（onboarding.md）的关系：onboarding 是**一次性**的全屏引导；hints 是**贴在上下文里**的细粒度提示，每条独立计数、随机会重复出现。

## 设计原则

1. **教学不打扰**：默认显示 → 用户学会即静音，不靠"再确认一次"打断流程
2. **可关闭**：每条都可单独 ✕ 永久不再显示；设置页另有全局开关
3. **可预测**：永远不靠"今天首次/明天再弹"这类时间魔法。学了就不见，没学就还在
4. **可调试**：dev build 在设置页有"提示调试"tab，能看每条状态、强制显示、一键重置

## 当前提示清单

| ID | 类别 | 触发时机 | 文案（中） | 阈值 | 自动隐藏 | "学会"判定 |
|---|---|---|---|---|---|---|
| `recordingControls` | 操作指引 | 进入 `recording`/`preparing` 后 500 ms | 松开结束 · ESC 取消 | 累计成功 3 次后停 | 5 秒 | 用户成功完成一次录音（recording → transcribing） |
| `resultActions` | 操作指引 | 进入 `idle(result)` 结果态后 300 ms | ⌘C 复制 · 编辑 · 润色 · 翻译 | 累计成功 3 次后停 | 6 秒 | 用户点了任一结果按钮（复制 / 编辑 / 润色 / 翻译） |
| `firstResultConfirm` | 主动引导 | 全局首次成功转写 | 已输入 · 修正 | 仅 1 次 | 8 秒 | 显示过即视为完成 |

> 主动引导（D 类）与操作指引（A 类）的区别：A 类纯文字，不影响主流程；D 类带按钮、可能引导用户进入额外操作（如"修正"会拉起 Cmd+Shift+E 编辑面板）。

## 何时**不**显示

- 全局 `ui.showHints = false`（设置页"显示快捷键提示"关掉）
- 该条 `successCount ≥ threshold`（累计学够）
- 该条 `dismissed = true`（用户点过 ✕）

三个条件任一成立即不显示。复活只能通过设置页"重置交互提示"按钮（清零所有 `successCount` 与 `dismissed`）。

## 与悬浮条 / 错误兜底的边界

- **A / D 类教学气泡** ⇒ 本文档（`hints.*`）
- **C 类错误兜底**（无麦克风 / 权限拒绝 / 静音录音 / SaaS 402 / 网络错）⇒ 走 overlay toast（`overlay.toast.*`），有自己的生命周期、不受 `showHints` 影响、永远显示

二者持久化路径不同、UI 组件不同、关闭语义不同。请勿把错误吐司当成"提示"。

## 持久化

存储在 `settings.json` 的 `ui` slice：

```ts
ui: {
  showHints: true,                    // 全局开关
  hints: {
    recordingControls: { successCount: 0, dismissed: false },
    resultActions:     { successCount: 0, dismissed: false },
    firstResultConfirm:{ successCount: 0, dismissed: false },
  }
}
```

所有计数与已读标记跟其他设置同步保存，跨重启保留。删除 `settings.json` 即重置。

## Dev 面板

**仅 dev build** 可见——设置 → 提示调试 tab。功能：

- 表格列出所有已注册 hint：ID / 类别 / 阈值 / 当前 successCount / 已 dismissed / 是否应显示
- 每行：`+1` 模拟一次成功 / `Dismiss` 主动关闭 / `Reset` 清零 / `Force show` 强制显示（绕过所有判断）
- 顶部：全局开关 + 一键全部重置

QA 回归 checklist：依次点每条的"强制显示"按钮，确认气泡正确出现、文案正确、点 ✕ 关闭生效；点"全部重置"复活后再点一遍。

## 新增一条提示的步骤

1. `src/stores/settings.ts` 在 `HintId` 联合类型 + `HINT_IDS` 数组里加新 id
2. `src/lib/hints.ts` 在 `HINT_REGISTRY` 注册一条（类别 / 阈值 / 自动隐藏 / 显示延迟 / dev 描述）
3. `src/i18n/locales/{zh-CN,zh-TW,en}/overlay.json` 在 `hints.<id>.text` 加三语文案
4. 在调用方挂 `useHintBubble({ id, when })` + 在"学会"事件回调里调 `markHintSuccess(id)`

完成后 dev 面板自动多出一行，无需改 DevHintsTab。

## 用户视角的关闭路径

| 用户操作 | 影响范围 |
|---|---|
| 单条气泡按 ✕ | 该条永久 dismissed |
| 累计完成对应操作 N 次 | 该条达到阈值不再显示 |
| 设置 → 关闭"显示快捷键提示" | 全局所有 A/D 类气泡关闭，C 类错误吐司不受影响 |
| 设置 → "重置交互提示" | 清零所有计数与 dismissed，让所有 hint 复活 |
