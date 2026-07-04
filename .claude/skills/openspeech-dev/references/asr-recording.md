# 录音 / realtime ASR 协作约定

> 何时读：改录音、改 STT、调 SaaS realtime ASR 集成、改触发录音的 gate 逻辑、加新 provider、**新增任何直连 SaaS（realtime / file 转写 / chat completions / V4 tools）的链路**。
> 真相来源：`src-tauri/src/stt/mod.rs` + `src-tauri/src/audio/` + `src-tauri/src/transcribe/mod.rs` + `src-tauri/src/ai_refine/mod.rs` + `src-tauri/src/openloaf/mod.rs` + `src/lib/stt.ts` + `src/stores/recording.ts`。事件名 / 命令名 / payload 直接读源码。
> 用法权威 = 同目录软链 `openloaf-saas-sdk-rust` skill。

---

## SaaS access_token 续期协作（栽过坑，2026-05-06）

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

### PCM 格式（栽过坑，2026-04-25）
- PCM 帧 = **PCM16 LE bytes**，channels = **1**。
- cpal 默认 f32 多 ch，必须在 audio callback 里就地下混 mono + 量化。
- `stt_start` 的 `send_start` 也必须报 `channels:1`，否则服务端按 2ch 解析全错位。

### 采样率
- 不重采样，跟随设备原生 sr 透传给服务端。

### feature ID 大小写（栽过坑，2026-04-25）
- **是 `realtimeAsr`（小写 sr），不是 `realtimeASR`** —— 错了 WS 握手直接 500。

### 未登录路径
- `stt_start` 返 `"not authenticated"`。
- 前端只 `warn`，**录音继续**，history 落占位文字。
- 不要因 SaaS 未登录禁录音。

### 离线快速测试
- debug build 在 `apply_session` 时 dump session 到 `~/.openspeech/dev_session.json`（chmod 600，release 编译掉）。
- 配套 `cargo run --example test_realtime_asr` 绕开 audio/hotkey 直测 SDK ↔ SaaS。

---

## 触发录音 Gate（`recording.ts::start`）

按顺序拦截，任一命中即放弃本次录音：

1. **未登录且未配 BYO endpoint** → `useUIStore.openLogin()`。
2. **SAAS 路径 + `navigator.onLine === false`** → 同步拦截 + `openNoInternet()`。
3. **SAAS 路径乐观启动后异步 `invoke("openloaf_health_check")`**，false 且仍在 preparing/recording → 回滚 + 弹无网络。

---

## FSM 复位禁用可节流 timer（栽过坑，2026-06-04）

`recording.ts` 的 FSM `transcribing/injecting → idle` 复位**绝不能**靠 `window.setTimeout`。听写期间主窗是隐藏 webview，其 timer 会被 Chromium/WebView2 background timer throttling 节流甚至冻结（hidden-page），延迟可达数十秒乃至永不 fire。旧版 toggle-off（`setTimeout(...,300)`）与 `simulateFinalize`（`setTimeout(...,800)`）都把唯一的回 idle 出口挂在这种 timer 上 → 0.2.49 Windows "一直在转录中"：finalize 全部微任务（tail/paste/hint）正常跑完，唯独那帧 idle timer 不 fire，FSM 永久卡 injecting、PTT 被 "非 idle 一律 IGNORED" 守卫全吞、只能重启。

规约：复位走 `finalize().then()` 的**微任务里立即 set idle**（微任务不被节流）+ `.catch` 兜 reject；守卫必须含 `injecting`（onChunk 流式首段会把 transcribing→injecting）；视觉收尾停顿交给可见的 overlay 窗口自己的淡出，不要塞回主窗 timer。回归测试：`stores/recording.stuck-injecting.repro.test.ts`（变体 C/D 在"timer 永不 fire"下断言仍回 idle）。

---

## 会议「暂停」= 真停麦克风（栽过坑，2026-06-08）

会议录制的 pause **必须停掉 cpal 采集流**（前端 `stores/meetings.ts::pause()` 调 `stopAudioLevel()`、`resume()` 调 `startAudioLevel()`），不能只设 Rust `meeting_pause` 的 paused flag。只设 flag → cpal stream 一直跑 → **macOS 状态栏橙色录音指示灯常亮** → 用户以为「点了暂停还在录」（用户实报 bug）。

