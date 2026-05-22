## v0.2.42

### 修复

- **WPS Office / Microsoft Word·Excel·PowerPoint 里录音后没有文字进文档**：
  这类 Office 套件用的是自绘文档区，macOS 无障碍 API 看过去只能看到一个
  「分组」容器，看不到真正的文本框。0.2.41 之前的版本据此判定「焦点不可
  编辑」，转录完直接弹结果面板提示「没有注入文字」，但其实粘贴是没问题的——
  只是被自家判断拦掉了。本版加了一份「无障碍 API 不可信」的应用名单，名单内
  的 app 跳过这道判定直接走粘贴。
  - 已覆盖：WPS Office、Microsoft Word / Excel / PowerPoint / OneNote。
  - 用注音 / 仓颉 / RIME / 搜狗 / 百度等输入法的 WPS 用户同样适用，0.2.41 的
    输入法 paste 修复在本版会自动串起来生效。
  - 其它仍然「面板提示没注入」的 app，欢迎在反馈里贴上 OpenSpeech.log，
    把对应 bundle id 报上来即可加进名单。

### 内部

- **新增输入法切换日志**：后台每秒巡检一次当前键盘输入源，**只在切换发生时**
  写一行 `[ime] switched: prev → next` 到 OpenSpeech.log，平时不刷屏。
  下次排查「这个输入法下粘贴怎么了」时不用再让用户回忆按了什么——日志里
  直接能看到时间点和输入法 ID。
