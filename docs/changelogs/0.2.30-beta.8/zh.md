## v0.2.30-beta.8

> 测试版，仅 Beta 通道用户可收到。本轮最大变化：**会议转录页接入腾讯实时说话人分离，从 UI mock 切到真实业务**。其余沿用 beta.7 的翻译听写两阶段 pipeline、首尾静音裁剪、Toolbox 改版、首屏闪烁修复等。

### 会议转录（Meetings）正式接入

- **接入腾讯云 16k_zh_en_speaker（实时说话人分离）**：会议页支持长录音 + 自动分人 + 时间轴回看。每位发言人独立段落显示，按 sentence_id / speaker_id 持久化到本地。
  - 当前**仅支持腾讯云**（聪明转写 SaaS 与阿里云暂不提供 speaker diarization 通道）
  - 听写通道需要切到「自定义 → 腾讯云」并配齐 AppID / SecretId / SecretKey；其它通道下点开始会提示 `meeting_provider_unsupported` / `meeting_provider_not_configured`
- **支持语种**：中文 / 英语 / 粤语 / 多种方言（川、陕、豫、沪、湘、鄂、皖）
- 历史记录新增 `meeting` 类型条目；详情页可按发言人时间轴回放整场会议片段。

### 数据库 schema v6（自动迁移）

- `history.type` 增加 `meeting`
- `history` 增加 `meeting_id` 列，会议片段通过它回引主行
- 新表 `history_segments`：每条 final 片段一行（sentence_id / speaker_id / speaker_label / start_ms / end_ms / text），partial 不入库

老用户首次启动 beta.8 会自动跑这次 migration；SQLite 不支持 `ALTER TABLE` 改 `CHECK`，走临时表 + INSERT SELECT + RENAME 重建，原有 dictation / ask / translate 历史无感保留。

### 沿用自 beta.7（v0.2.30-beta.6 / .7 未覆盖到全量用户，列在这里方便从 .5 升上来的用户对照）

- **翻译听写改成两阶段独立 prompt pipeline**：phase 1 走 refine prompt 清洗（处理"嗯/啊/呃" + 撤回信号），phase 2 走 translation prompt 翻译；两个 prompt 各自缓存命中、各自迭代不互相影响。
- **新增「翻译输出形态」设置**：仅目标语言（默认）/ 双语（原文 + 译文）。
- **悬浮条新增「正在翻译中…」状态**：phase 2 期间单独显示。
- **录音首尾静音自动裁剪**：webrtc-vad + 二级 RMS 能量门兜底底噪假阳，纯环境底噪不进 ASR 不落历史。
- **Toolbox 大改**：剪贴板检测、「粘贴并翻译」/「仅粘贴」入口、目标语言扩到 8 语、运行结果加耗时与字数 metadata。
- **历史**：列表无限滚动 + 「已到底 · 共 N 条」尾标；详情页可切「译文」视图。
- **首屏闪烁修**：i18n 偏好读取改 await，避免主窗按系统语言闪一帧再切到用户偏好。
- **Cargo `[profile.release]` 误带 debug 修复**：beta.6 的 Linux build 因为 Rust 依赖 debug info 全进 ELF 链接慢到 26+ 分钟，beta.7 起恢复默认 strip。

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.30-beta.8`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。

### 想让 Beta 用户帮忙验

- **会议转录**：在「听写」设置切到腾讯云 BYOK provider → 进会议页开始录音 → 多人对话场景下确认能正确分人 + 时间轴展示 → 停止后历史里能看到完整会议条目与片段列表。
- **数据库迁移**：从 beta.5 / beta.7 升级时确认旧 dictation / ask / translate 历史完整保留、未丢条。
- **翻译听写**：说带口语助词 / 撤回（"如果呃不对，我想说的是…"）的中文，确认译文干净、撤回部分被丢弃；切到「双语」确认中文整理稿 + 单换行 + 英文译文。
- **静音裁剪**：纯环境底噪录音应判定为"无人声"跳过 ASR，不留下空 history 条目。
