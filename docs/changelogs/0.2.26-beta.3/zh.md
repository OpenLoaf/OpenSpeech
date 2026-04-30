## v0.2.26-beta.3

### 新增

- **语音活动检测（VAD）**：录音管线接入 webrtc-vad，识别更精准、自动剔除静音段（**本轮 beta 主要测试点**）。
- 多语言 README：新增英文 / 繁体中文版本文档。

### 改进

- 自动更新分发改为「**腾讯云 COS 优先 + GitHub 兜底**」双轨：国内拉新版安装包速度大幅提升，COS 不可用时自动回退到 GitHub。
- App 图标资源更新；首页 README 重写。
- 安装包不再产出 Windows MSI（updater 链路只用 NSIS，少打一份没用的产物，CI 略快）。

### 测试重点（给 beta 用户）

- 真实场景下连续说话 / 中途停顿 / 极短语句，观察 VAD 是否正确切段、是否漏字。
- 「设置 → 关于 → 检查更新」走一次升级流程，观察下载速度是否明显改善（COS 加速）。
- 网络异常时仍能正常完成升级（验证 fallback 链路）。

### 已知

- 老版本（< 0.2.26）的客户端这次升级仍会从 GitHub 拉 manifest，但安装包链接已指向 COS——所以**这次升级**就能享受 COS 加速，无需再次升级才生效。
- v0.2.26-beta.0 因 Windows MSI 不支持 SemVer pre-release 段失败；
  v0.2.26-beta.1 的 COS 上传步骤因 coscli 下载 URL 写错失败；
  v0.2.26-beta.2 因 GitHub runner 跨境上传 COS 默认 endpoint 极慢被取消；
  本版（beta.3）已改走 cos.accelerate.myqcloud.com 全球加速 + 16 并发，COS 镜像应当完整。