- **历史误设计**：早期注释声称「pause 时 audio writer 仍照录以保持音频/字幕时间线对齐」，但上游 `meetings/mod.rs::try_send_audio_pcm16` 在 paused 时就 `return` 丢帧，worker `run_session` 那段「pause 也写盘」根本收不到帧 —— 时间线对齐**从未生效**，代价（指示灯常亮）却照付。所以「真停麦克风」不牺牲任何既有行为。
- **ref_count 配平**：cpal stream 的 ref_count 是 **dictation 与 meetings 共享的全局单例**。会议用 module-level `holdsAudioRef` 跟踪「当前是否持有 1 份 ref」：live 持有、paused 释放；`stop()`/`cancel()` 只在持有时 `stopAudioLevel`，否则从 paused 态 stop 会多减一次别人的 ref。`audio::start` 失败时 ref 不递增，故 resume 失败分支保持 `holdsAudioRef=false`。
- **顺序契约**：pause 先 `meeting_pause`（设 flag 丢在途残帧）再 `stopAudioLevel`；resume 先 `startAudioLevel`（流就绪）再 `meeting_resume`（清 flag 放行识别）。resume 时 `startAudioLevel` 返回 false（设备被拔/占用）必须保持 paused + 报错，绝不在没有麦克风流时清 flag。
- **暂停必须挂起 ASR session（否则 4008 杀会议）**：服务端腾讯 idle 15s 收不到音频会发 4008，真停麦克风后必然触发。worker 用 `SessionExit::Paused` 主动关 session：`run_session` loop 顶 `if !finished && paused` 退出 → `event_pump` Paused 分支 `drop(session)` 关 WS → 等待 resume(`!paused`)/stop(`audio_rx` Disconnected) → `open_session_await_ready` 重建（无 backoff、不计 reconnect_attempts）。复用既有 reconnect 的 `sentence_id_offset`/`time_offset_ms` 续接。**4008 在非暂停时仍走 `SessionExit::Error` 结束会议**（真网络问题，不动）。
- **time_offset 锚 `audio_writer.written_ms()`，不是 vendor `end_ms`**：vendor end_ms 不含尾部静音，每次暂停/重连都让新段字幕 seek 越攒越早。reconnect 与 resume 两处结转都用 OGG 实际写入时长。**resume 的结转必须在握手写盘之后**：resume 握手窗口（最多 8s）cpal 已采集真实音频，要 `push_pcm16` 写盘保 OGG 连续，再 `time_offset_ms = written_ms()`——否则新段字幕早握手那段时长。
- **暂停放行听写**：`hotkey::maybe_block_for_meeting` 用 `meetings::is_capturing()`（有会议 **且非暂停**）而非 `has_active()`，暂停态放行听写/翻译/Ask；audio fanout 仍用 `has_active()`（暂停时 try_send 内部 paused gate 丢帧）。
- **pause/resume 并发守卫**：两者是 async，await 期间 view 还没翻，入口 gate 拦不住二次进入/与 stop 交错 → 双击致共享 ref_count 失衡（橙点不灭 / 误停听写）。用 module-level `pauseResumeInFlight` + 每个 await 后复查 view（被 stop 抢走则回滚已加的 cpal ref 再退出）。stop 走自己的 `stopInFlight`（用户结束动作不该被 pause/resume 挡）。resume 入口还须挡「听写进行中」（`useRecordingStore.getState().activeId !== null`）——UI「继续」按钮绕过 hotkey 拦截，否则两路同抢 cpal、听写串进会议字幕。

## 采集下沉:Rust 在 hotkey 按下当帧预开 cpal,前端 adopt(栽过坑,2026-07-01)

**病**:听写 FSM 跑在主窗 webview;主窗隐藏时被 macOS WKWebView 节流,Tauri hotkey `listen` 回调延迟 2–4s → 用户以为没反应连按 → epoch 去抖把多余点按收掉 → 「按好几次才录上」+ 节流期语音丢失。Rust `pressed: dictate_ptt` 与前端 `[recording] event received` 的时间差(正常 <1s,卡顿 2–4s)是判据。

**修**:采集生命周期从前端下沉到 Rust,前端从「驱动」变「接管」。**单一不变量:一次听写的 cpal ref 只取一次、放一次。**
- Rust:`is_recording_binding` 按下 → `audio::preopen_dictation_capture`(fire-and-forget 后台线程,**不阻塞 rdev**——`start()` cpal 冷启动 ~100ms)→ `ensure_dictation_capture`(**持 `DICTATION_CAPTURE` 锁跨 `start()` 的原子入口**:rdev 预开与前端 adopt 并发只有一个真 start,另一个等锁后 adopt,ref 恒 +1)。`DICTATION_ENABLED`(前端按 canRecord 推)gate 预开,未登录不开麦(隐私)。
- 前端(`recording/store.ts`):start 块用 `adopt_dictation_capture` 拿 Rust 生成的 recordingId(chrono 本地时间,对齐 `ids.ts` 格式),**不再 `startAudioLevel`**;`startRecordingSession(id, adopted=true)` 跳过 `audio_recording_start`(否则重置 session、丢预采音频);直接进 `recording`(不再有 preparing 冷启动窗口)。
- **ref 放**:前端 stop/cancel 的 `stopAudioLevel` 放那唯一 +1;flag 由 `audio_recording_stop/cancel/force_stop` 清。
- **释放铁律**:终态放弃(gate 未过 / preflight 失败 / adopt 出错)必须 `release_dictation_capture`(锁串行 stop+清 flag);但 **epoch-stale(被后续 press 抢占)绝不能 release**——那会杀掉获胜 press 已 adopt 的采集。批量迟到场景:press1/2 stale 保留采集,press3 adopt,一段录音。
- **验证盲区**:ref 配平是集成级(单测 FSM 复刻覆盖不到),改后必须真机 `pnpm tauri dev` 盯 macOS 状态栏橙点确认不泄漏。

## 隐私边界（呼应 `docs/privacy.md`）

- 录音仅落盘本机：`app_data_dir/recordings/<id>.wav`。
- 除登录态下的 SaaS realtime ASR 外不发任何服务器。
