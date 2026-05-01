# 发版 / 签名 / Updater

> 何时读：要发版 / 改 CI / 改签名证书 / 本地测 updater 包 / 加 NSIS 语言。
> 真相来源：`package.json`、`tauri.conf.json`、`scripts/sync-version.mjs`、`.github/workflows/release.yml`、`src-tauri/entitlements.plist`。
> **发版执行流程**走同名 skill `openspeech-release`，本文只写"为什么这样选"。

---

## 版本号 SSoT

- **唯一事实源 = `package.json.version`**。
- `tauri.conf.json.version` 设为 `"../package.json"` 自动 resolve。
- `Cargo.toml` 由 `scripts/sync-version.mjs` 在 `pnpm version` lifecycle 同步。

## 发版流程
- 标准动作：`pnpm version patch|minor|major` → 自动 commit + tag → `git push && git push --tags` → `.github/workflows/release.yml` 按 6 个 native target 矩阵打包到 draft Release，**手动 Publish** 后 updater 才看得到。

---

## 本地裸 build 不走 updater 签名

- `bundle.createUpdaterArtifacts` 默认 `false`，CI 在 `release.yml` 临时开。
- 本地要测 updater 包同样手动开：
  ```
  --config '{"bundle":{"createUpdaterArtifacts":true}}'
  export TAURI_SIGNING_PRIVATE_KEY=...
  ```
- **`TAURI_SIGNING_PRIVATE_KEY` 必须绝对路径，不要 `~`** —— Tauri 会把字面量 `~` 当 base64 解码 panic。

---

## Dev 模式跳过 `check()`

- `import.meta.env.DEV` 一律不调 updater check。
- pubkey 未配 + `latest.json` 未发布时 Rust 侧会打 ERROR 污染日志。
- 托盘"检查更新"仍可手动触发。

---

## macOS 签名 / 公证

- Secrets 复用 OpenLoaf 仓库命名：`MAC_CER_BASE64` / `MAC_CER_PASSWORD` / `APPLE_SIGNING_IDENTITY` / `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`，CI 内映射成 Tauri 认的变量名。
- Secrets 为空时 tauri-action 自动跳签名。
- **证书每年到期需重新导出 `.p12` 更新 `MAC_CER_BASE64`**。

### Hardened Runtime entitlements（`src-tauri/entitlements.plist`）

| entitlement | 用途 |
|---|---|
| `network.client` | STT WebSocket / SaaS HTTP |
| `device.audio-input` | cpal 录音 |
| `automation.apple-events` | enigo 文本注入 |
| `cs.allow-jit` | WKWebView |
| `allow-unsigned-executable-memory` | rdev fork |
| `disable-library-validation` | 动态加载兜底 |

---

## Windows NSIS 安装包国际化

- NSIS 语言列表在 `tauri.conf.json` 的 `bundle.windows.nsis.languages`，与应用内 i18n 三语对齐。
- NSIS 启动时自动匹配 Windows 系统 UI 语言，无需用户手动选择；未命中则 fallback English。
- **新增 i18n 语言时同步往此数组加对应 NSIS 语言名**。
