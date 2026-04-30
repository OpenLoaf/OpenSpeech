## v0.2.26

> 0.2.26 是一个**累积型**版本，整合了 beta.0 ~ beta.6 共 7 轮灰度的全部改进。重点是**国内更新加速**与**多处稳定性自愈**。

### 新增

- **国内更新加速（COS 镜像）**：自动更新分发改为「腾讯云 COS 优先 + GitHub 兜底」双轨——国内拉新版安装包速度大幅提升，COS 不可用时自动回退到 GitHub。manifest 也指 COS url，**老版本（< 0.2.26）的客户端这次升级即享 COS 加速**，无需先升再升一次。
- **语音活动检测（VAD）**：录音管线接入 webrtc-vad，识别更精准，自动剔除静音段。
- **AI 优化跨条上下文**：refine 调用透传最近 3 条 history（< 1 小时）作为 reference_context，跨条指代 / 缩略 / 接续式表达消解更准（"那个东西"、"刚才那条"、"再补一句…"）。配套把 realtime sessionId 作为 task_id 透传，方便服务端关联 ASR 与口语优化两侧日志。
- **History 失败角标**：左侧导航的 History 项显示从最新一条往前数连续 failed 的条数（最多 99+），最新条不是 failed 即隐藏，方便一眼看到最近的失败。
- 多语言 README：新增英文 / 繁体中文版本文档。

### 改进

- **Error 提示更好用**：录音失败的红色提示从 4s 改为 1.5s 自动消失；error 状态下再次按激活快捷键或 ESC 可立即 dismiss、立刻开始下一次录音，不必等。
- **悬浮条动画**：toast 与 pill 各自动画独立、窗口尺寸"先涨后缩"避免动画被截断；toast 单独显示时不再渲染空胶囊；转写阶段"思考 → 输出文字"切换改为 240ms crossfade。
- **取消态 UI**：被 ESC 取消的录音条用"转入"按钮（取代"重试"）+ 灰色文字，区分主动取消与失败。
- 实时识别遇到上游 "model repeat output" 复读 bug 时自动降级到录音文件 REST 重转，不再丢整段听写。
- 「打开日志目录」改用 `tauri-plugin-opener` 统一三平台调度，行为更一致。
- 自动更新增加诊断日志：托盘检查更新时日志里会打出 endpoint、当前平台对应的 manifest install URL，便于排查。
- 安装包不再产出 Windows MSI（updater 链路只用 NSIS，少打一份没用的产物，CI 更快）。
- App 图标资源更新；首页 README 重写，加上演示动图。

### 修复

- **macOS 状态栏录音指示灯卡死**：audio 线程因 cpal error / panic 退出时状态没回滚，导致 ref_count > 0 但 thread 已死，cpal Stream 残留点亮 indicator。新增 `force_stop` 应急清场，并在 boot / 退出 / 录音启动 检测到僵尸时各调一次。
- **打开日志目录按钮在签名版失效**：日志原本落到 `~/Library/Logs/com.openspeech.app/`（跨容器路径），Hardened Runtime + LaunchServices 会静默拦掉打开请求。改写到 app data 容器内 `~/Library/Application Support/com.openspeech.app/logs/`，三平台均生效。
- **反馈对话框邮箱预填占位值**：微信登录用户的 `wechat-<openid>@wechat.local` 占位邮箱不再当真实联系方式预填进表单。
- 反馈提交的 `source` 字段从 `openloaf-saas` 统一成 `openloaf`，与服务端约定对齐。
- VAD 管线细节打磨（语音活动检测准确度 / 边界处理）。

### 升级提示

- **macOS 老用户日志目录变更**：原 `~/Library/Logs/com.openspeech.app/` 不再写入新日志，新位置在 `~/Library/Application Support/com.openspeech.app/logs/`。如果原来手工备份过旧目录，需要切到新路径。
- **0.2.26 也会推送给 Beta 通道用户**：本次发布同时刷新 stable 与 beta 两路 manifest，beta 通道用户会收到这个 stable 版本（SemVer 0.2.26 > 0.2.26-beta.N）。
