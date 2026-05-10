<div align="center">
  <img src="docs/images/logo-rounded.png" alt="OpenSpeech" width="120" />

  <h1>OpenSpeech</h1>

  <p><strong>按一下快捷键说话，文字就出现在光标所在的地方。</strong></p>

  <p>跨平台 AI 语音输入桌面应用 · Voice typing for every app.</p>

  <p>
    <a href="https://github.com/OpenLoaf/OpenSpeech/releases/latest"><img src="https://img.shields.io/github/v/release/OpenLoaf/OpenSpeech?include_prereleases&style=flat-square" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-orange?style=flat-square" alt="License" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  </p>

  <p>
    <strong>简体中文</strong>
    · <a href="docs/README.en.md">English</a>
    · <a href="docs/README.zh-TW.md">繁體中文</a>
  </p>
</div>

---

## 简介

OpenSpeech 是一款跨平台的桌面端语音输入工具：在任何应用、任何输入框，按一下快捷键开始说话，再按一下就把转写文字写到光标位置。Windows / macOS / Linux 三端同步发布。

**说一段大白话，落到光标里就是结构化文档。** 录音 → 转写 → AI 清洗，口误、语气词、自我纠错全部抹平，再按你想要的格式重排：

<p align="center">
  <img src="docs/images/demo-zh.gif" alt="OpenSpeech 演示：录音、转写、AI 清洗、写入光标" width="640" />
</p>

## 功能

**把语音直接变成你想要的文字**
按一下快捷键开始说话，再按一下结束，文字落在光标位置。说话时的"嗯啊呃"、口误、改口都会被 AI 整理成干净的文字，不是逐字打出来。VS Code、聊天框、邮件、终端全部通用。

**想发什么语言就发什么语言**
按翻译快捷键说一段中文，光标位置直接出英文（或日、韩、法、德、西、繁中）。也可以让它给你"原文 + 译文"两份。

**开会自动整理纪要**
长录音、自动按发言人分段、AI 一键生成 Markdown 纪要——决策、待办、关键讨论点都帮你列好，可以导出。中途断网会自动重连，时间轴不会断。

**它知道你的专业**
勾选你的领域（医学、法律、心理、编程、设计、金融…共 16 个），AI 整理时不会把术语改成"通俗近义词"。再加个人字典，把人名、品牌、专有名词补上，识别更稳。

**想用自己的 API 也行**
腾讯云、阿里百炼，或任何 OpenAI 协议兼容的 API，直接填进去就能用。密钥存在系统钥匙串里，不会上传服务器。

**历史和用量都在本机**
每次录音、AI 整理后的版本、当时在哪个 App 里——全部存本地，可翻看、复制、重转。还能看本月用了多久、哪个 App 用得最多。

**快捷键随你改**
听写、翻译听写、唤起主窗口、打开 AI 工具——四个快捷键都能改成你顺手的组合。会自动检测冲突，也会提醒你按到了系统占用的快捷键。

**桌面应用该有的都有**
托盘驻留、开机自启、应用内自动更新、三语界面、明暗主题跟随系统、电脑睡眠唤醒后不会被踢登录。

## 截图

<p align="center">
  <img src="docs/images/chinese.png" alt="OpenSpeech 中文界面" width="640" />
</p>

## 安装

前往 [Releases](https://github.com/OpenLoaf/OpenSpeech/releases/latest) 下载对应平台安装包：

- **macOS**：`OpenSpeech_x.y.z_universal.dmg`（macOS 10.15+）
- **Windows**：`OpenSpeech_x.y.z_x64-setup.exe`
- **Linux**：`.AppImage` / `.deb` / `.rpm`

首次启动需授予麦克风权限；macOS 还需要辅助功能（Accessibility）权限。

## 路线图

### 已实现
- [x] 云端转写（实时 / 整段两种模式）
- [x] AI 整理（去 um/uh + 口误 + 中文口语数字 → 阿拉伯数字）
- [x] 翻译听写（8 种目标语言 + 双语输出）
- [x] 会议转录（说话人分离 + AI 纪要 + Markdown 导出 + 断网重连）
- [x] AI 领域系统（16 个专业领域多选）+ 个人字典
- [x] 自定义快捷键（听写 / 翻译 / 唤起主窗口 / 打开 AI 工具，自动检测冲突）
- [x] 用量统计（本月时长 / 字数 / Top App / 活跃时段）
- [x] 自定义 AI 供应商（兼容 OpenAI 协议端点）
- [x] 自定义 ASR 供应商：腾讯云、阿里百炼（DashScope）
- [x] 历史记录与重试 / 401 自动续转写

### 待开发
更多 STT 供应商接入：

- [ ] Microsoft Azure Speech
- [ ] Google Cloud Speech-to-Text
- [ ] 火山引擎（豆包）语音识别
- [ ] 科大讯飞语音识别
- [ ] OpenAI Whisper API
- [ ] Deepgram
- [ ] AssemblyAI

## 快速开始

1. 启动 OpenSpeech 并授予权限。
2. 在任意输入框点击光标。
3. 按一下快捷键开始说话——
   - macOS：`Fn + Ctrl`
   - Windows：`Alt + Win`
   - Linux：`Ctrl + Super`
4. 再按一下同样的快捷键结束，文字自动写入。

## 开发

技术栈：Tauri 2 · React 19 · TypeScript · Rust · Tailwind CSS 4。

```bash
git clone https://github.com/OpenLoaf/OpenSpeech.git
cd OpenSpeech
pnpm install
pnpm tauri dev
```

环境要求：Node.js ≥ 18、pnpm ≥ 9、Rust stable。平台依赖参见 [Tauri 官方先决条件](https://tauri.app/start/prerequisites/)。

> **关于前端源码**
> 前端源码托管在独立的私有仓库，通过 npm 包 [`@openloaf/openspeech-frontend`](https://www.npmjs.com/package/@openloaf/openspeech-frontend) 以预构建产物形式分发。`pnpm install` 会自动拉到 `node_modules`，`pnpm tauri dev` / `pnpm tauri build` 自动取用，无需额外步骤。
> Tauri / Rust 部分（`src-tauri/`）以及构建脚本、桌面打包配置全部开源在本仓库。

## 贡献

欢迎提 Issue / Pull Request。较大改动建议先开 Issue 讨论方案。

## 许可证

[PolyForm Noncommercial 1.0.0](./LICENSE) © OpenLoaf

个人、研究、教育、非营利组织等**非商业用途**可自由使用、修改和分发。如需商业授权（包括但不限于将本项目用于商业产品、SaaS 服务或闭源分发），请联系作者获取单独授权。
