## v0.2.26-beta.6

### 改进

- **AI 优化更准**：refine 调用透传最近 3 条 history（< 1 小时）作为 reference_context，跨条指代/缩略/接续式表达消解更准；同时把 realtime sessionId 作为 task_id 透传，方便服务端关联 ASR 与口语优化两侧日志（依赖 openloaf-saas SDK 0.3.9）。
- **Error 提示更好用**：录音失败的红色提示从悬停 4s 改为 1.5s 自动消失；在 error 状态下再次按激活快捷键或 ESC 可立即 dismiss、立刻开始下一次录音，不必等。
- **History 失败角标**：左侧导航的 History 项显示从最新一条往前数连续 failed 的条数（最多 99+），最新条不是 failed 即隐藏。
- **取消态 UI**：被 ESC 取消的录音条用"转入"按钮（取代"重试"）+ 灰色文字，区分主动取消与失败。
- 新增**应急清场**命令 `app_emergency_reset`，boot 第一步兜底"上轮 webview reload / 状态机错乱"导致的麦克风占用泄漏。

### 修复

- **macOS 状态栏录音指示灯卡死**：audio 线程因 cpal error / panic 退出时状态没回滚，导致 ref_count > 0 但 thread 已死，cpal Stream 残留点亮 indicator。新增 `force_stop` 应急清场，并在 boot / ExitRequested / Exit / start 检测到僵尸时各调一次。
- **打开日志目录按钮在签名版失效**：日志原本落到 `~/Library/Logs/com.openspeech.app/`（跨容器路径），Hardened Runtime + LaunchServices 会静默拦掉打开请求。改写到 app data 容器内 `~/Library/Application Support/com.openspeech.app/logs/`，三平台均生效。
- **反馈对话框邮箱预填占位值**：微信登录用户的 `wechat-<openid>@wechat.local` 占位邮箱不再当真实联系方式预填进表单。
- 反馈提交的 `source` 字段从 `openloaf-saas` 统一成 `openloaf`，与服务端约定对齐。

### 测试重点

- 跨条指代 / 缩略式表达："那个东西"、"刚才那条"、"再补一句…" 等语句 refine 后能否更准确接续上下文（要求最近 1 小时内有前置 history）。
- macOS 录音过程中强杀 / 崩溃 / webview reload 后重启 app，状态栏橙色 mic 指示灯是否消失；boot 日志能看到 `force_stop: clearing stale monitor`。
- macOS / Windows / Linux「设置 → 关于 → 打开日志目录」均能弹出文件管理器到正确路径（macOS 路径变化：现在指向 `Application Support/com.openspeech.app/logs/`，老用户原 `Library/Logs/` 下不再产生新日志）。
- 录音失败 toast → pill 红字 → 1.5s 后回 idle；红字未消失时按激活快捷键 / ESC 立即清掉。
- 侧栏 History 项的失败角标在新建 history、把最新条改 success / 删除后实时刷新。

### 已知

- 老用户升级后日志落地目录变了（macOS）。如果原来手工备份过 `~/Library/Logs/com.openspeech.app/` 下的日志，新日志要去 `~/Library/Application Support/com.openspeech.app/logs/` 找。
