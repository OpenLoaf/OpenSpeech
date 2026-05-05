## v0.2.30-beta.5

> 测试版，仅 Beta 通道用户可收到。本轮只有一项修复：**Windows 上中文长段注入丢字**。

### 修复

- **Windows 注入：长段中文 / 多字符文本前 ~10 字成功、剩余被吞**：中文一字 = 2 个 `KEYEVENTF_UNICODE` 事件，整段一次性灌进 `SendInput` 时目标应用的 message pump / IME 输入区跟不上，前 10 字左右成功、后续被静默丢弃，但 enigo / SendInput 自身都返回成功，前端 `catch → paste fallback` 也触发不到，事后只能看到屏幕半截字。这版改为按 4 字符分块 + 块间 sleep 8ms，给 message pump 时间消化。其它平台（macOS / Linux）保持原一次性注入路径不变。

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.30-beta.5`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。

### 想让 Beta 用户帮忙验

- Windows 用户在长段中文听写后注入是否完整（尤其超过 10 字的句子）。
- 注入耗时是否还在可接受范围（每 4 字 +8ms，100 字大约 +200ms）。
