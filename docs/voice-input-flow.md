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

### 悬浮条显隐策略（与主窗口焦点联动）

悬浮录音条的 **逻辑可见性**（"是否在录音流程中"）与 **物理可见性**（OS 窗口实际是否 show）拆成两层：

- **主窗口处于前台焦点时**，即使状态处于 Recording / Transcribing / Injecting / Error，OS 悬浮条**不显示**——Home 页的 Live 面板已经提供等价信息（状态标签、波形、实时文字、取消/确定按钮），屏幕底部再叠一个浮窗属于视觉重复。
- **主窗口失焦后（用户切到别的应用、或最小化主窗）立即显示** OS 悬浮条；用户切回主窗口（主窗口重新获得焦点）则悬浮条物理隐藏，逻辑状态保持不变（继续录音/转写）。

实现：Rust `overlay::DESIRED_VISIBLE` 跟踪逻辑可见性（`show()` 置 true、`hide()` 置 false），主窗口 `WindowEvent::Focused` 事件由 `overlay::on_main_focus_changed` 在 desired=true 时按焦点切换物理显隐。前端无须感知此策略。

### Home Live 面板：录音结束后保留结果

Home 页 Live 面板与 OS 悬浮条**不共享淡出策略**：状态机回 Idle 时悬浮条直接消失，但 Home 面板**必须保留最近一次结果**，挂到屏幕上等用户主动处置。

- 触发条件：FSM 经历 `recording/transcribing/injecting → idle` 且本次拿到了非空 transcript（partial 或 final 任一）。
- 关闭路径仅两条：
  1. 用户点结果面板右上角 `✕`
  2. 用户再次按下听写快捷键开启新一轮录音（新一轮的 live 内容会替换掉上一次的 result）
- 不会自动淡出、不会因焦点切换消失、不会因点击其他位置消失。
- 视觉差异：Live 阶段使用 accent 色边框 + tag (READY/LISTENING/TRANSCRIBING/INJECTING)；Result 阶段恢复默认灰边框 + tag `// RESULT` + 副文案"已写入输入框 · 按快捷键开始下一次"。

理由：录音结束 → injecting 200ms → idle 太快，用户根本看不清自己刚说了什么；保留结果让用户可以核对、复制（未来扩展），与"按快捷键继续下一句"的连续工作流一致。OS 悬浮条不做同样保留，因为它在主窗失焦时才显示，逻辑场景就是"立刻消失让位给目标应用"。

## 详细业务规则

### 触发
1. 快捷键在**任何前台应用**均可生效，包括全屏、游戏、虚拟机窗口。
2. 当 OpenSpeech 主窗口处于焦点时，快捷键依然生效。
3. 当麦克风权限未授予时，触发快捷键必须引导用户前往系统权限设置，不得静默失败。
4. **必须存在可写入的光标焦点**才会开始录音；若系统焦点在不可编辑的区域（桌面、菜单栏、只读窗口），触发时给出轻提示"当前位置无输入框"，不进入 Recording。
5. **后端可用性 Gate（Idle → Preparing 之前）**：必须存在至少一条可用的转写后端，否则**不进入 Recording**。判定：
   - `saasReady = isAuthenticated`（`dictationSource=SAAS` 默认走 OpenLoaf SaaS realtime ASR，需登录）
   - `byoReady  = dictationSource === "BYO" && endpoint.trim() !== ""`（用户自带 REST STT 端点，不经云端）
   - `!saasReady && !byoReady` ⇒ 拦截，按主窗激活与否分两条路径：
     - **主窗激活**（`isFocused() || (isVisible() && !isMinimized())`，覆盖 input focus 在子 dialog / 边栏控件 / 拖拽时短暂失焦的情况）⇒ `useUIStore.openLogin()` 直接弹 LoginDialog，同时 `invoke("show_main_window_cmd")` 兜底拉前台。
     - **主窗已隐藏到 tray 或最小化** ⇒ 走悬浮条 toast + "去登录"动作按钮，避免用户在别的 app 里输入时被强行拉前台打扰。
   LoginDialog 内除两个 OAuth 入口外，提供一个"使用自己的 STT 端点"按钮，点击后关闭登录窗、`openSettings("MODEL")` 跳到设置→大模型 tab 让用户填 endpoint+API Key。Toggle 模式"再按一次停止"路径不受 Gate 影响（已经在录音中，只走停止逻辑）。

