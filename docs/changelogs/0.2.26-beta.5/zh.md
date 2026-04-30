## v0.2.26-beta.5

### 改进

- **打开日志目录**改用 `tauri-plugin-opener` 统一三平台调度（之前 macOS/Windows/Linux 各写一段，现在收敛成一行）。
- VAD 管线细节打磨（语音活动检测准确度 / 边界处理）。
- 实时识别遇到上游 "model repeat output" 复读 bug 时自动降级到录音文件 REST 重转，不再丢整段听写。
- 录音 store 行为调整、设置页交互细节优化。
- 首页 README 加上演示动图。

### 测试重点

- 「设置 → 关于 → 打开日志目录」三平台都能正确弹出文件管理器到 `~/Library/Logs/com.openspeech.app/`（macOS）/ `%APPDATA%\com.openspeech.app\logs\`（Windows）/ `~/.config/com.openspeech.app/logs/`（Linux）。
- 真实录音场景下 VAD 切段是否更准（接续 beta.3 的 webrtc-vad 集成）。
- 升级速度（用 v0.2.25 走 GitHub manifest，安装包应走 COS 加速）。

### 已知

- 老版本（< 0.2.26）的客户端这次升级 manifest 走 GitHub，但安装包链接已指 COS——这次升级即享 COS 加速。
