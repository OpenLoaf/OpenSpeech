# 录音 / realtime ASR 协作约定

> 何时读：改录音、改 STT、调 SaaS realtime ASR 集成、改触发录音的 gate 逻辑、加新 provider、**新增任何直连 SaaS（realtime / file 转写 / chat completions / V4 tools）的链路**。
> 真相来源：`src-tauri/src/stt/mod.rs` + `src-tauri/src/local_asr/` + `src-tauri/src/audio/` + `src-tauri/src/transcribe/mod.rs` + `src-tauri/src/ai_refine/mod.rs` + `src-tauri/src/openloaf/mod.rs` + `src-tauri/src/dictation/` + `src/lib/stt.ts` + `src/stores/recording/`。事件名 / 命令名 / payload 直接读源码。
> 用法权威 = 全局 `hex-openloaf-saas-sdk` skill（含 Rust crate）。

---

## SaaS access_token 续期协作

**任何"直连 SaaS"的链路（realtime ASR、saas-file 转写、ai_refine chat、未来新增的 V4 tool）都必须满足两条契约**，否则会把用户从登录态踢出：

1. **B / 请求前预检**：进入 SDK / reqwest 之前 `await OpenLoafState::ensure_access_token_fresh()`。返回 false 才走 `handle_session_expired`。
2. **C / 401 → refresh & retry**：第一次 401 不要立刻清场；先 `await OpenLoafState::ensure_fresh_token()` 续期，用新 token 重发一次；重发还 401 / refresh 本身失败才 `handle_session_expired`。

**为什么不能省**：access_token TTL 1 小时，正常期间 SDK 后台定时器自动 `/auth/family/exchange` 续期。**电脑睡眠时定时器不跑** —— 唤醒后第一次请求带的 JWT 必然过期，服务端返 401，如果直接 `handle_session_expired` 用户就被踢登录了。日志中表现是：`session applied exp=…` 之后接近 1 小时没有 `access token refreshed via Family`，唤醒后第一次 `transcribe dispatch` 后没有对应 `ai_refine done`，且 UI 弹回未登录态。

**走 `call_authed` 的 SDK 调用已自带 C** —— 包到 `op` 闭包里直接用。`reqwest` 直连（如 ai_refine 的 SSE 流）、裸 SDK 调用（如 `tools_v4().asr_short_ol_tl_003`）需要自己实现 B+C。

**长 polling 路径（asr_long）**：polling 循环时间 ≤ 24 min < TTL，polling 期间过期概率极小；只在入口做 B 即可，循环内单次 401 仍允许走原清场路径。

**调试关键日志**（在 `src-tauri/src/openloaf/mod.rs`、`transcribe/mod.rs`、`ai_refine/mod.rs` 内）：
- `access token near/past exp, kicking off pre-flight refresh` — B 触发
- `call_authed got 401, attempting refresh + retry` / `retry after refresh succeeded` — C 走通
- `retry still 401 after refresh; clearing session` — 真正的会话失效

排查"用户莫名被登出"：先看日志窗口内有没有 `access token refreshed via Family`，再看最后一次请求是不是接到了 B/C 链路。

---

## realtime ASR 协作约定（OpenLoaf SaaS）

### 线程模型
- `RealtimeSession` 内含 `std::sync::mpsc::Receiver`（!Sync），**不能 Arc 跨线程**。
- 必须"session 单所有者 + worker 线程独占 + `mpsc::Sender<Control>` 进 worker"模式。

### close 不显式调
- `close(mut self)` 吃所有权 —— **不要显式调**。
- 让 Drop 自动发 Close 帧。

### 类型标注
- `send_start` 第二参数 `None` 时显式标类型：`None::<serde_json::Value>`。

### PCM 格式
- PCM 帧 = **PCM16 LE bytes**，channels = **1**。
- cpal 默认 f32 多 ch，必须在 audio callback 里就地下混 mono + 量化。
- `stt_start` 的 `send_start` 也必须报 `channels:1`，否则服务端按 2ch 解析全错位。

### 采样率
- 不重采样，跟随设备原生 sr 透传给服务端。

### feature ID 大小写
- **是 `realtimeAsr`（小写 sr），不是 `realtimeASR`** —— 错了 WS 握手直接 500。

### 未登录路径
- `stt_start` 返 `"not authenticated"`。
- 前端只 `warn`，**录音继续**，history 落占位文字。
- 不要因 SaaS 未登录禁录音。

### 离线快速测试
- debug build 在 `apply_session` 时 dump session 到 `~/.openspeech/dev_session.json`（chmod 600，release 编译掉）。
- 配套 `cargo run --example test_realtime_asr` 绕开 audio/hotkey 直测 SDK ↔ SaaS。

