## v0.2.30-beta.16

> 测试版，仅 Beta 通道用户可收到。本轮重点是**AI 领域系统**（最多 3 个领域作为 prompt 头部 system-tag）、**会议实时 ASR · SaaS provider 上线**、**云端转写撞 401 自动续转写**、**快捷键扩展到 4 个 binding**、以及 DEV 构建下的 LLM 请求 debug payload 落库。

### 新增

- **AI · 领域多选（最多 3 个）**：词典页面新增 16 个领域可选——`programming` / `ai_ml` / `cybersecurity` / `design` / `film_production` / `photography` / `marketing` / `finance` / `law` / `academic` / `medicine` / `tcm` / `psychology` / `engineering` / `automotive` / 等。勾选后作为 `<Domains>` system-tag 注入 prompt 头部，让 AI refine 在你的专业语境下更准（例如选 `medicine` 后医学专业名词不再被改成"通俗近义词"）。多语言显示走 i18n bundle，切语言不丢勾选。
- **会议 · SaaS 实时 ASR provider**：会议页面新增"OpenLoaf SaaS"通道（OL-TL-RT-003，腾讯上游），引擎 `16k_zh_en`（8 积分/分钟），鉴权走当前登录用户 access_token，扣费走 SaaS 积分。无需再单独配 BYOK 腾讯密钥即可开会议纪要。说话人分离暂未开启（等 SDK 拉到 `speaker_id` 字段后会切到 `16k_zh_en_speaker` / 12 积分版）。
- **听写 · 401 自动续转写**：录音结束后云端转写撞 401（access_token 过期）会自动弹 LoginDialog，登录成功后**自动用刚才那段录音重新转写一次**，结果直接展示在 AuthRecoveryDialog 里——用户不用重录音。失败时 dialog 也会显示具体 error message，附「复制错误」按钮便于反馈。
- **快捷键 · 4 个 binding**：默认快捷键扩展到 4 个 binding：
  - `dictate_ptt`（听写）
  - `translate`（翻译听写）—— macOS `Fn + Shift(L)` / Windows `Alt(L) + Win(L)` / Linux `Alt(L) + Super(L)`
  - `show_main_window`（唤起主窗口）—— `Ctrl(L) + Alt(L) + O`
  - `open_toolbox`（打开 AI 工具）—— `Ctrl(L) + Alt(L) + T`
- **快捷键 · 启动自检**：从老版本升级上来的 binding 如果命中新规则（modifier-only 单键 / 子集冲突 / fn-combo / Tab 主键等），启动时会自动弹出 HotkeyConflictDialog 让你逐条重录，避免静默失效。
- **DEV 构建 · 调试快照入库**：开发版会把每次 LLM 请求的 URL / model / body（pretty JSON）落到 `history.debug_payload` 列，refine + 翻译 phase2 累积成 JSON 数组。「复制 Debug 信息」按钮直接读这一列，无需实时拼接，复现问题更稳。**正式版本恒为 NULL，不会捕获用户提示词**。

### 改进

- **AI prompt · 默认提示词全套重写**：按 2026 prompt engineering 指南重新拉了一遍 system prompt，听写优化 / 翻译 / 润色 / 会议纪要四类输出更稳定、不再"过度润色"。
- **设置页 · 三类 AI 提示词独立 dialog**：「听写优化」「翻译」「会议纪要」「润色」四类系统提示词全部从内嵌 textarea 改成独立 dialog，主设置页只显示「已自定义 / 默认」状态徽章和「修改」按钮，设置页继续大幅瘦身（−432 行）。
- **词典 · 快速添加 dialog**：新增 QuickDictDialog，可在听写 / 工具箱场景一键唤起添加词典 + 选领域，不必跳到设置页。
- **历史 · 详情面板瘦身**：History 页面详情面板重排，调试信息折叠到次级菜单，主信息区更突出。
- **工具箱 / 词典页面**：UI 重构，信息密度优化，搜索 / 切换更顺手。
- **openloaf-saas · 0.3.16 → 0.3.17**：复用 SDK 内置的 RealtimeAsrSession，避免自己引第二份 WS 栈。

### 修复

- **录音 · IPC 命令幂等**：show_main_window / open_toolbox 等窗口指令在主窗口已聚焦时会短路，不再重复触发动画。

### 升级提示

- 本版本是 SemVer 预发布段（`0.2.30-beta.16`），仅 Beta 通道下发；Stable 通道用户不会收到。
- 切到 Beta 通道：设置 → 关于 → 更新通道 → 选 Beta，重启或托盘「检查更新」。
- **快捷键 schema 升级**：v2 → v3 migrate 完成后启动自检会自动检查存量 binding，如果发现冲突会弹 dialog 提醒重录；升级后建议先到设置 → 快捷键页面看一眼默认 4 个 binding，按需关闭不想要的。
- **数据库 schema v10**：新增 `debug_payload` 列（仅 DEV 构建写入），正式版无感知，无需手动迁移。

### 想让 Beta 用户帮忙验

- **领域多选**：词典 → 领域 → 勾选 3 个（如 `medicine` + `tcm` + `psychology`）→ 录一段含专业名词的口语 → 预期：refined_text 里专业名词不被"通俗化"。
- **会议 SaaS 通道**：会议 → 新建会议 → 实时 ASR 选 OpenLoaf SaaS → 录 30 秒中英混合 → 预期：实时出 partial / final 文本，UI 显示「未分离说话人」提示，扣费在 SaaS 后台可见。
- **401 自动续转写**：在设置 → 账号里手动 logout 后再录一段（让转写在 finalize 阶段撞 401）→ 预期：自动弹 LoginDialog，扫码登录回来后弹 AuthRecoveryDialog 显示 spinner，几秒后变成成功状态展示文本，无需重录音。
- **新增三个 binding**：设置 → 快捷键 → 试 `Ctrl + Alt + O` 唤起主窗口、`Ctrl + Alt + T` 打开 AI 工具、`Fn + Shift` 翻译听写（mac），都应即按即触发。
- **启动自检**：故意把听写 binding 改成命中新规则（如单 Modifier、Tab 主键），重启 → 预期：开机就弹 HotkeyConflictDialog 提示重录。
- **DEV debug payload**（仅开发版）：录一段开 AI refine → 历史详情 → 「复制 Debug 信息」→ 预期：粘贴出 URL / model / body 的 pretty JSON 数组（refine + translate 各一项）。
