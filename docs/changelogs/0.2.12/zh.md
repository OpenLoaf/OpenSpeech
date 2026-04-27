## v0.2.12

### 新增

- 历史页每条录音新增「导出」按钮，可把 WAV 另存到任意位置（系统 Save 对话框）。

### 修复

- 修复极少见但影响很大的「打开应用后一直停在 Loading 进不去」的问题。根因是开发版与正式版共用同一个 macOS 钥匙串条目，开发版残留的会话指向 `localhost` 服务，正式版启动时拿到这条会话后向已关闭的本机服务发请求，于是无限等待。
  - 现在开发版与正式版的钥匙串完全隔离（`ai.openloaf.saas` vs `ai.openloaf.saas.dev`），互不污染。
  - 启动时账号恢复增加 30 秒硬超时，万一服务不可达也不会再卡死，会直接进入未登录状态等待用户手动登录。

### 已知操作（如果你之前曾经跑过开发版）

- 一次性手动清理一下旧的污染条目（命令行）：
  ```
  security delete-generic-password -s "ai.openloaf.saas" -a "default"
  rm -f ~/.openspeech/dev_session.json
  ```
- 或者打开「钥匙串访问」搜索 `ai.openloaf.saas` 删除该条目。之后重启 OpenSpeech，会让你重新登录一次，登录后即恢复正常。
