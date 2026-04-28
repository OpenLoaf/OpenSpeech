## v0.2.18

### 改进

- 录音悬浮条整体重构。改成完全透明的轻量窗口，启动更快、显示更稳；波形与状态文案分离渲染，长录音不再卡顿。
- 双段 ESC：录音活跃期按 Esc 优先取消当前阶段（注入中 / 转写中 / 录音中），多按一次才会冒泡给前台 app。日常在 Cursor / 浏览器里取消录音不再误关 IME 候选或退出 vim 模式。
- 自动更新带进度提示。检查到新版本后下载与替换过程会有 toast 滚动反馈，不再"按了之后没反应直到重启才发现已升级"。
- 登录中可按 Esc 取消。之前账号登录卡在 OAuth 跳转时只能等超时，现在 Esc 立即终止流程回到登录页。
- 反馈入口在「设置」面板内打开，三语文案补齐，不需要再跳浏览器填表。
- staging 渠道用户更稳定：内部 staging feature 现在能从 OpenLoaf 拿到正确的入口 URL fallback，不会再出现"staging 模式打开却落到 production 端点"。

### 修复

- 切换录音 / 转写状态时偶现的 stuck 状态：boot 期前后端做了一次握手，确保 overlay 与 recording store 启动后状态一致。
- modifier-only 快捷键漏按 / 残留键的边界 case 进一步收敛。

### 其他

- 官网落地页（openloaf.com / OpenSpeech 介绍页）改版：精简到 Hero / Demo / Privacy / CTA 四段，下载入口更明显。