---

## 听写会话状态机归 Rust（`src-tauri/src/dictation/`）

状态图、事件、上报命令与不变量的权威 = `docs/voice-input-flow.md`「状态机」节；这里只记实现约束。

- **前端只渲染、只发意图**：`stores/recording/store.ts` 是快照投影，`worker.ts` / `pipeline.ts` 跑 ASR / 整理 / 历史，所有上报带 session_id，过期会话的上报 Rust 一律丢弃。不要在前端重新推导状态或另起 FSM。
- **开录鉴权在 Rust**（`dictation::on_hotkey`）：已登录或 `customDictationReady`，否则静默恢复登录 ≤1.5s，仍失败发 `blocked`，**绝不打开麦克风**。
- **状态出口不能挂在主窗 timer 上**：听写期间主窗是隐藏 webview，`window.setTimeout` 会被节流甚至永不 fire（曾导致 FSM 永久卡在「转录中」、按键全被吞）。复位 / 回收逻辑放 Rust 状态机（如 Failed 2.5s 自动回 Idle），前端收尾用微任务，视觉淡出交给可见的悬浮条窗口。

## 听写采集：open / save / discard 成对，全在 Rust

`audio::open_dictation_capture` / `save_dictation_capture` / `discard_dictation_capture` 只由 `dictation` runtime 调用，前端不参与 cpal 引用计数。**单一不变量：一次听写的 cpal ref 只取一次、放一次。**

- `dictation_capture()` 锁跨 `start()` / `stop()`：open 未完成时到来的 discard 会等 open 结束再释放，不漏放 ref。open 失败的每个分支都要回滚已取的 ref 并 disarm 预录。
- open 是阻塞的（cpal 冷启动 ~100ms），调用方放后台线程，不能阻塞 rdev 键盘线程。
- 录音 id 由 Rust `audio::new_recording_id` 生成，格式必须与前端 `src/lib/ids.ts::newId` 一致（同时是会话 id、录音文件名、历史 id）。
- **预录缓冲（开头丢字）**：麦克风在按键当帧就开，但实时会话要等主窗收到 `dictation/started` 再 invoke `stt_start`，节流时迟到 1–5s（日志 `dictation capture opened` 与 `[worker] session started` 的时间差）。这段帧以前被 `try_send_audio_pcm16` 当「无会话」丢掉 → 本地模型 / 边说边出字模式丢开头几个字。`stt` 模块有预录缓冲：`open_dictation_capture` 开流前 arm、save/discard disarm，会话进 slot 时及之后首帧按序补发（日志 `preroll flushed`）。新增听写采集的开/收路径必须配对 arm/disarm。
- **验证盲区**：ref 配平是集成级，单测覆盖不到；改采集路径后必须真机 `pnpm tauri dev` 盯 macOS 状态栏橙点确认不泄漏。

---

## 会议「暂停」= 真停麦克风

会议录制的 pause **必须停掉 cpal 采集流**（前端 `stores/meetings.ts::pause()` 调 `stopAudioLevel()`、`resume()` 调 `startAudioLevel()`），不能只设 Rust `meeting_pause` 的 paused flag。只设 flag → cpal stream 一直跑 → **macOS 状态栏橙色录音指示灯常亮** → 用户以为「点了暂停还在录」（用户实报 bug）。

