# 语音输入核心流程

## 触发方式

两种模式并存，用户在设置中切换：

| 模式 | 行为 | 适用场景 |
|---|---|---|
| **Push-to-Talk（默认）** | 按下开始录音，松开结束并触发转写 | 短句、指令 |
| **Toggle（切换）** | 单击快捷键开始录音，再次单击或 `Esc` 结束 | 长段口述、免手模式 |

> Push-to-Talk 为默认；Toggle 需由另一个独立快捷键激活，默认未绑定（见 [hotkeys.md](./hotkeys.md)）。TypeLess 的做法是 Fn + Space，OpenSpeech **MVP 不支持 Fn 作为修饰键**，默认组合全部走 `Ctrl + Shift + ...`。

## 状态机

```
  Idle ──按下快捷键──▶ Recording ──松开快捷键──▶ Transcribing ──成功──▶ Injecting ──▶ Idle
                           │                        │                         │
                           │                        └── 失败 ─▶ Error ─(用户 × / Esc / 下次触发)─▶ Idle
                           └── 用户取消 / Esc ─▶ Idle
```

**Error 态是粘滞态**，状态机不会自动回 Idle；只有用户显式关闭悬浮条（点 ×、按 Esc）或发起下一次录音时才迁移。这既是 UI 规则也是状态机规则。

| 状态 | 含义 | UI 表现 |
|---|---|---|
| Idle | 空闲 | 无悬浮条；托盘图标为普通色 |
| Recording | 正在录音 | 悬浮条出现：左上角 mono 标签（`DICTATE`/`ASK`/`TRANSLATE`），红色呼吸圆点，中央实时波形，右侧计时（mono），最右 `×`；右下角小字 `HOLD` 或 `CLICK TO STOP` 标明模式；托盘图标变红 |
| Transcribing | 已结束录音，等待大模型返回 | 悬浮条显示 spinner + `Transcribing via {模型名}...`，右侧 `Esc 取消` 提示；托盘图标变 accent 色 |
| Injecting | 正在把文字写入目标应用 | 悬浮条短暂闪一下对钩 + `Inserted`，200 ms 后淡出 |
| Error | 网络错误 / API 失败 / 权限错误 | 悬浮条红底显示错误文案；**粘滞不自动淡出**，直到用户点 `×` 或发起下一次录音；整条可点击跳历史页查看详情与"重试"；历史中对应条目标记为 failed |

## 详细业务规则

### 触发
1. 快捷键在**任何前台应用**均可生效，包括全屏、游戏、虚拟机窗口。
2. 当 OpenSpeech 主窗口处于焦点时，快捷键依然生效。
3. 当麦克风权限未授予时，触发快捷键必须引导用户前往系统权限设置，不得静默失败。
4. **必须存在可写入的光标焦点**才会开始录音；若系统焦点在不可编辑的区域（桌面、菜单栏、只读窗口），触发时给出轻提示"当前位置无输入框"，不进入 Recording。

