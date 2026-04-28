## v0.2.20

### 修复

- 「检查更新」修复。0.2.18 和 0.2.19 上点「检查更新」会立刻报错 `Command check_for_update not found`——根因是后端的更新通道命令模块漏了注册，整个文件没编进二进制。所以 0.2.18 / 0.2.19 的「自动更新」实际上**完全不可用**（无论是 about 页、托盘、还是启动检查）。本版补上注册，更新链路恢复正常。

### 重要：升级建议

当前装着 0.2.18 / 0.2.19 的用户，由于上述 bug，**没法通过 OTA 升到 0.2.20**——必须从 GitHub Releases 手动下安装包安装一次：

- macOS：下载 `OpenSpeech-0.2.20-macOS-arm64.dmg`（Apple Silicon）或 `-macOS-intel.dmg`
- Windows：`OpenSpeech-0.2.20-Windows-x86_64-setup.exe`
- Linux：`OpenSpeech-0.2.20-Linux-x86_64.AppImage` 或 `.deb` / `.rpm`

装上 0.2.20 之后，下一次发版（0.2.21+）就能正常 OTA 自动升级。