- **历史误设计**：早期注释声称「pause 时 audio writer 仍照录以保持音频/字幕时间线对齐」，但上游 `meetings/mod.rs::try_send_audio_pcm16` 在 paused 时就 `return` 丢帧，worker `run_session` 那段「pause 也写盘」根本收不到帧 —— 时间线对齐**从未生效**，代价（指示灯常亮）却照付。所以「真停麦克风」不牺牲任何既有行为。
- **ref_count 配平**：cpal stream 的 ref_count 是 **dictation 与 meetings 共享的全局单例**。会议用 module-level `holdsAudioRef` 跟踪「当前是否持有 1 份 ref」：live 持有、paused 释放；`stop()`/`cancel()` 只在持有时 `stopAudioLevel`，否则从 paused 态 stop 会多减一次别人的 ref。`audio::start` 失败时 ref 不递增，故 resume 失败分支保持 `holdsAudioRef=false`。
- **顺序契约**：pause 先 `meeting_pause`（设 flag 丢在途残帧）再 `stopAudioLevel`；resume 先 `startAudioLevel`（流就绪）再 `meeting_resume`（清 flag 放行识别）。resume 时 `startAudioLevel` 返回 false（设备被拔/占用）必须保持 paused + 报错，绝不在没有麦克风流时清 flag。
- **暂停必须挂起 ASR session（否则 4008 杀会议）**：服务端腾讯 idle 15s 收不到音频会发 4008，真停麦克风后必然触发。worker 用 `SessionExit::Paused` 主动关 session：`run_session` loop 顶 `if !finished && paused` 退出 → `event_pump` Paused 分支 `drop(session)` 关 WS → 等待 resume(`!paused`)/stop(`audio_rx` Disconnected) → `open_session_await_ready` 重建（无 backoff、不计 reconnect_attempts）。复用既有 reconnect 的 `sentence_id_offset`/`time_offset_ms` 续接。**4008 在非暂停时仍走 `SessionExit::Error` 结束会议**（真网络问题，不动）。
- **time_offset 锚 `audio_writer.written_ms()`，不是 vendor `end_ms`**：vendor end_ms 不含尾部静音，每次暂停/重连都让新段字幕 seek 越攒越早。reconnect 与 resume 两处结转都用 OGG 实际写入时长。**resume 的结转必须在握手写盘之后**：resume 握手窗口（最多 8s）cpal 已采集真实音频，要 `push_pcm16` 写盘保 OGG 连续，再 `time_offset_ms = written_ms()`——否则新段字幕早握手那段时长。
- **暂停放行听写**：`hotkey::maybe_block_for_meeting` 用 `meetings::is_capturing()`（有会议 **且非暂停**）而非 `has_active()`，暂停态放行听写/翻译/Ask；audio fanout 仍用 `has_active()`（暂停时 try_send 内部 paused gate 丢帧）。
- **pause/resume 并发守卫**：两者是 async，await 期间 view 还没翻，入口 gate 拦不住二次进入/与 stop 交错 → 双击致共享 ref_count 失衡（橙点不灭 / 误停听写）。用 module-level `pauseResumeInFlight` + 每个 await 后复查 view（被 stop 抢走则回滚已加的 cpal ref 再退出）。stop 走自己的 `stopInFlight`（用户结束动作不该被 pause/resume 挡）。resume 入口还须挡「听写进行中」（`useRecordingStore.getState().activeId !== null`）——UI「继续」按钮绕过 hotkey 拦截，否则两路同抢 cpal、听写串进会议字幕。

## AI refine 后处理三级 hold 与 `driftGuard` 只开听写

`run_refine_core` 的 SSE 消费链是 **context-leak filter → drift guard → trailing-period stripper** 三级 hold 串联，任何新加的"输出先看一眼再放"逻辑都插到这条链里，不要另起一条独立缓冲——否则前端 `injectIncremental` 的 typedLen 前缀假设会被打破（已注入的字撤不回）。

`RefineChatInput.driftGuard` 是**调用方契约**，Rust 不做默认开：听写 refine（`stores/recording/pipeline.ts` + `stores/history.ts` 重试）传 `true`；翻译 phase 2 / 润色 / 会议摘要 / 标题 / 设置页测试按钮 **不传**。开错地方的症状是"译文被换回原文"——译文与原文零字符重叠，守卫必判离题。同一个开关还控制 Guard 末尾的「输出只能来自正文」锚定句（`guard_section(lang, anchor_to_body)`）——翻译路径误开会被 prompt 要求逐词对应原文，译不出来。

`MessageContext.requestTime` 对 refine 是幻觉诱因（正文「下午的行程是点点点点点」被填成「上午九点十五分」= 当时的系统时钟），且坏输出会经 ConversationHistory 级联污染后续每条。守卫兜住的是"整段离题"；"前半句照录、后半句凭空补一个时间"这种局部幻觉守卫抓不到，只能靠 prompt r3 的「补全值只能来自正文」约束。细节见 `docs/ai-refine.md` 离题守卫一节。

听写 refine 的 `buildSpeechSystemPrompt` 必须传 `refineContext: true`（不带 ConversationHistory、MessageContext 只留 platform / audioDuration、TargetApp 不带 focusTitle）。OL-TX-025 会把 system prompt 里任何文字当素材抄进输出，history 是被抄最多的；新增 refine 调用点漏传这个参数，就会重新打开「输出成上一条」的口子。同理，给 `defaultAiPrompts.ts` 加示例前先跑 eval——一条长而具体的示例曾让终端 target 三成输出编造内容。

**项目上下文（Orca）**：Orca 窗口标题恒为「Orca」、一个窗口装几十个项目，按 target_app 取历史会串项目；所以开录时查 Orca 本机 RPC 拿选中项目目录，历史按 `history.project` 取。查询和开麦克风并行、STARTED 前 join（实时 ASR 上下文在 STARTED 时组装），松手时不再查（沿用起点项目）。只走 RPC 不读它的 profile-state.db：库里 `activeWorkspaceKey` 是陈旧值，`activeWorktreeId` 也有 1–5s 延迟。

