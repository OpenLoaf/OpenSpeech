## v0.2.30-beta.7

> 测试版，仅 Beta 通道用户可收到。本轮重点：**翻译听写改用两阶段独立 prompt pipeline**、**录音首尾静音自动裁剪 + 底噪假阳兜底**、**新增「会议转录」页面骨架**、Toolbox 大改。
>
> 注：v0.2.30-beta.6 因 Cargo release profile 配置问题导致 Linux build 时长翻倍，那一版未发布；本版替代它，所有用户改进同步落地。

### 翻译听写

- **翻译听写改成 refine → translation 两阶段独立调用**：之前 raw transcript 直接给 translation prompt，导致"嗯/啊/呃"等口语助词和撤回信号无法被处理（说"如果呃不对，我想说的是…"会被逐字翻译）。改成 phase 1 走 refine prompt 清洗、phase 2 走 translation prompt 翻译 phase 1 输出，两个 prompt 各自缓存命中、各自迭代不互相影响。
- **新增「翻译输出形态」设置**（设置 → 通用 → 翻译输出）：
  - `仅目标语言`（默认）：单次注入译文，最快
  - `双语（原文 + 译文）`：先注入清洗后的源文，单换行分隔，再追加译文
- **悬浮条新增「正在翻译中…」状态**：phase 2 期间单独显示翻译进度，跟「思考中」「输出中」分开。

### 录音 / 转写

- **落盘前首尾静音自动裁剪**：松开按键后跑一次离线 webrtc-vad 找首尾 voice 边界 + 300ms padding，前后没说话的部分不再进入录音文件 / ASR / 历史；整段无人声直接跳过转写。
- **VAD 加二级 RMS 能量门**：webrtc-vad Aggressive 模式仍会把低能 babble / HVAC 嗡嗡判成 voice，叠一层 ≈ -40 dBFS 能量门挡掉环境底噪假阳。
- 阿里云 / 腾讯云 realtime ASR session 连接稳定性补丁。

### 新页面：会议转录（Meetings）

- 左栏导航新增「会议转录」入口（icon: 麦克风），目前是 idle/live/paused/review 四态 UI 骨架，长录音 + 自动分人 + 时间轴回看预览。**业务尚未接入 ASR**，仅 UI mock，欢迎反馈交互手感。

### Toolbox 翻译 / 润色 / 朗读

- **剪贴板检测**：粘贴板有内容时给「粘贴并翻译」「仅粘贴」两个快速入口。
- **目标语言扩展到 8 语**：英 / 简中 / 繁中 / 日 / 韩 / 法 / 德 / 西。
- 运行结果区加耗时与字数 metadata footer。

### 历史记录

- 列表无限滚动加载更多 + 「已到底 · 共 N 条」尾标。
- 详情页可单独切换查看「译文」视图（仅翻译听写记录）。

### 其它

- **修首屏按系统语言闪一帧**：i18n 偏好读取改 await，避免主窗先按 navigator.language 渲染再切到用户偏好。
- 设置页：「快捷键 → 全部恢复默认」入口；AI 优化栏文案 `AI provider` → `AI channel`。
- Layout 顶部 Time/Credits 栏视觉微调（字号 + icon 尺寸 + 对齐）。

### 内部

- 修 Cargo `[profile.release]` 误带 `debug=true / strip=false`：之前 Linux build 因为 Rust 依赖 debug info 全进 ELF，链接 + 三件套打包时间从 ~10 min 翻到 26+ min；本版恢复默认 strip 行为。
- 新增 `scripts/profile-rust.sh` 性能 profiling 工具链（cargo flame 用 `profiling` profile 跑 sample analysis）。

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.30-beta.7`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。

### 想让 Beta 用户帮忙验

- **翻译听写**：说带口语助词 / 撤回（"如果呃不对，我想说的是…"）的中文，确认译文干净不含 um/uh、撤回部分被丢弃。
- **双语输出**：在「翻译输出」切到「双语」，确认先看到中文整理稿、单换行后接英文译文。
- **首尾静音裁剪**：按下快捷键后等半秒再说、说完后过半秒再松，确认录音文件 / 历史里前后那段静音被裁掉；纯环境底噪录音应判定为"无人声"跳过 ASR。
- **会议转录页**：点左栏「会议转录」看 UI 骨架，反馈布局 / 文案 / 入口直觉是否合理。
