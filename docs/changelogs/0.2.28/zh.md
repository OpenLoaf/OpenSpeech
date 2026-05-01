## v0.2.28

> 0.2.28 是 0.2.27 之后体验侧的一次较大打磨：**录音音质**、**自动更新更稳**、**Settings / History 等核心页 UI 重做**、**促销页换装**。日常听写流程不变，但很多细节会让你觉得"舒服了一截"。

### 新增

- **录音通路新增 DC blocker + 80Hz 高通 + 软限幅**：低频隆隆声（空调、桌面共振、抓握麦克风的低频噗噗声）显著降低；偶发爆音不再被硬削，转写更稳。
- **后台 idle 检测**：长时间无操作时主动让出资源，降低续航占用与无谓的全局监听负载。
- **自动更新调度器**：单独抽出 `updateScheduler` 调度模块，启动期与定时复检解耦，更新提示出现得更及时也更克制；macOS 升级完成后主窗会被前置，不再"看起来没启动"。
- **促销页（首页落地页）换装**：新增 Aurora 背景与 Features 板块，Hero / Demo / FAQ / 顶部导航同步重做，体感上不再像早期那种"开发 demo 页"。

### 改进

- **Settings 页结构重整**：分组与跳转更直观，i18n 三语（zh-CN / zh-TW / en）文案同步打磨。
- **History 页改进**：列表与筛选体验优化，长时间使用更顺手。
- **Layout / HotkeyPreview / Home / Dictionary 多处 UI 细节打磨**。
- **悬浮条 overlay 全局监听层增强**：状态切换更稳，配合 idle 检测减少多余轮询。
- **transcribe / openloaf / db 模块协同调整**：录音 → 转写 → 注入这条链路的内部状态衔接更紧。
- **日志输出**：终端日志不再重复输出两次，日志文件回到单一目录，时间戳改为本地时区，自查问题更直观。
- **OpenLoaf SaaS 接入**：调用方信息上报与错误处理沿用 0.2.27 的方向继续打磨。

### 修复

- **macOS 自动升级完成后主窗被压在其他窗口之后**：升级重启时主窗会被提前到 key window，不再让人误以为应用没启动。

### 内部 / 发版工作流

- **下载清单**：CI 在 stable Release 和 COS 上同时生成 `download.json` / `download-stable.json` / `download-beta.json`，给官网下载页与第三方接入方提供用户友好的 dmg / -setup.exe / AppImage 直链。聚合入口 `download.json` 仍然 stable 优先。
- **`channel-beta` 滚动指针 release 同步上传 `download-beta.json`**，beta 通道接入方可直接拉。
- **Skill 文档拆分**：`.claude/skills/openspeech-dev` 和 `openspeech-release` 拆出 `references/` 子文档，主 SKILL 精简为导航，AI 助手按场景按需加载。

### 升级提示

- **0.2.28 也会推送给 Beta 通道用户**：发布同时刷新 stable 与 beta 两路 manifest，Beta 用户会收到这个 stable 版本（SemVer 0.2.28 > 0.2.28-beta.0）。
- **本版跳过了灰度直接转正**：0.2.28-beta.0 之后的累计改动较多，包含录音通路与 overlay 的底层调整，遇到任何回归请第一时间反馈。
