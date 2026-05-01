# 国内分发（腾讯云 COS 镜像）

> 用户问「国内下载慢」「COS」「加速」「manifest 指哪儿」「updater 日志」时读这份文档；
> 改 `.github/workflows/release.yml` 的镜像段也读这份文档。

---

## 链路与决策

每次 release CI 跑完后，`Upload artifacts to COS` step 用 `coscli sync` 把 staging 全部产物镜像到：

```
cos://openspeech-1329813561/v<version>/OpenSpeech-...   按版本号归档（永不重复，长缓存）
cos://openspeech-1329813561/latest.json                  stable 滚动指针（强制 no-cache）
cos://openspeech-1329813561/latest-beta.json             beta 滚动指针（强制 no-cache）
```

**关键决策（manifest 一律指 COS）：**

`Generate latest.json` step 拼出的 `platforms.*.url` 字段**直接就是 COS url**
（`${CDN_HOST}/v<ver>/<file>`），不再有"GitHub-url 版"和"COS-url 版"两份 manifest 之分。
GitHub Release 上和 COS bucket 上的 manifest 内容**完全相同**。

| 客户端版本 | endpoint 行为 | 安装包来源 |
|---|---|---|
| `< 0.2.26-beta.0`（v0.2.25 等老版本，endpoint 写死 GitHub `/latest/download/latest.json`） | 拉 GitHub manifest（小，几 KB） | `manifest.url = COS` → **走 COS（加速）** |
| `>= 0.2.26-beta.0`（endpoint 数组 = COS 优先 + GitHub 兜底，由 `update_channel.rs` 注入） | 优先拉 COS manifest，COS 拉不到才回退 GitHub manifest | 两路都解析出 COS url → 走 COS |

**取舍**：COS 全挂时**没有自动 fallback**。若发生：手工 `gh release upload v0.x.y latest.json --clobber`
（用一份 url 指 GitHub Release asset 的临时 manifest 顶替）即可应急切走，见末尾「应急」。

---

## 同步实现要点（改 release.yml 时勿踩）

1. **coscli 下载 URL 命名**：上游产物文件名是 `coscli-vX.Y.Z-linux-amd64`（**带版本号**），
   不是 `coscli-linux-amd64`。升级时 URL + 文件名两处都要改。

2. **必须走 accelerate endpoint**：`~/.cos.yaml` 的 `buckets[*].endpoint: cos.accelerate.myqcloud.com`。
   **不配的话 GitHub runner 跨境推国内 region 默认 endpoint 慢到卡死**（实测 17 分钟没传完）。

3. **并发**：`coscli sync ... --routines 16`（默认 3 太低，6 份产物串行龟速）。

4. **manifest 头部**：上传 `latest.json` / `latest-beta.json` 时加
   `--meta "Cache-Control:no-cache,max-age=0;Content-Type:application/json"`，
   让 CDN 每次回源（指针文件不能缓存）。

5. **Bundle targets 不含 msi**：`tauri.conf.json` `bundle.targets` 显式列表，
   **不要写 `"all"`** —— Windows MSI 不接受 SemVer pre-release 段（`-beta.N`），打包阶段直接 fail。
   Tauri 2 updater for Windows 走 NSIS `-setup.exe`，MSI 不需要。

---

## Updater 日志（排查升级）

`update_channel.rs::check_for_update` 入口 `log::info!` 打三态：

- 入口：`check_for_update channel=<beta|stable> endpoints=[...]`
- 找到更新：`update found <current> -> <new> platform=<key> install_url=<url>`
- 无更新：`no update available`
- check 失败：`updater.check() failed: <err>`

排查时直接 `grep openspeech::updater` 用户的日志：

| OS | 日志路径 |
|---|---|
| macOS | `~/Library/Logs/com.openspeech.app/OpenSpeech.log` |
| Windows | `%APPDATA%\com.openspeech.app\logs\` |
| Linux | `~/.config/com.openspeech.app/logs/` |

---

## 验证（每次 release publish 后必跑）

```bash
TAG=v0.2.26
# 1. COS 双 manifest（stable 通道有；beta-only release 不更新 latest.json）
curl -sL https://openspeech-1329813561.cos.accelerate.myqcloud.com/latest-beta.json \
  | jq '{version, urls: (.platforms | map_values(.url))}'

# 2. GitHub channel-beta 滚动指针（beta 通道入口）
curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/download/channel-beta/latest-beta.json \
  | jq '{version, urls: (.platforms | map_values(.url))}'

# 期望：两份 platforms.*.url 全部以
#   https://openspeech-1329813561.cos.accelerate.myqcloud.com/v
# 开头
```

任一 url 仍指 GitHub 说明 `Generate latest.json` step 没走新逻辑（旧 release.yml 残留），
翻 commit 历史确认 release.yml 已合并。

---

## 应急：COS 全挂

```bash
# 把当前 release 的 latest.json 替换成 GitHub-url 版（手工生成或从更早版本复制）
# 假设你手上有一份 latest.github.json（platforms.*.url 指 GitHub Release）
gh release upload v0.x.y latest.github.json --repo OpenLoaf/OpenSpeech --clobber

# beta 通道：
gh release upload channel-beta latest-beta.github.json --repo OpenLoaf/OpenSpeech --clobber
```

替换完，老用户立即从 GitHub 拉。COS 恢复后再发新版即恢复 COS 路径。

---

## COS 相关 Common Mistakes

| 错误 | 正确做法 |
|---|---|
| coscli 下载 URL 不带版本号 | 上游文件名是 `coscli-vX.Y.Z-<os>-<arch>`，不是 `coscli-<os>-<arch>` → 404 |
| coscli 不走 accelerate endpoint | GitHub runner 跨境推国内默认 endpoint 卡死十几分钟；`~/.cos.yaml` 必须配 `endpoint: cos.accelerate.myqcloud.com` |
| 改 `update_channel.rs` 的 endpoint 常量后忘了发版 | endpoint 编进二进制，必须发新版才生效 —— 这次的端点配置只对**安装到该版本之后**的客户端有效 |
| 看 manifest 是 GitHub url 还是 COS url 来诊断"加速生效了吗" | 现在两边 manifest 内容相同，全是 COS url；要诊断走的哪条线看客户端 `~/Library/Logs/com.openspeech.app/OpenSpeech.log` 里的 `openspeech::updater` |
| `bundle.targets: "all"` 发 beta | Windows MSI 拒收 SemVer pre-release（`-beta.N`）→ build fail。`bundle.targets` 必须显式列表，去掉 `msi` |
