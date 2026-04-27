## v0.2.16

### 修复

- macOS 26.x 上「输入监控列表里突然找不到 OpenSpeech」的根因修复。之前引导页在权限被拒时会先 `tccutil reset` 再立刻 `IOHIDRequestAccess`，但同一进程内 tccd 缓存还没刷新，request 被静默 no-op——结果是先把列表里的条目清掉、又没能重新注册，用户打开系统设置时压根看不到这条 App 可以勾选。改为：始终 request → 打开系统设置；并在用户从系统设置切回应用时，自动再 fire 一次 `IOHIDRequestAccess` 把 pending 条目刷回列表（已授权时是 no-op，无副作用）。
