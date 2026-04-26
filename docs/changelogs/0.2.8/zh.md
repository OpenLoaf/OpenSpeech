## v0.2.8

> ⚠️ 本次升级会把「分句模式」默认值改为「手动分句」，并覆盖老用户已有选择。需要保持自动分句的请到 *设置 → 通用 → 分句模式* 切回。

### 改进

- 分句模式默认改为「手动分句（推荐）」：整段录音一次性送模型 → 更准、不被停顿误切。设置页文案同步更新。
- 启动 loading 页面支持拖动窗口。

### 新增

- 生产包日志落盘，反馈 bug 时可直接发送：
  - macOS：`~/Library/Logs/com.openspeech.app/OpenSpeech.log`
  - Windows：`%LOCALAPPDATA%\com.openspeech.app\logs\OpenSpeech.log`
  - Linux：`~/.local/share/com.openspeech.app/logs/OpenSpeech.log`
