# 发版架构与单一事实源

> 改 `release.yml` / `tauri.conf.json` updater 段 / `update_channel.rs` / `sync-version.mjs` 之前读这份文档。
> 主 SKILL.md 只列了关键 SSoT；这里是完整版 + 文件索引 + GitHub Secrets。

---

## 单一事实源（不要重复）

| 项 | SSoT |
|---|---|
| 应用版本号 | `package.json.version`（Cargo.toml / tauri.conf.json 自动同步） |
| Release 正文 | `docs/changelogs/{version}/zh.md`（缺失时回退 `en.md`，再缺回退默认文案） |
| Updater endpoint（运行时） | `src-tauri/src/update_channel.rs`：`STABLE_R2 / STABLE_CDN / BETA_R2 / BETA_CDN / STABLE_GITHUB / BETA_GITHUB` 六个常量 + `is_cn_runtime()` 按 region × channel 4 选 1；`tauri.conf.json` 的 `plugins.updater.endpoints` 仅作 plugin 注册时占位（运行时被 `check_for_update` override） |
| 主分发存储 | Cloudflare R2，bucket `openspeech` |
| 海外加速 host | R2 自定义域 `openspeech-r2.hexems.com`（硬编码于 release.yml + update_channel.rs） |
| 国内加速 host | 腾讯云 CDN `openspeech-cdn.hexems.com`，回源 `openspeech-r2.hexems.com`（硬编码于 update_channel.rs） |
| 老客户端兜底 | 腾讯云 COS `openspeech-1329813561.cos.accelerate.myqcloud.com`，仅同步 `latest.json` / `latest-beta.json`（≤ v0.2.30-beta.2 客户端 endpoints 写死，需保留 1~2 个月过渡） |
| Bundle targets | `tauri.conf.json` `bundle.targets` = `["dmg","app","deb","rpm","appimage","nsis"]`（**无 msi** —— MSI 不接受 SemVer pre-release，且 Tauri 2 updater for Windows 走 NSIS） |
| 远程仓库 | `git@github.com:OpenLoaf/OpenSpeech.git` |
| CI workflow | `.github/workflows/release.yml`（tag `v*` 触发） |

---

## 维护要求

当下列任何一项变更，必须同步更新 SKILL.md（含 references/）：

- `release.yml`
- `tauri.conf.json` 的 updater 段或 bundle.targets
- `scripts/sync-version.mjs`
- `docs/changelogs/` 的路径约定
- `src-tauri/src/update_channel.rs` 的六个 endpoint 常量、`is_cn_runtime()` 判定逻辑
- Cloudflare R2 链路（bucket / 自定义域 / API token / Secret 名）
- 腾讯云 CDN 链路（加速域名 / 回源 HOST / DNS）
- COS 老客户端兜底链路（bucket / 镜像哪些文件 / 何时下线）

---

## 相关文件索引

| 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | CI 入口，tag `v*` 触发 |
| `scripts/sync-version.mjs` | npm version lifecycle，同步 Cargo.toml |
| `package.json.scripts.version` | hook 配置：`node scripts/sync-version.mjs && git add src-tauri/Cargo.toml` |
| `src-tauri/tauri.conf.json` | `plugins.updater.{pubkey,endpoints}` + `bundle.createUpdaterArtifacts: false`（CI override true）+ `bundle.targets`（**显式列表，不含 msi**）。`endpoints` 仅作 plugin 注册占位，运行时被 `update_channel.rs` 的 `endpoints_for()` override |
| `src-tauri/src/lib.rs` | `tauri_plugin_updater::Builder::new().build()` 注册 + 托盘"检查更新"菜单项 |
| `src-tauri/src/update_channel.rs` | Beta 通道 + 地区分流实现：`STABLE_R2 / STABLE_CDN / BETA_R2 / BETA_CDN / STABLE_GITHUB / BETA_GITHUB` 六常量 + `is_cn_runtime()`（扫 `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`） + `get/set_update_channel` + `check_for_update`（按 channel × region 4 选 1，每组返回 3 个 endpoint：region 主 host → 备份 host → GitHub fallback）。入口/找到/无更新/失败四态打 `log::info!`，target = `openspeech::updater` |
| `src/lib/updaterInstall.ts` | 前端 `checkForUpdateForChannel` + `installUpdateWithProgress`（toast 进度条） |
| `src/main.tsx` | bootPromise 启动检查（30s 超时；走 channel 命令） |
| `src/components/Layout.tsx` | 托盘"检查更新" → toast 反馈 |
| `src/components/SettingsContent.tsx` | 设置 → 关于 → 更新通道 RadioGroup |
| `docs/changelogs/{version}/zh.md` | **GitHub Release 正文 SSoT** |
| `~/.tauri/openspeech.key` | minisign 私钥（本地，不入库） |

---

## GitHub Secrets

