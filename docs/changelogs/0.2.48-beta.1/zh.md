## v0.2.48-beta.1

紧跟 beta.0 的 hotfix——一个 OpenSpeech 自建仓以来都没暴露过的 mic 持有 bug。

### 修复

- **退出 OpenSpeech 后 macOS 状态栏麦克风指示灯不熄灭**：主窗口关闭（红叉 /
  Cmd+W / 托盘隐藏 / `Shift+Cmd+O` toggle 收起）走的是 hide-to-tray，进程仍
  在后台运行；但 hide-to-tray 路径**完全没释放 audio stream**，于是只要前
  一轮录音的引用计数有任何漏减（如 PTT 被中断、webview reload、stt 错误
  路径未平衡），cpal stream 就一直活、macOS 橙色 mic 指示灯就一直钉亮。
  - 本版在 hide-to-tray 末尾强制 release audio，主窗一收起 indicator 就熄。
  - 同时保留 audio 模块原有的 ref_count 机制——只有用户主动收主窗时才强制
    清场；录音中按 PTT 不受影响。
  - 临时绕过手段（适用于本版前所有版本）：Cmd+Q 退出（不要红叉）；如果灯
    已经卡亮，活动监视器找 OpenSpeech 强制退出，或 `pkill openspeech`。
