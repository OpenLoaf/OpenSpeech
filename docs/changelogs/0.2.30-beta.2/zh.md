## v0.2.30-beta.2

> 测试版，仅 Beta 通道用户可收到。**功能上等价于 0.2.30-beta.0 / b1**——同样的功能集，只是 b0 / b1 的 Windows CI build 都没过（详见末尾「修复」），第三次重打。Beta 通道用户只会收到这一版。

### 新增（与 b0 一致）

- **翻译听写快捷键**：默认 macOS = `Fn + Shift`，Windows / Linux = `Alt + Shift`。按住说话，松开后转写文本会被译成「翻译目标语言」再注入到当前焦点；自动写一条 `translate` 类型的历史记录。
- **翻译目标语言设置**（设置 → 通用）：英 / 简中 / 繁中 / 日 / 韩 / 法 / 德 / 西，默认英文。
- **悬浮条翻译徽章**：录音 / 准备阶段在悬浮条挂一个语言徽章（EN / 中 / 繁 / 日 / 한 / FR / DE / ES）；进入「思考中」/「输出中」/「错误」后徽章自动消失。
- **后端日志**：vendor / region / model / engine 等关键参数从 debug-only 改成永久 info 日志，BYOK 通道排查直接看 `RUST_LOG=info` 即可。

### 改进（与 b0 一致）

- **听写模式默认排序**：设置里 `UTTERANCE`（整段优化）放第一位，`REALTIME`（边说边出字）放第二位，与默认值保持一致。

### 修复

- **Windows CI build 失败（彻底解决）**：移除 `scripts/tauri.mjs` 这层 Node spawn 包装——它在 Windows 下要么找不到 `.cmd` shim（b0），要么 `shell: true` 让 cmd.exe 吃掉 args 里的 JSON 双引号（b1）。把 dev 时塞 `tauri.dev.conf.json` 的逻辑直接写到 `package.json` 的 `tauri:dev` script 里，`pnpm tauri` 还原成裸 `tauri`，让 pnpm 自己处理跨平台 shim。**只影响构建链路，不影响终端用户运行。**

### 已知风险 / 想让 Beta 用户帮忙验

- 翻译态下**不走 REALTIME 增量注入**，必须等录音结束才出译文。如果你习惯了 REALTIME 边说边出字的节奏，翻译模式下会感觉「按完没反应几秒才出」，这是预期。
- 翻译走的是 chat stream（`OL-TL-006`），网络抖动 / 长录音的失败兜底跟普通 AI 优化共用一条链路；翻译 prompt 是新写的——如果遇到译文里残留了原文、或译完反向把目标语言译回了源语言，请把那段录音 + 译文截图反馈。
- 悬浮条徽章只测了 8 种语言短码；切到非默认语言看到布局错乱请截图反馈。

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.30-beta.2`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。
