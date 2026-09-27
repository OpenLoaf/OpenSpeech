# 目录索引

> 只列「去哪找」，子模块的函数 / 字段 / 事件名**直接读对应文件**。新增 / 移动 `src-tauri/src/` 下的模块时同步本表。

```
docs/                           业务规则 SSoT（见 SKILL.md「业务规则索引」）
src/                            前端源码（私仓 OpenSpeech-Frontend，主仓 .gitignore；详细约定见私仓
                                openspeech-frontend skill）
src-tauri/
├── src/
│   ├── lib.rs                  tauri::Builder + 插件注册 + setup（纯装配壳，业务已外溢）
│   ├── {events,logging,macos_native,commands,window,tray}.rs
│   │                           lib.rs 装配辅助（事件常量 / 日志生命周期 / objc / 零散命令 / 窗口显隐 / 托盘菜单）
│   ├── {http,idle,cue,text_normalize,mac_main_thread}.rs
│   │                           共享 reqwest Client / 系统空闲秒数（updater 调度用）/ 提示音播放 /
│   │                           全角标点折叠 / macOS 主线程同步派发
│   ├── update_channel.rs       updater 运行时 endpoint（region × channel）
│   ├── dictation/              听写会话状态机 + 开录鉴权门禁 + 输出
│   ├── audio/                  cpal 采集 + WAV 落盘 + PCM16 喂 stt
│   ├── stt/                    realtime ASR worker（SaaS / BYOK / 本地共用，按 RealtimeAsrBackend 分派）
│   ├── asr/                    各服务商 ASR 实现（tencent / aliyun / BYOK / 会议）
│   ├── transcribe/             文件转写 + 自定义 provider 未配齐时回退 SaaS
│   ├── transcribe_refine/      转写 + 改写串联的分阶段错误码
│   ├── ai_refine/              AI 改写 SSE 流（可按 task_id 中止）
│   ├── dictionary_agent/       根据用户反复纠正信号自动补词典
│   ├── local_asr/              本地离线模型：清单 / 下载安装 / 推理引擎 / 推理子进程 host（加模型只改 catalog.rs）
│   ├── meetings/               会议转写会话（断线重连 + 写出）
│   ├── hotkey/                 combo / modifierOnly / doubleTap 三路编排
│   ├── inject/                 文本注入（剪贴板 + 粘贴）
│   ├── ime/                    macOS 当前输入源判定（IME 会拦截伪造 keydown → 降级整段 paste）
│   ├── focus_check/            焦点是否为文本输入区（macOS AX）
│   ├── active_app/             前台应用名 / 窗口标题
│   ├── overlay/                悬浮录音条窗口（启动预创建 hidden）
│   ├── quick_panel/            quick panel / 托盘卡片窗口
│   ├── device/                 外接硬件设备（BLE 配网 + WS server + OTA），契约见 device/CONTRACT.md
│   ├── permissions/            macOS 系统权限检测 / 请求 / 跳转
│   ├── secrets/                keyring 包装
│   ├── openloaf/               SaaS 登录 / token / 用户档案 / 支付
│   └── db/                     SQLite 迁移 + recordings_dir 帮手
├── capabilities/               权限声明（default.json + desktop.json）
├── examples/                   离线诊断脚本（如 test_realtime_asr）
└── tauri.conf.json
.claude/skills/
├── openspeech-dev/             开发规约入口（SKILL.md + references/ 按任务类别拆分）
└── openspeech-update/          发版 / OTA 执行流程
```
