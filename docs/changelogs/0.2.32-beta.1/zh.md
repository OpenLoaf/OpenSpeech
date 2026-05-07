## v0.2.32-beta.1

> 测试版，仅 Beta 通道用户可收到。本版相对 0.2.32-beta.0 累积了**一大波业务改动**，并继续修 Linux AppImage（自定义 desktop entry 的 Terminal 字段硬编码为 false，修真正的启动失败 root cause）。

### 新增

- **词典联想（dictionary agent）**：在你输入或听写时，自动联想跨领域的高频专有名词（Cursor / DeepSeek / Llama / Qwen 等几百个），作为热词送入语音识别提高同音命中率。
- **历史记录支持手动编辑**：在 History 页可以直接编辑某条转写文本，对话框内会高亮 diff，让你看清楚改了什么。
- **智能焦点检测（focus check）**：识别当前活跃窗口语境（VSCode / 微信 / Notion 等），让 AI 整理时更贴合你正在写的东西，跨应用历史不再互相污染。

### 改进

- **AI 整理与语音识别共用同一份上下文规则**：合并到 `buildSpeechSystemPrompt`，整理流程更稳；按目标应用隔离历史，跨应用噪声不再污染整理结果。
- **会议实时听写后端重构**：`saas.rs` 大幅瘦身（-576 / +x），长会话更稳更流畅。
- **机器信息（platform / 时区 / 系统语言）一并送入上下文**，让模型在多语种混说时表现更自然。
- **升级 OpenLoaf SaaS SDK**：0.3.18 → 0.3.19。

### 修复

- **Linux AppImage 启动后立刻退出**：自定义 desktop entry 的 `Terminal=true` 误触发，硬编码为 `false` 修复（v0.2.32-beta.0 没有真正修好）。

### Beta 用户验证项

- **Linux AppImage 能稳定启动**：下载 `.AppImage` → `chmod +x` → 双击或命令行运行，确认正常启动 + 录音 + 听写。
- **历史编辑**：试着改一条历史记录，看 diff 是否正确。
- **焦点感知**：在 VSCode / 微信 / 浏览器里分别录一段，看 AI 整理风格是否随上下文切换。
- **词典联想**：说「DeepSeek / Cursor / Qwen 三秒说完」之类同音敏感词，看识别命中率。

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.32-beta.1`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。
- 如果 beta 周期反馈良好，下一个 stable 版本（v0.2.32）会把以上能力一起放出。