### 录音
1. 采样率 / 声道数**跟随系统默认输入设备**（多数 Mac/Win 会是 44.1 kHz 或 48 kHz 立体声）；**不做重采样**，采集到的 f32 原样进 WAV（16-bit PCM 编码）。送到 SaaS realtime ASR 的帧在 cpal 回调里临时做 mono downmix + PCM16 量化，不影响落盘文件。
2. 录音最长时长默认 60 秒；超过时长自动结束并触发 finalize。
3. 录音过程中按 `Esc` 立即取消：同时 `audio_recording_cancel`（丢 PCM buffer）+ `stt_cancel`（关 realtime WebSocket，丢弃已到达的 Partial / Final）；**本次不写 history**。
4. 录音采集阶段在内存缓冲（`Zeroizing<Vec<f32>>`），**松开快捷键时并行**：Rust 落盘 `recordings/<id>.wav` + realtime session 发 `send_finish` 等 Final。路径与 DB schema 见 [privacy.md](./privacy.md#录音文件落盘路径) 与 [history.md](./history.md#录音文件)。
5. **内存音频必须 zeroize**：`Zeroizing<Vec<u8>>` 容器承载采集期的 PCM；落盘到 WAV 文件后，内存副本立即 drop（zeroize 自动触发）。panic/崩溃 handler 同样显式清零，避免 crash dump / swap 泄露。
6. **松开事件丢失兜底**：PTT 模式下若用户按下后立即 Cmd+Tab 切走应用，`tauri-plugin-global-shortcut` 的 Released 事件可能丢失。应用在进入 Recording 时，全局键事件监听线程（`rdev`）同时订阅所有已注册快捷键的修饰键 keystate；每 200 ms 查询一次当前物理键状态，若检测到原组合已全部释放则主动触发"松开"逻辑。该机制 + 最长录音时长双重兜底。
7. **录音设备变更**：录音中若系统默认输入设备切换（拔耳机 / 切蓝牙），cpal 会发出 device change 事件；静默 rebind 到新默认设备，悬浮条闪一下 `DEVICE SWITCHED` 提示，录音不中断；若 rebind 失败则进入 Error。
8. **麦克风被其他应用抢占**：cpal stream error → 立即进入 Error，错误文案"麦克风被其他应用占用"。

### 转写（通过 OpenLoaf SaaS realtime ASR）
1. **走 `openloaf-saas` Rust SDK 的 `client.realtime().connect("realtimeASR")` WebSocket 通道**，不是传统 REST 批量上传。cpal 回调边录边把 PCM16 帧喂给 session，服务端边识别边下发 Partial/Final/Credits 事件。实现见 `src-tauri/src/stt/mod.rs`；SDK 用法见 skill `.claude/skills/openloaf-saas-sdk-rust/`。
2. 按下快捷键 → `startRecordingToFile(id)` 成功后立刻 `startSttSession()` 建连并发 start 帧（`lang=zh / sampleRate=<设备原生> / channels=<设备原生> / encoding=pcm16`），cpal 回调自此把每帧都转发到 realtime worker。
3. 松开快捷键 → `stopRecordingAndSave` 与 `finalizeSttSession` **并行** `allSettled`：前者落 WAV，后者发 `send_finish` 等最多 `FINALIZE_WAIT_MS = 3s` 拿 Final。Final 非空 → history.status=success；空串 / 超时 / session 异常 → history.status=failed（text 占位 `（未能获取转写结果）`）。
4. **未登录直接拒**：`stt_start` 会先检查 `OpenLoafState::authenticated_client()`；未登录则只本地录音 + 落 history 占位文字，不建 WS 连接。UI 由 Account 流程引导登录。
5. **余额不足**：服务端下发 `closed{reason:"insufficient_credits"}`；前端 `openspeech://asr-closed` 监听到后立即切 Error 态，文案"余额不足，已取消本次转写"。
6. **idle 60s / 2h max-duration** 服务端会主动关 session——OpenSpeech 的 hold-to-speak + 60s 录音上限远低于此，正常不会触发；若真的触发，视为会话结束、history 按 failed 落。
7. **语种**：MVP 固定 `lang=zh`；未来在 Settings "听写 → 语言" 里提供下拉覆盖 start 帧 `lang` 字段。
8. **Transcribing 态 Esc 的精确语义**：UI 立即调 `stt_cancel` 关会话，丢弃任何已到达的 Partial / Final；history 不落盘（等同"用户没完成一次完整说话"）。

### 注入
1. 注入目标 = **按下**快捷键时快照的焦点应用 + 焦点输入框（不是松开时，避免用户说话过程中切换焦点造成不确定性）。
2. 默认注入方式：**写入剪贴板 + 模拟粘贴快捷键**，粘贴后恢复原剪贴板内容。
3. 备选注入方式：**逐字符模拟键盘输入**（在设置中切换）。
4. 若注入时目标应用已最小化 / 已退出 / 焦点已变为不可写区域：降级为"写入剪贴板 + 非侵入 Toast 提示'文字已复制，按 Cmd/Ctrl+V 粘贴'"。
5. **Windows UIPI 阻断**：用户以普通权限运行 OpenSpeech，但目标应用是"以管理员身份运行"（cmd、部分编辑器）时，`enigo` 模拟键盘会被 UIPI 静默阻止。检测到此情形时降级剪贴板 + Toast 明示"目标应用权限高于 OpenSpeech，请以管理员启动 OpenSpeech 或手动粘贴"，并提供"一键重启为管理员"按钮。
6. **Linux Wayland**：剪贴板注入依赖 `wl-copy`，粘贴模拟依赖 Portal；若 Portal 不可用，降级为仅剪贴板 + Toast "请手动按 Ctrl+V 粘贴"。
7. **macOS Accessibility 运行时撤销**：每次注入前调用 `AXIsProcessTrusted()` 预检；失败则走剪贴板兜底 + Toast 并引导回授权。

### 历史记录
1. 每次成功转写必须记录一条。
2. 失败的转写也记录，但标记为失败状态，可"重试"。
3. **用户 Esc 取消的录音，若已完成转写也进入历史**（状态标记为 cancelled）——用户仍可从历史中复制或重新注入。
4. 记录内容见 [history.md](./history.md)。

## 边界情况

| 情况 | 规则 |
|---|---|
| 录音时长 < 300 ms | 视为误触，直接回到 Idle，不调用大模型；悬浮条 fade out 时补一行 mono 小字 `HOLD LONGER` 教育 300ms 规则 |
| 录音期间麦克风断开 | 立即结束录音，进入 Error |
| 录音期间网络断开 | 录音完成后在 Transcribing 阶段失败 |
| 焦点应用消失（被关闭） | 注入降级为写入剪贴板并提示 |
| 用户在 Transcribing 阶段再次按下快捷键 | 忽略，当前任务继续（不开启并发录音） |
| 用户在 Recording 中再次按下另一个听写快捷键（PTT 与 Toggle 并发） | 状态机 Recording 中忽略所有听写类快捷键按下事件（内部日志计数，不提示） |
| 系统锁屏 / 休眠 / 切账户 | 订阅 session 事件；非 Active session 时暂停监听全局快捷键；恢复后自动重新注册 |
| 系统内存不足导致 cpal 回调卡住 | 录音线程独立心跳，>2 秒无样本回调强制 abort，进入 Error |
| 外接显示器拔出 / 悬浮条坐标越界 | 监听 monitor change，越界自动 reparent 回主显示器底部中央 |