## 本地离线模型（mode=local）

产品规则见 `docs/settings.md`「本地模型」+ `docs/privacy.md`；这里只记实现层的取舍。

- **选型依据**：`scripts/local-asr-bench/bench.py` 用本机真实听写录音（150 条，按时长分层）对比云端结果测差异率 / 延迟 / **真实峰值内存**。catalog 的 `memory_mb` 就是这个脚本的实测值，UI 直接展示；换模型必须重测，不许拿权重大小代替（Fun-ASR-Nano 权重 < 1GB 但峰值 2.5GB）。产品硬约束：峰值内存 ≤ 1GB。
- **绝不静默回退 SaaS**：`byok::dispatch` 对 local 缺模型返回 `local_model_not_selected`（`should_fallback_to_saas() == false`），与 custom 未配置时自动回退相反——用户选离线就是不想上传。
- **推理放子进程，按需启动**：同一个二进制带 `--local-asr-host` 启动（`main.rs` 在 Tauri 之前分流），stdin 二进制帧 / stdout JSON 行通信。不放进程内的原因是实测：macOS 上 onnxruntime 释放的内存留在 malloc 池不还系统，反复加载卸载后稳定占 200~290MB，「闲置卸载」省不下；子进程退出则全额归还，还顺带隔离 onnxruntime 崩溃。闲置 5 分钟无会话 kill；主进程死了子进程 stdin EOF 自退。
- **加载期间不能丢音频**：冷启动约 1.5s。会话必须先进 stt slot 再加载（`LocalRealtimeBackend` 在 worker 线程里 `HostSession::open`），否则 `try_send_audio_pcm16` 把这 1.5s 的帧当「无会话」丢掉；host 的 writer 线程配无界队列，子进程 stdin 管道满了也不反压录音链路。
- **一次一路流**：实时听写与历史重试共用一个子进程，`SessionGate` 串行化；reaper 只在 gate 空闲时回收。
- **尾部静音 1.0s**：0.5s 不够，X-ASR（160ms chunk 带 look-ahead）句尾会丢最后一个字。
- **整句模式也走流式**：本地推理无网络成本，`worker.onStarted` 对 local 无视 segmentMode 开实时会话（`session.localStream` 开录冻结），松键只剩尾句要算；是否逐段注入仍只看 REALTIME。
- **finalize 提前返回**：`stt/mod.rs` 的 `stream_ended` 在 worker 因 EndOfStream/Closed/Error 退出时置位，`stt_finalize` 见到即返回，不再死等 800ms 尾包窗口（云端也受益）。本地收尾上限放宽到 30s（低配机解码落后于实时时，3s 截断会丢尾句）。
- **离线 + SaaS 整理 + 未登录**：`pushConfig` 直接把 refineEnabled 置 false——否则整理 401 会弹登录框打断刻意离线的用户。
- **模型下载源**：R2 bucket `openspeech` 的 `models/asr/<归档原名>`，顺序为腾讯 CDN（国内）→ R2 自定义域 → GitHub Release 兜底（国内直连 GitHub 实测 100~200KB/s 且常断流，所以断点续传必须保留）。对象永不覆盖：换归档就换文件名，同时更新 sha256。`models/` 不是版本前缀，`r2-cleanup-beta.yml` 按 `v<semver>` 白名单识别版本，否则 `sort -V` 会把 `models` 排成「最老正式版」删掉。R2 下行免费，只按 Class B 请求计费，模型分发几乎零成本。

## 跳过 AI 优化的取消约定

听写跳过 AI 优化必须能打断等待响应头与 SSE 下一帧的请求，不能等上游再发内容才检查取消；否则模型首 token 慢时，快捷键与“跳过”按钮都会失效。行为规则见 `docs/voice-input-flow.md`。

取消时也要由 Rust 先关闭本会话的流式注入：主窗可能尚未收到跳过事件，迟到的 AI delta 若先落字，原文与已注入前缀不一致就只能降级剪贴板；原文收尾输出仍沿用同一会话。

实现入口：取消包装 = `ai_refine::until_cancelled`（新增的 refine 请求路径都要套上它）；关流式注入 = `dictation/output.rs::disable_streaming`；触发 = `dictation/machine.rs` 的 `Intent::SkipRefine`（只在 Refining 且本轮同一快捷键时生效，refine 关闭时为 no-op）。

## 隐私边界（呼应 `docs/privacy.md`）

- 录音仅落盘本机：`app_data_dir/recordings/<id>.wav`。
- 除登录态下的 SaaS realtime ASR 外不发任何服务器。
