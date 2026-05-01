# tauri-mcp-server（dev 专用：直接控制运行中的前端）

> 何时读：任务需要 Claude 自己看 / 操作运行中的 UI —— 截图复盘视觉、找元素、执行 webview JS、读 console 日志、监控 IPC、模拟点击/键入。**不要让用户手动截屏粘贴或在 DevTools Console 里手敲命令再贴回来。**

---

## 接入现状（不可改，改了 webview 工具会全 2s timeout）

- `src-tauri/Cargo.toml`：`tauri-plugin-mcp-bridge`，仅 `#[cfg(debug_assertions)]` 注册，release 自动剔除。
- `src-tauri/src/lib.rs`：`Builder::new().bind_address("127.0.0.1").build()` —— **仅本机**，不暴露 0.0.0.0。
- `src-tauri/capabilities/default.json`：`mcp-bridge:default` 已声明。
- **`tauri.conf.json` 必须 `app.withGlobalTauri = true`** —— 这是 webview 端 bridge shim 调 invoke 的前提。
  - 缺了的话：`driver_session` 能连上、`manage_window list` 能跑（走 Rust 命令通道），但**所有 `webview_*` 工具会全部在 2s 内超时**。
  - **默认是 false**，新建 Tauri 工程时务必检查。

> 前端 npm 包不需要 —— MCP server 直接走 WebSocket :9223 跟 Rust 插件通信，前端零依赖。

---

## 触发条件

满足任一即启用：
- 用户描述包含"看一下界面 / 截一下图 / 控制一下 UI / 模拟点一下 / 读一下 console / 监控一下 IPC / 元素长什么样"。
- 调试涉及视觉回归、动效、布局错位、layout 抖动。
- 排查录音条 / Onboarding / Dialog 等子窗口 / 临时 UI 状态。

---

## 典型用法

```
driver_session(start) → 看 status / manage_window list 找窗口 label
→ webview_screenshot {windowId: "main" | "overlay"}
→ webview_execute_js / webview_find_element / webview_interact / read_logs
→ 任务结束 driver_session(stop)
```

---

## 子窗口（overlay）注意

- 默认 hidden。
- 截图前**先触发显示**：按快捷键启动录音、或用 `webview_execute_js` 调对应 invoke。
- 不要直接对 hidden 窗口截图。
