<div align="center">
  <img src="public/logo-write-bg.png" alt="OpenSpeech" width="120" />

  <h1>OpenSpeech</h1>

  <p>
    <strong>按住快捷键说话，松开即把文字写入当前应用的输入框。</strong>
  </p>

  <p>跨平台 AI 语音输入桌面应用 · Voice typing for every app.</p>

  <p>
    <a href="https://github.com/OpenLoaf/OpenSpeech/releases/latest"><img src="https://img.shields.io/github/v/release/OpenLoaf/OpenSpeech?include_prereleases&style=flat-square" alt="Release" /></a>
    <a href="LICENSE"><img src="https://img.shields.io/github/license/OpenLoaf/OpenSpeech?style=flat-square" alt="License" /></a>
    <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
  </p>
</div>

---

## 简介

OpenSpeech 是一款开源的桌面端 AI 语音输入工具。在任意应用、任意可输入区域，按住自定义快捷键说话，松开后转写文字会自动写入当前光标位置——不绑定特定编辑器或浏览器，不依赖云端账号即可使用。

**为什么做 OpenSpeech**

- **全平台同步交付**：Windows / macOS / Linux 同版本同步发布（同类产品 TypeLess 仅 macOS + 移动端，无 Linux）。
- **模型可自选**：默认走 [OpenLoaf SaaS](https://openloaf.com) 云端，按积分扣费；也支持 BYO-Model（自带 REST 端点，不经 SaaS、不消耗积分）。
- **隐私保守**：录音不持久化、不上传审计；转写结果仅保存在本地设备。
- **业务规则全公开**：所有计费、设备上限、冲突规则在 [`docs/`](./docs) 中公开可查。

## 核心功能

### 全局听写
按住快捷键说话，松开自动把转写文字写入当前光标位置。在任何应用的任何可输入区域都能用——编辑器、浏览器、IM、邮件客户端、终端，无需任何插件适配。

支持两种触发模式：
- **Push-to-Talk（PTT）**：按住说话、松开结束，适合短句快速口述。
- **Toggle**：单击开始、再次单击结束，适合较长内容或需要中途停顿。

### 自定义快捷键
默认快捷键贴近行业标杆，首启即用、冲突概率最低：

| 平台 | 默认听写键 | 形态 |
| --- | --- | --- |
| macOS | `Fn` | 单按修饰键 |
| Windows | `Ctrl + Win` | 修饰键组合 |
| Linux | `Ctrl + Super` | 修饰键组合 |

支持三种绑定形态：组合键（`Ctrl + Shift + Space`）、修饰键单按（`Fn`）、双击修饰键（`2× Right Shift`）。所有快捷键全局可用，可在设置中自由更换；冲突时会弹出对话框确认替换并提供 8 秒撤销窗口。

### 录音悬浮条
录音期间在屏幕底部中央显示一个 280×56 的工业风浮条：实时波形、计时、取消按钮一目了然。浮条不夺焦，不影响当前应用的输入状态；按 `Esc` 或点击 × 即可取消本次录音。

### 模型自选（云端 / BYO）
- **默认云端**：通过 OpenLoaf SaaS 转写，按积分扣费；订阅套餐后无限使用。
- **BYO-Model**：在设置里填入任意兼容的 REST STT 端点、API Key、模型名，转写直连第三方，不经 SaaS、不消耗积分，账单由用户自担。

### 词典（专有名词 hints）
维护一份个人词表（公司名、产品名、人名、术语等），转写时作为 hints 提交给模型，显著降低专有名词的错字率。

### 历史记录
每次转写结果保存到本地 SQLite，可查看、复制、删除，支持搜索。包括因 `Esc` 取消但模型已返回结果的条目（标记为 cancelled，不会注入到应用）。

### 系统集成
- **托盘驻留**：最小化到系统托盘，菜单含开关录音、打开主窗口、退出。
- **开机自启**：可在设置中开启 / 关闭。
- **应用内更新**：自动检测新版本（腾讯云 COS 优先，GitHub Releases 兜底）。
- **多语言**：界面支持简体中文、English。
- **多主题**：跟随系统 / 亮色 / 暗色。

完整功能列表与迭代项见 [`docs/features.md`](./docs/features.md)。

## 截图

> 截图待补充。

## 安装

前往 [Releases](https://github.com/OpenLoaf/OpenSpeech/releases/latest) 下载对应平台安装包：

- **macOS**：`OpenSpeech_x.y.z_universal.dmg`（macOS 10.15+）
- **Windows**：`OpenSpeech_x.y.z_x64-setup.exe`
- **Linux**：`.AppImage` / `.deb` / `.rpm`

首次启动时需授予以下权限：

- **macOS**：辅助功能（Accessibility）+ 麦克风
- **Windows**：麦克风
- **Linux**：麦克风（Wayland 下还需要 `xdg-desktop-portal` 提供全局快捷键支持）

详见 [`docs/permissions.md`](./docs/permissions.md)。

## 快速开始

1. 启动 OpenSpeech，授予权限。
2. 打开任意可输入文字的应用（编辑器、浏览器、聊天窗口）。
3. 按住默认快捷键说话——
   - macOS：`Fn`
   - Windows：`Ctrl + Win`
   - Linux：`Ctrl + Super`
4. 松开快捷键，转写结果自动写入光标所在位置。

完整使用流程见 [`docs/voice-input-flow.md`](./docs/voice-input-flow.md)。

## 文档

业务规则与功能说明位于 [`docs/`](./docs)：

- [`product.md`](./docs/product.md) — 产品定位与差异化
- [`features.md`](./docs/features.md) — 功能总览
- [`voice-input-flow.md`](./docs/voice-input-flow.md) — 录音到注入的完整流程
- [`hotkeys.md`](./docs/hotkeys.md) — 快捷键规则与平台差异
- [`dictionary.md`](./docs/dictionary.md) — 词典 / 专有名词
- [`history.md`](./docs/history.md) — 历史记录规则
- [`permissions.md`](./docs/permissions.md) — 系统权限申请
- [`privacy.md`](./docs/privacy.md) — 隐私策略
- [`settings.md`](./docs/settings.md) — 设置项语义
- [`subscription.md`](./docs/subscription.md) — OpenLoaf SaaS 套餐 / BYO-Model
- [`speech-providers.md`](./docs/speech-providers.md) — STT 提供商集成

## 路线图

参见 [`docs/features.md`](./docs/features.md) 的「进阶功能」部分，重点项目：

- Ask AI / Translate 独立快捷键（差异化能力）
- 上下文风格（根据前台应用调整语气）
- AI 自动润色（删除 um/uh、口误改口）
- 语种自动检测
- 音频设备选择

不在当前路线图：离线模型内置、移动端、会议长录音转写、跨设备同步。

## 开发

技术栈：Tauri 2 · React 19 · TypeScript · Rust · Tailwind CSS 4 · shadcn/ui。

```bash
git clone https://github.com/OpenLoaf/OpenSpeech.git
cd OpenSpeech
pnpm install
pnpm tauri dev
```

环境要求：Node.js ≥ 18、pnpm ≥ 9、Rust stable。平台依赖参见 [Tauri 官方先决条件](https://tauri.app/start/prerequisites/)。

## 贡献指南

欢迎以 Issue / Pull Request 的形式参与改进：

1. 提交前请阅读 [`docs/`](./docs) 下相应模块文档，理解既有约束。
2. 较大改动建议先开 Issue 讨论方案。
3. Rust 代码请通过 `cargo fmt` + `cargo clippy`；前端遵循现有 TypeScript / ESLint 风格。
4. 提交信息使用 [Conventional Commits](https://www.conventionalcommits.org/)（如 `feat:` / `fix:` / `docs:`）。

## 许可证

[MIT](./LICENSE) © OpenLoaf

## 致谢

- [Tauri](https://tauri.app/) — 跨平台桌面外壳
- [shadcn/ui](https://ui.shadcn.com/) — 组件设计参考
- [rdev](https://github.com/Narsil/rdev) / [rustdesk-org/rdev](https://github.com/rustdesk-org/rdev) — 全局键盘事件监听
- 同类产品 [TypeLess](https://typeless.app/)、[Wispr Flow](https://wisprflow.ai/)、[Superwhisper](https://superwhisper.com/) 的产品形态启发
