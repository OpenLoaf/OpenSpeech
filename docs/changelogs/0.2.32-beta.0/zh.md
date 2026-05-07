## v0.2.32-beta.0

> 测试版，仅 Beta 通道用户可收到。本版核心是验证 **Linux AppImage 重新启用**——v0.2.31 因 Tauri 上游 linuxdeploy 镜像过期（不识别新 ELF `.relr.dyn` section）暂停 AppImage，本版改用上游最新 linuxdeploy 绕开问题。Linux 用户重新拿到 AppImage + OTA 自动更新。

### 验证项（Beta 用户帮忙看）

- **Linux AppImage 能正常启动**：从 Releases 下载 `.AppImage`，`chmod +x` 后双击或命令行运行，确认能正常启动 + 录音 + 听写。
- **Linux 用户的应用内更新**：Linux x86_64 / ARM64 用户重启 OpenSpeech 看是否能拉到 v0.2.32-beta.0 的 OTA（设置 → 关于 → 更新通道 = Beta）。

### 累计改动

- AI refine 系统提示词调整（新增 `src/lib/asrSystemPrompt.ts`，`defaultAiPrompts` 微调）
- 后端：会议 SaaS / 转写链路收尾调整
- 多页面：History / Home / Overlay / Settings 等小修
- 三套 i18n 同步

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.32-beta.0`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。
- 如果 Linux AppImage 验证通过，下个 stable 版本（v0.2.32）会同时发 AppImage + deb + rpm，Linux 用户恢复 OTA 自动更新。
