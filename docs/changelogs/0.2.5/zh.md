## v0.2.5

### 新增
- **macOS 权限授权流程基线**：Onboarding 阶段统一引导麦克风、辅助功能、输入监控三项授权，调用系统原生授权弹框（替换原先的 cpal probe / objc 0.2 hack），授权交互更稳。
- **App 图标全套重做**：替换 macOS / Windows / Linux 全平台图标资源，并补齐 Android / iOS 图标目录。
- **本地权限重置脚本**：新增 `pnpm reset:permissions`，开发期一键清理 macOS 输入监控 / 辅助功能 / 麦克风的本应用授权，便于反复测试 onboarding 流程。

### 改进
- Loading Screen / Home 启动体验微调，引导动画与首屏过渡更顺滑。
- 「无网络」对话框文案、按钮、视觉重写，授权失败时的下一步指引更清晰。
- Onboarding 步骤简化：去掉冗余确认页，直达需要用户操作的真正步骤。

### 修复
- 修复某些 macOS 设备首次启动时，权限弹窗被主窗口遮挡导致用户看不到的问题（改为等主窗口完全可见后再请求授权）。
- 修复了 realtime ASR 离线测试 example 在新 rustls 0.23 默认配置下启动 panic 的问题（example 显式 install ring crypto provider）。

### 内部
- 简化 `pnpm tauri` 脚本，去掉 `.env` 加载链路（机密改走 keyring）；删除 `.env.example` 模板。
- 同步更新 `openspeech-dev` skill，记录新的权限授权策略与首启时序约定。
