## v0.2.27

> 0.2.27 是 0.2.26 之后的小步迭代，重点打磨**全局快捷键稳定性**、**悬浮条体感**、**macOS 安装体验**。

### 新增

- **悬浮条波形改为右进左流**：声波从右侧"麦克风方向"涌入，与物理直觉一致；视觉上更自然。
- **悬浮条流式逐字键入**：转写文字按字符增量出现，配合进度条 CSS 解耦，整体更顺滑；末尾注入完成时提前淡出，不再硬切。
- **促销页 DemoSection 抽出三语文案**（zh / zh-TW / en），README 顶部演示 GIF 同步重录三语版本。

### 改进

- **全局快捷键稳定性**：rdev 切到自维护分支 `openloaf-rdev 0.5.1`，修复 ghost release 场景下错误粗暴清空 pressed / active_ids 的问题——长按组合键、快速连按、跨窗口切换时丢键概率显著降低。
- **OpenLoaf SDK 上报 client 信息**：所有调 SaaS 接口的请求带上 `client_name=APP_ID` + `client_version=<当前版本>`，方便服务端按客户端版本排查问题与做兼容判断。
- **README 双语截图压缩**：体积从 ~316KB 降到 ~190KB，clone / 浏览仓库更快。

### 修复

- **macOS 安装包图标变成圆角方块（squircle）**：与系统其他原生 App 风格一致，不再是早期那种圆形 + 大留白的非主流形态。
- **macOS DMG 在 CI 上偶发打包失败**：CI runner 是 headless 环境，AppleScript 驱动 Finder 排版图标这条老路径会随机超时。改走 `appdmg` 纯命令行链路，CI 上不再偶发卡住。

### 升级提示

- **0.2.27 也会推送给 Beta 通道用户**：发布同时刷新 stable 与 beta 两路 manifest，Beta 用户会收到这个 stable 版本（SemVer 0.2.27 > 任何 0.2.26-beta.N）。
