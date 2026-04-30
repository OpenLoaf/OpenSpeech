## v0.2.28-beta.0

> 测试版，仅 Beta 通道用户可收到。本轮主要验证发版工作流改动（COS 上多生成一份 `download.json`），顺带带了两处 macOS 体验小修复，欢迎 beta 用户帮忙留意升级流程是否顺畅。

### 修复

- macOS 自动升级完成后，新进程不再被压在其他窗口之后——升级重启时主窗会被前置成 key window，避免感知上像「应用没启动」。
- 终端日志不再重复输出两次，日志文件也回到单一目录（去掉 tauri-plugin-log 的默认 targets 重复挂载），并把日志时间戳从 UTC 改为本地时区。

### 内部

- 发版工作流额外生成 `download.json` / `download-stable.json` / `download-beta.json` 上传到 COS 与 GitHub Release，给官网下载页 / 第三方接入方提供用户友好的下载链接清单（dmg / -setup.exe / AppImage 直链）。聚合入口策略与 OpenLoaf 对齐：stable 优先，beta 仅在尚未发过 stable 时占位写入聚合 `download.json`。
- `channel-beta` 滚动指针 release 同步上传 `download-beta.json`，beta 通道接入方可直接拉。
- 把 `public/logo-*.png` 设计稿候选素材加入 `.gitignore`，等真正在代码里引用时再纳入版本控制。