| Secret | 用途 |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | minisign 私钥文件内容，updater 签名 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 上面 key 的密码，无密码留空 |
| `MAC_CER_BASE64` | macOS Developer ID Application 证书 .p12 的 base64 |
| `MAC_CER_PASSWORD` | 上面 .p12 的导出密码 |
| `APPLE_SIGNING_IDENTITY` | `Developer ID Application: Name (TEAMID)` |
| `APPLE_ID` | Apple ID 邮箱 |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-Specific Password（appleid.apple.com 生成） |
| `APPLE_TEAM_ID` | 10 位 Team ID |
| `R2_ACCESS_KEY_ID` | Cloudflare R2 API token 的 access key（作用域 `openspeech` bucket，权限 Object R/W） |
| `R2_SECRET_ACCESS_KEY` | 同上 secret key |
| `R2_ENDPOINT` | R2 S3-compatible endpoint，必须**不带 bucket 段**：`https://<account>.r2.cloudflarestorage.com`（带 `/openspeech` 后缀会让 SDK 拼成 `/openspeech/openspeech/...` → 403） |
| `R2_BUCKET` | bucket 名 = `openspeech` |
| `TENCENT_SECRET_ID` | 老客户端兜底用：腾讯云 CAM 子账号 SecretId（最小权限：仅 openspeech bucket 读写） |
| `TENCENT_SECRET_KEY` | 同上 SecretKey |
| `TENCENT_COS_BUCKET` | 桶名（含 APPID 后缀，如 `openspeech-1329813561`） |
| `TENCENT_COS_REGION` | COS 地域，如 `ap-shanghai`（上传 endpoint 由 `cos.accelerate.myqcloud.com` 覆盖） |

> `R2_*` 是当前主链路；`TENCENT_*` 仅为 ≤ v0.2.30-beta.2 老客户端 manifest 兜底。
> 老客户端基本升完后（约 1~2 个月）整套 `TENCENT_*` Secrets 与 release.yml 中
> `Mirror manifests to COS` step 一并清理。
> 旧的 `OPENSPEECH_CDN_HOST` Secret 已停用（CDN host 改为 release.yml 中硬编码 `https://openspeech-r2.hexems.com`），可删。

---

## CI 链路细节（看图找 bug 用）

```
本地：累计代码改动
  ├─ commit（不带 [skip ci]，跳过 .tmp/ 等临时素材）
  ├─ docs/changelogs/{ver}/zh.md (+ en.md) ← 用户看到的 Release 正文来源
  ├─ pnpm version patch|minor|major
  │     ↓ 触发 npm lifecycle hook → scripts/sync-version.mjs
  │       ↓ 同步 src-tauri/Cargo.toml [package].version
  │     ↓ 自动 commit "0.x.y" + 打 tag "v0.x.y"
  └─ git push origin main && git push origin v0.x.y

GitHub Actions（.github/workflows/release.yml）：
  ├─ build 矩阵（6 平台并行，fail-fast: true）
  │   └─ tauri build --config createUpdaterArtifacts=true
  └─ release job
      ├─ 下载所有 6 份 artifact
      ├─ 重命名为 OpenSpeech-{ver}-<platform>.<ext>
      ├─ jq 拼出 latest.json（platforms.*.url 一律指 R2 海外 host openspeech-r2.hexems.com）
      ├─ jq 拼出 download-{stable,beta}.json（含 mirrors.{cdn, r2, github}）
      ├─ 读 docs/changelogs/{ver}/zh.md 作为 Release body
      ├─ 创建 draft Release（softprops/action-gh-release，附 latest.json + download-*.json）
      ├─ 更新 channel-beta 滚动指针 release（latest-beta.json + download-beta.json）
      ├─ aws s3 sync 上传到 Cloudflare R2（产物 + 6 个 manifest，AWS_ENDPOINT_URL = R2_ENDPOINT）
      └─ coscli cp 镜像 latest.json / latest-beta.json 到腾讯云 COS（仅 manifest 兜底）

人工：去 https://github.com/OpenLoaf/OpenSpeech/releases 点 Publish
  ↓
新客户端启动时（main.tsx bootPromise）或托盘"检查更新"
  ↓
tauri-plugin-updater 走 update_channel.rs 注入的 endpoints
（按 is_cn_runtime() × channel 4 选 1，每组 3 个 endpoint）：
  - CN  + stable: CDN latest.json    → R2 latest.json    → GitHub /latest/download/
  - CN  + beta:   CDN latest-beta    → R2 latest-beta    → GitHub channel-beta
  - 海外 + stable: R2 latest.json     → CDN latest.json   → GitHub /latest/download/
  - 海外 + beta:   R2 latest-beta     → CDN latest-beta   → GitHub channel-beta
  ↓
拉 manifest（manifest.url 全部指 R2 海外 host）
  ↓
按 manifest.platforms[<platform>].url 下载安装包（→ R2，国内有 Cloudflare 全球边缘加速）
  ↓ minisign 校验 → 替换 → relaunch

老客户端（≤ v0.2.30-beta.2）endpoints 写死 cos.accelerate.myqcloud.com：
  ↓ 拉 COS 上的 manifest（CI 同步过来的，内容指 R2）
  ↓ 按 manifest.url 直下 R2 海外 → minisign 校验 → 替换 → relaunch
```

历史耗时参考（看 build 矩阵的瓶颈）：

- macOS Intel 通常最慢（aarch64 runner 上交叉编译 x86_64）
- Linux ARM64 次慢
- Windows / macOS ARM64 较快
