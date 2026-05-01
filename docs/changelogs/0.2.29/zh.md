## v0.2.29

> 0.2.29 是 0.2.28 之后的小步迭代，主要修了**长录音后 AI 优化偶发被降级回原文**这条体感很差的 bug，附带打磨更新提示样式与落地页下载区。

### 修复

- **长录音（>60s）后 AI 优化偶发被降级回原文**：录音超过 60 秒后再触发 AI 优化（OL-TL-005），有概率吃 `Connection reset by peer (os error 54)`，结果是返回未优化的原文，看起来像「AI 优化没生效」。
  - 原因：旧的 keep-alive 连接在长录音期间已被对端（本地代理 / 上游网关）静默 RST，复用时一打就废。
  - 改动：refine 链路独占新建的 ureq client（`fresh_authenticated_client()`），每次新连接池。代价是多一次 TCP 握手——本地几乎无感，但换来不再降级。
- **更新提示 toast 标题被按钮挤折行**：sonner 默认布局把 action / cancel 按钮和标题塞进同一行，按钮文案稍长就把 "Update available" 和版本号挤折，难看。改用 `toast.custom` + 自带组件 `UpdateAvailableToast` 自己排版：标题 / 版本号独占上排，按钮独占下排，TE 风格保持一致。boot 启动期与托盘「检查更新」两条路径都已同步迁移。

### 改进

- **促销页下载区重构**：`CTASection` 抽出 `PlatformCard` 组件，hover / focus 展开次要变体（macOS Intel / Windows ARM64 / Linux deb-rpm）；图标库切到 `react-icons` 的 Apple / Windows / Linux 官标，视觉上更接近系统原生。

### 升级提示

- **0.2.29 也会推送给 Beta 通道用户**：发布同时刷新 stable 与 beta 两路 manifest，Beta 用户会收到这个 stable 版本（SemVer 0.2.29 > 0.2.29-beta.0）。
