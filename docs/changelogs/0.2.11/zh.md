## v0.2.11

### 新增

- 全应用支持简体中文 / 繁體中文 / English 三语切换。在「设置 → 通用 → 界面语言」选择即可，托盘菜单与所有界面同步切换。

### 修复

- 修复关于页「检查更新」按钮点击无反应的 bug（之前是空壳装饰按钮）。
- 录音 / 登录 / 网络相关的错误提示文案统一收口，更友好可读。

### 内部（不影响功能）

- 自动更新链路全程写入应用日志文件，方便诊断「点了检查更新没反应 / 启动没自动升级」一类问题。日志位置：
  - macOS：`~/Library/Logs/com.openspeech.app/OpenSpeech.log`
  - Windows：`%LOCALAPPDATA%\com.openspeech.app\logs\`
  - Linux：`~/.local/share/com.openspeech.app/logs/`