### 录音
1. 采样率 / 声道数**跟随系统默认输入设备**（多数 Mac/Win 会是 44.1 kHz 或 48 kHz 立体声）；**不做重采样**，采集到的 f32 原样进 WAV（16-bit PCM 编码）。送到 SaaS realtime ASR 的帧在 cpal 回调里临时做 mono downmix + PCM16 量化，不影响落盘文件。
2. **录音时长无客户端硬上限**——用户一直按着就一直录。唯一的终止条件是服务端 realtime 会话的 2 小时上限（`closed{reason:"max_duration"}`），正常听写远低于此。内存与磁盘占用：`Zeroizing<Vec<f32>>` 按帧追加，2 小时 48kHz 立体声约 1.4 GB RAM + 落盘 WAV 约 700 MB——MVP 不做 early-dump，接近 2h 时用户几乎都主动松手了。
3. 录音过程中按 `Esc` 立即取消：同时 `audio_recording_cancel`（丢 PCM buffer）+ `stt_cancel`（关 realtime WebSocket，丢弃已到达的 Partial / Final）；**本次不写 history**。
4. 录音采集阶段在内存缓冲（`Zeroizing<Vec<f32>>`），**松开快捷键时并行**：Rust 落盘 `recordings/<yyyy-MM-dd>/<id>.ogg`（按本地日期分子目录） + realtime session 发 `send_finish` 等 Final。路径与 DB schema 见 [privacy.md](./privacy.md#录音文件落盘路径) 与 [history.md](./history.md#录音文件)。
5. **内存音频必须 zeroize**：`Zeroizing<Vec<u8>>` 容器承载采集期的 PCM；落盘到 WAV 文件后，内存副本立即 drop（zeroize 自动触发）。panic/崩溃 handler 同样显式清零，避免 crash dump / swap 泄露。
6. **松开事件丢失兜底**：PTT 模式下若用户按下后立即 Cmd+Tab 切走应用，`tauri-plugin-global-shortcut` 的 Released 事件可能丢失。应用在进入 Recording 时，全局键事件监听线程（`rdev`）同时订阅所有已注册快捷键的修饰键 keystate；每 200 ms 查询一次当前物理键状态，若检测到原组合已全部释放则主动触发"松开"逻辑。无客户端时长硬上限，松开事件兜底只靠 keystate 轮询 + 服务端 2h max-duration。
7. **录音设备变更**：录音中若系统默认输入设备切换（拔耳机 / 切蓝牙），cpal 会发出 device change 事件；静默 rebind 到新默认设备，悬浮条闪一下 `DEVICE SWITCHED` 提示，录音不中断；若 rebind 失败则进入 Error。
8. **麦克风被其他应用抢占**：cpal stream error → 立即进入 Error，错误文案"麦克风被其他应用占用"。

### 转写（通过 OpenLoaf SaaS realtime ASR）
1. **走 `openloaf-saas` Rust SDK 的 `client.realtime().connect("realtimeASR")` WebSocket 通道**，不是传统 REST 批量上传。cpal 回调边录边把 PCM16 帧喂给 session，服务端边识别边下发 Partial/Final/Credits 事件。实现见 `src-tauri/src/stt/mod.rs`；SDK 用法见 skill `.claude/skills/openloaf-saas-sdk-rust/`。
2. 按下快捷键 → `startRecordingToFile(id)` 成功后立刻 `startSttSession()` 建连并发 start 帧（`lang=zh / sampleRate=<设备原生> / channels=<设备原生> / encoding=pcm16`），cpal 回调自此把每帧都转发到 realtime worker。
3. 松开快捷键 → `stopRecordingAndSave` 与 `finalizeSttSession` **并行** `allSettled`：前者落 WAV，后者发 `send_finish` 等最多 `FINALIZE_WAIT_MS = 3s` 拿 Final。Final 非空 → history.status=success；空串 / 超时 / session 异常 → history.status=failed（text 占位 `（未能获取转写结果）`）。
4. **未登录直接拒**：`stt_start` 会先检查 `OpenLoafState::authenticated_client()`；未登录则不建 WS 连接，仅本地录音 + 落 history 占位文字。**正常路径下不会到这里**——前端 Gate（见上文"触发 §5"）已经把"既未登录又没配 BYO"的情况拦在 Idle，Rust 这层只做兜底（例如 token 过期还没刷成功就触发录音的瞬态）。
5. **余额不足**：服务端下发 `closed{reason:"insufficient_credits"}`；前端 `openspeech://asr-closed` 监听到后立即切 Error 态，文案"余额不足，已取消本次转写"。
6. **idle 60s / 2h max-duration** 服务端会主动关 session——hold-to-speak 持续发帧天然续活；用户真按满 2 小时时触发 `closed{reason:"max_duration"}`，视为会话结束，history 按 failed 落（Final 没拿到）。
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
