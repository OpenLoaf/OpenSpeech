## v0.2.29-beta.0

> 测试版，仅 Beta 通道用户可收到。本轮主要验证**长录音后 AI 优化降级**的修复，顺带换了下载页的图标库，欢迎 beta 用户帮忙留意 AI 优化是否还会偶发降级回原文。

### 修复

- **长录音（>60s）后 AI 优化偶发被降级回原文**：录音超过 60 秒后再触发 AI 优化（OL-TL-005），有概率吃 `Connection reset by peer (os error 54)`，结果是返回未优化的原文，看起来像「AI 优化没生效」。
  - 原因：旧的 keep-alive 连接在长录音期间已被对端（本地代理 / 上游网关）静默 RST，复用时一打就废。
  - 改动：refine 链路独占一份新建的 ureq client（`fresh_authenticated_client()`），每次新连接池。代价是多一次 TCP 握手——本地 5180 几乎无感，但换来不再降级。
  - **本轮重点希望 beta 用户帮忙验**：长录音 + AI 优化场景下，是否还见到「优化结果跟原文一模一样」的现象。

### 改进

- **促销页下载区重构**：`CTASection` 抽出 `PlatformCard` 组件，hover / focus 展开次要变体（macOS Intel / Windows ARM64 / Linux deb-rpm）；图标库切到 `react-icons` 的 Apple / Windows / Linux 官标，视觉上更接近系统原生。

### 已知风险

- `fresh_authenticated_client()` 只用在 refine 这两条链路；常规 SaaS 调用仍走共享 client。如果发现**其他 SaaS 调用**也开始报 `Connection reset by peer`，请反馈，我们会评估是否需要扩大策略。
- 落地页 / 促销页对终端听写功能没影响，但下载链接重排过，如果遇到「下载按钮指向错误的安装包」请截图反馈。

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.29-beta.0`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。
