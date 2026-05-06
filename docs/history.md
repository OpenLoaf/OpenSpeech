# 历史记录规则

## 存储位置

本地 SQLite：`openspeech.db` 的 `history` 表，落在 Tauri `app_data_dir` 下（各平台路径见 `docs/privacy.md`）。

## 每条记录包含

| 字段 | 说明 |
|---|---|
| id | 唯一 ID，格式 `YYYYMMDDHHMMSSmmm-xxxx`（17 位本地时间到毫秒 + 4 位 base36 随机）。字典序 == 时间序，便于按日期检索。生成逻辑见 `src/lib/ids.ts`。 |
| type | 类型：`dictation`（听写） / `ask`（问 AI） / `translate`（翻译） |
| text | 转写/生成的最终文字 |
| status | `success` / `failed` / `cancelled` |
| error | 失败 / 异常原因（人话，已 i18n）。`failed` 时**必有**值；`success` 时也可能有值——AI 整理 / 翻译 phase2 等"主流程已成功但有副作用错误"会写一条备注，UI 用黄色 NOTE 标出。`cancelled` 始终为 NULL。 |
| duration_ms | 录音时长 |
| created_at | Unix 时间戳（毫秒） |
| target_app | 注入目标应用的可识别名称（如 "VSCode"、"Chrome"）；若无法获取则为空 |
| audio_path | 录音文件的**相对路径**（相对 `app_data_dir`），新版形如 `recordings/<yyyy-MM-dd>/<id>.ogg`，迁移前老记录可能仍是 `recordings/<id>.{ogg,wav}`。未保存音频的记录（如 `cancelled`、或"关闭音频保存"设置开启时）该字段为 NULL |
| asr_source | 实际走的 ASR 通道：`saas-realtime` / `saas-rest` / `byo`。schema v3 之前的老记录为 NULL |
| ai_model | AI 优化使用的模型预格式化展示串（如 "OpenLoaf SaaS" / "{provider name} · {model}"）。未启用 / 未尝试 = NULL |
| refined_text | AI 优化后的书面化文本；仅 UTTERANCE + `aiRefine.enabled` 时产生。**判断"是否做过 AI 优化"必须看 `segment_mode` + `aiRefine.enabled` 配合**，不能仅凭 `refined_text != null` 反推（refine 失败时也会是 null，会误判） |
| segment_mode | 该次记录使用的分段模式：`REALTIME` / `UTTERANCE`。schema v4 之前的老记录为 NULL |
| provider_kind | 实际承载本次转写的供应商通道。命名规则 `<vendor>-<channel>`：`saas-realtime` / `saas-file` / `tencent-realtime` / `tencent-file` / `aliyun-realtime` / `aliyun-file`。schema v4 之前的老记录为 NULL |

**不保存**：模型请求/响应的完整内容（仅保留最终 `text`）。

## Schema migrations

| Version | 改动 | 触发实现 |
|---|---|---|
| v1 | 初始 schema | `src-tauri/src/db/mod.rs` |
| v2 | 加 `target_app` | 同上 |
| v3 | 加 `audio_path` / `asr_source` / `ai_model` | 同上 |
| v4 | 加 `segment_mode` / `provider_kind` | `migrate_to_v4`（追加 PR-8） |

老记录这两列回填策略：保持 NULL，UI 详情页按 i18n key `history.detail.{segment_mode,provider_kind}.<value>` 翻译，命中 NULL 时显示 "—"。

## 录音文件

- 每条 `success` / `failed` 记录对应一个 OGG 文件（迁移前老记录可能是 WAV），路径由 `audio_path` 指向；新版实际文件落在 `app_data_dir/recordings/<yyyy-MM-dd>/` 下，按本地日期分子目录方便用户翻历史。
- 文件名即 `id`（新版带 `.ogg` 后缀，老库可能 `.wav`），因此文件系统和数据库始终通过同一 ID 对齐。
- `cancelled` 记录按规则"请求未发出 ⇒ 不生成记录；请求已发出 ⇒ 生成记录但保留 text 不注入"；音频是否落盘取决于录音是否持续到 stop 点（当前实现：cancelled 不落盘，保留灵活度）。
- 删除一条记录 / 清空历史 / retention 到期清理时，对应的 WAV 文件必须同步删除（由后端清理 orchestrator 负责，见 task #13）。

## 保留策略

用户在"历史记录"页顶部选择保留时长：

| 选项 | 含义 |
|---|---|
| 永远 | 默认值；永不删除 |
| 90 天 | 超过 90 天的记录每次启动时自动清理 |
| 30 天 | 同上 |
| 7 天 | 同上 |
| 不保存 | 不写入数据库；仅当前会话可见（重启后清空） |

修改保留策略时：
- 缩短时长：下次启动生效（不即时删除过往记录）
- 改为"不保存"：立即清空历史记录，弹窗二次确认

## 列表展示

1. 按日期分组：今天 / 昨天 / 本周 / 更早。
2. 每条显示时间、文字预览（首行，超出截断）。
3. 支持类型筛选：全部 / 听写 / 问 AI / 翻译。
4. 支持文本搜索（模糊匹配 text 字段）。

## 操作

每条记录支持：
- **播放原始录音**（仅当 `audio_path` 非空）：直接在列表内播放本机 WAV 文件；同一时刻最多只有一条录音在播，切到别的行会自动暂停当前。右侧的状态图标（✓）在有录音时替换为 Play/Pause 按钮。
- **复制**：复制 text 到剪贴板。
- **重新注入**：把 text 写入当前焦点输入框。
- **重试**（仅 failed 记录）：重新发送原始请求到大模型。
- **删除**：单条删除，无需二次确认。

## Cancelled 状态规则

- 用户 `Esc` 中途取消录音时：
  - 若大模型请求尚未发出：不生成历史条目。
  - 若大模型请求已发出并返回结果：生成一条 `cancelled` 记录，保留 text，但**不执行注入**。
- 此规则保证用户"误按取消"时，文字不会丢失，可从历史恢复。

## 隐私约束

- 历史记录仅存储在本地数据库，不上传任何服务器。
- 卸载应用时提示用户选择是否同时删除历史记录。
