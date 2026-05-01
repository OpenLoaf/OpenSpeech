# 数据与隐私规则

## 承诺

1. **录音落盘仅限本机**：每次录音可选落盘到应用数据目录下的 `recordings/<yyyy-MM-dd>/<id>.ogg`（见下方路径规则）。文件永不上传；随对应历史记录的保留策略一并清理；用户可在设置中关闭音频保存或手动清空。
2. **不上传遥测**：除用户主动配置的大模型 REST 端点外，OpenSpeech **不向任何服务器发送数据**（包括不做匿名使用统计）。
3. **数据本地化**：历史记录、词典、设置、录音音频均存储在本地设备。
4. **API Key 加密**：大模型密钥存储在系统密钥管理服务中（macOS Keychain / Windows Credential Manager / Linux Secret Service），不明文存储。

## 录音文件落盘路径

落在 Tauri `app_data_dir` 下的 `recordings/` 子目录，具体位置因 OS 而异：

| OS | 路径 |
|---|---|
| macOS | `~/Library/Application Support/com.openspeech.app/recordings/<yyyy-MM-dd>/<id>.ogg` |
| Windows | `%APPDATA%\com.openspeech.app\recordings\<yyyy-MM-dd>\<id>.ogg` |
| Linux | `~/.local/share/com.openspeech.app/recordings/<yyyy-MM-dd>/<id>.ogg` |

按本地日期分子目录保存，方便用户翻历史录音。文件名即 `history.id`（格式 `YYYYMMDDHHMMSSmmm-xxxx`，字典序 = 时间序）。数据库 `history.audio_path` 存相对路径（新版形如 `"recordings/2026-05-01/20260501140521438-a3b9.ogg"`），跨机备份/还原时不依赖绝对路径。

> 兼容性：升级前已落盘的老录音继续保留在 `recordings/<id>.{ogg,wav}`（无日期子目录），读取 / 导出 / 删除照常工作；只是不再新写这种平铺路径。

## 数据分类

| 数据 | 存储位置 | 保留策略 |
|---|---|---|
| 录音音频 | 本地文件系统（`recordings/<yyyy-MM-dd>/<id>.ogg`） | 跟随历史记录保留策略；删除记录或清空历史时一并删除文件 |
| 转写文字 | 本地 SQLite（`openspeech.db` 的 `history` 表） | 按用户设置的历史保留策略 |
| 历史元数据（时间、目标应用、时长、音频文件引用） | 本地 SQLite | 同上 |
| 词典条目 | 本地 SQLite（`dictionary` 表） | 由用户手动管理 |
| 设置偏好 | 本地配置文件 | 永久 |
| API Key | 系统密钥服务 | 由用户手动管理 |

## 用户控制

| 操作 | 规则 |
|---|---|
| 查看所有数据 | 设置 → 隐私 → "导出我的数据"（输出 JSON 压缩包） |
| 清空历史 | 设置 → 历史记录 → "清空全部"，二次确认 |
| 清空词典 | 词典 → 菜单 → "全部删除"，二次确认 |
| 全部重置 | 设置 → 关于 → "重置到出厂状态"，二次确认，清空全部本地数据（包括 API Key） |
| 卸载时清理 | 卸载流程提示"是否同时删除 OpenSpeech 的所有本地数据" |

## 传输给第三方大模型的规则

当用户配置了 REST 端点，每次录音转写时：

- OpenSpeech 发送到第三方的内容：音频数据、可选的词典 hints、可选的上下文风格提示。
- **不发送**：用户身份信息、设备信息、历史记录内容。
- 用户有责任了解自己所配置服务商的数据处理政策；OpenSpeech 不对第三方的数据处理负责。
- 设置页显眼位置显示："你当前的 STT 端点是 `xxx.example.com`，音频将被发送到该服务，请确认其数据政策。"

## 合规

- 目标遵循 **GDPR** 的"数据最小化"与"用户控制"原则。
- 目标遵循 **CCPA** 关于用户数据访问与删除的要求。
- 若用户在医疗、法律等受监管场景使用，OpenSpeech 不声明 HIPAA 合规，用户需自行评估 REST 端点的合规性。

## 崩溃报告

- 默认 **不收集** 崩溃日志。
- 若用户主动点击"提交崩溃日志"，弹窗展示将要发送的完整内容，用户确认后才发送。
