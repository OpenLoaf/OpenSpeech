# OpenSpeech

跨平台 AI 语音输入桌面应用，基于 Tauri 2 + React 19 + Rust。

## 常用命令

### 前端 / Vite

- `pnpm dev` — 启动 Vite 开发服务器（纯前端调试，不带 Tauri 壳）
- `pnpm build` — 类型检查 + Vite 生产构建（`tsc && vite build`）
- `pnpm preview` — 预览已构建产物

### Tauri 桌面应用

通过 `pnpm tauri <subcmd>` 调用：

- `pnpm tauri dev` — 启动 Tauri 桌面开发模式（同时拉起 Vite 和 Rust 后端，日常开发最常用）
- `pnpm tauri build` — 构建桌面应用安装包
- `pnpm tauri add <plugin>` — 添加官方 Tauri 插件（会同时改动 `src-tauri/Cargo.toml` 与 `src-tauri/capabilities/`）
- `pnpm tauri icon` — 生成应用图标

### Rust 侧

进入 `src-tauri/` 后：

- `cargo check` / `cargo build` — 校验 / 构建 Rust 代码
- `cargo fmt` / `cargo clippy` — 格式化与 lint

### shadcn 组件

- `pnpm dlx shadcn@latest add <component>` — 添加 shadcn/ui 组件到 `src/components/ui/`

## 项目文档

业务规则与功能说明位于 `docs/`，包括 `features.md`、`voice-input-flow.md`、`hotkeys.md`、`dictionary.md`、`history.md`、`permissions.md`、`privacy.md`、`product.md`、`settings.md`、`subscription.md`。

## 推荐 IDE

[VS Code](https://code.visualstudio.com/) + [Tauri 扩展](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
