# 分发链路：R2 + 腾讯云 CDN（按地区分流）

> 用户问「国内下载慢」「manifest 指哪儿」「CDN」「R2」「updater 日志」「为什么走这个域名」时读这份文档；
> 改 `.github/workflows/release.yml` 的上传段、`update_channel.rs` 的 endpoints 也读这份文档。
>
> 自 `v0.2.30-beta.3` 起，分发主链路从「单写腾讯云 COS」改为「单写 Cloudflare R2 + 腾讯云 CDN 回源」。
> COS 仅保留 `latest.json` / `latest-beta.json` 两个 manifest 给老客户端兜底，二进制不再镜像。

---

## 链路与决策

```
[release.yml]  ──aws s3 sync──▶  Cloudflare R2 (bucket: openspeech)
                                 │
                                 ├─ Custom Domain: openspeech-r2.hexems.com（海外口）
                                 │
                                 └─ 腾讯云 CDN 回源 ──▶ openspeech-cdn.hexems.com（国内口）

[release.yml]  ──coscli cp───▶  COS bucket: openspeech-1329813561
                                 仅同步 latest.json / latest-beta.json
                                 给 ≤ v0.2.30-beta.2 老客户端兜底
                                 （manifest.url 已指向 R2，老客户端按 url 直下 R2）

[客户端 update_channel.rs::endpoints_for(channel)]
   stable + CN  ──▶  CDN latest.json    + R2 latest.json    + GitHub fallback
   stable + 海外 ──▶  R2 latest.json     + CDN latest.json   + GitHub fallback
   beta   + CN  ──▶  CDN latest-beta.json + R2 latest-beta.json + GitHub channel-beta
   beta   + 海外 ──▶  R2 latest-beta.json  + CDN latest-beta.json + GitHub channel-beta
```

**地区判定**（`is_cn_runtime()`）：扫 `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`：
- `zh_CN` / `zh-CN` / `Hans` 任一开头 → CN
- `zh_TW` / `zh_HK` / `Hant` 任一开头 → 海外（明确）
- 其他（含英文） → 海外

错判代价 = 走慢一档（CDN host 也能 hit R2，R2 host 也能 hit），不会"拿不到"。**不引入 GeoIP 依赖**。

---

## 关键决策

1. **manifest 里的 url 一律指 R2 海外域名**（`openspeech-r2.hexems.com/v<ver>/...`）。客户端按 endpoints 数组首选当前 region 的 manifest host 加速 manifest 拉取，**二进制下载仍按 manifest 里的 R2 url**（未做 url rewrite）。
   - 如果后续要把二进制下载也分流到 CDN，给 update_channel.rs 加一个 url 重写（`replace("openspeech-r2.hexems.com", "openspeech-cdn.hexems.com")`）即可。当前未做的原因：R2 自带 Cloudflare 全球 CDN 加速大文件，国内直连 R2 体感不算太慢；改动小但需要灰度验证。

2. **三层 endpoint 兜底**（首选 region host → 备份 host → GitHub Release）。任一域名故障都不会让用户拿不到更新。

3. **COS 不再镜像二进制**。manifest 兜底的代价 ≈ 几 KB × 每次发版；产物镜像几百 MB 跨境上传去掉，CI 时间显著缩短。

4. **manifest 强制 no-cache**（`cache-control: no-cache, max-age=0`）。CDN 边缘永远回源拿最新 manifest，不会有"发版后用户半小时才看到"的体感问题。二进制按版本归档（`v<ver>/...`）天然唯一，CDN 默认缓存策略安全。

---

## 同步实现要点（改 release.yml 时勿踩）

### R2 上传（`Upload artifacts to R2` step）

1. **endpoint 不带 bucket 段**：`R2_ENDPOINT` Secret 必须只写 `https://<account>.r2.cloudflarestorage.com`，不要写 `.../openspeech`。带 bucket 段会让 SDK 拼成 `/openspeech/openspeech/...` → 403 AccessDenied。

2. **R2 API token 权限**：作用域勾上 `openspeech` bucket，权限至少 `Object Read & Write`。

3. **路径布局**（与历史 COS 一致，方便客户端逻辑无差别）：
   ```
   r2://openspeech/v<version>/OpenSpeech-...    按版本归档（永不重复，长缓存）
   r2://openspeech/latest.json                  stable 滚动指针（no-cache）
   r2://openspeech/latest-beta.json             beta 滚动指针（no-cache）
   r2://openspeech/download-stable.json         官网下载页 stable 清单
   r2://openspeech/download-beta.json           官网下载页 beta 清单
   r2://openspeech/download.json                聚合入口（stable 优先，beta 仅在没 stable 时占位）
   ```

4. **使用 `aws s3` CLI**：runner 自带，不需要装额外 binary。R2 是 S3 兼容协议；走 `AWS_ENDPOINT_URL` + `AWS_DEFAULT_REGION=auto`。`aws s3api head-object` 用来探 download-stable.json 是否已存在（决定 beta 是否占位聚合入口）。

5. **manifest 头部**：`--content-type application/json --cache-control "no-cache,max-age=0"`，与历史 COS 行为对齐。

### COS legacy 兜底（`Mirror manifests to COS (legacy clients)` step）

仅 `coscli cp latest.json` / `latest-beta.json`，**不**再 `coscli sync staging/`。预计两到三个 stable 版本后老客户端基本升级完，整段可删；同时清理 `TENCENT_*` Secrets。

### Bundle targets

`tauri.conf.json` `bundle.targets` 必须显式列表，**不含 `msi`** —— Windows MSI 拒收 SemVer pre-release（`-beta.N`），打包阶段直接 fail。Tauri 2 updater for Windows 走 NSIS `-setup.exe`，MSI 不需要。

---

## 腾讯云 CDN 配置（一次性，已配好；改的时候参考）

加速域名 = `openspeech-cdn.hexems.com`，回源到 R2 自定义域名。

| 字段 | 值 |
|---|---|
| 加速域名 | `openspeech-cdn.hexems.com` |
| 源站类型 | 自有源 / HTTPS |
| 源站地址 | `openspeech-r2.hexems.com:443` |
| **回源 HOST** | **`openspeech-r2.hexems.com`**（关键：必须改为源站同名，不能用默认"加速域名相同"） |
| 回源协议 | HTTPS |
| 强制 HTTPS 跳转 | 开 |

**踩过的坑**：第一次配置时回源 HOST 用的是默认的「与加速域名相同」（即 `openspeech-cdn.hexems.com`），R2 自定义域名只接受 host = 自身的请求，CDN 回源恒返 404。表现：`curl -I https://openspeech-cdn.hexems.com/latest-beta.json` 返回 `HTTP/2 404` + `server: cloudflare` + `x-nws-log-uuid` —— 同时有腾讯云和 Cloudflare 的 header 是 CDN 已介入但回源被 R2 拒的标志。修：控制台 → 加速域名 → 回源配置 → 回源 HOST 改 `openspeech-r2.hexems.com`，刷新缓存。

DNS 配置：`hexems.com` 在 Cloudflare 托管，`openspeech-cdn` 这条 CNAME 必须设为「**仅 DNS / 灰云**」（不开 Cloudflare proxy），目标是腾讯云 CDN 给的 `<域名>.cdn.dnsv1.com`。开了橙云会把请求劫持到 Cloudflare 边缘，根本不会到腾讯云 CDN。

---

## Updater 日志（排查升级）

`update_channel.rs::check_for_update` 入口 `log::info!` 打四态：

- 入口：`check_for_update channel=<beta|stable> endpoints=[...]`（数组顺序看到就知道当前 region 判定结果）
- 找到更新：`update found <current> -> <new> platform=<key> install_url=<url>`
- 无更新：`no update available`
- check 失败：`updater.check() failed: <err>`

| OS | 日志路径 |
|---|---|
| macOS | `~/Library/Logs/com.openspeech.app/OpenSpeech.log` |
| Windows | `%APPDATA%\com.openspeech.app\logs\` |
| Linux | `~/.config/com.openspeech.app/logs/` |

`grep openspeech::updater <log>` 直接看分流命中。

---

## 验证（每次 release publish 后必跑）

```bash
TAG=v0.2.30-beta.3

# 1. R2 海外域名（manifest）
curl -sI https://openspeech-r2.hexems.com/latest-beta.json
# 期待 HTTP/2 200，content-type: application/json
curl -s https://openspeech-r2.hexems.com/latest-beta.json \
  | jq '{version, urls: (.platforms | map_values(.url))}'
# 期待 platforms.*.url 全部以 https://openspeech-r2.hexems.com/v 开头

# 2. 腾讯云 CDN 国内口
curl -sI https://openspeech-cdn.hexems.com/latest-beta.json
# 期待 HTTP/2 200；header 含 x-nws-log-uuid（腾讯云 CDN 介入的标志）

# 3. ETag 应一致 = CDN 正确回源 R2
curl -sI https://openspeech-r2.hexems.com/latest-beta.json | grep -i etag
curl -sI https://openspeech-cdn.hexems.com/latest-beta.json | grep -i etag

# 4. 二进制大文件 CDN 缓存（第二次应 cf-cache-status: HIT + age > 0）
curl -sI https://openspeech-cdn.hexems.com/v${TAG#v}/OpenSpeech-${TAG#v}-macOS-arm64.dmg
curl -sI https://openspeech-cdn.hexems.com/v${TAG#v}/OpenSpeech-${TAG#v}-macOS-arm64.dmg

# 5. COS 老客户端兜底 manifest 内容应与 R2 一致
curl -s https://openspeech-1329813561.cos.accelerate.myqcloud.com/latest-beta.json \
  | jq '{version, sample: .platforms["darwin-aarch64"].url}'
# 期待 url 指向 https://openspeech-r2.hexems.com/...

# 6. GitHub channel-beta 滚动指针
curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/download/channel-beta/latest-beta.json \
  | jq '{version, urls: (.platforms | map_values(.url))}'
```

任一条不符的诊断方向：

| 现象 | 排查 |
|---|---|
| R2 host 200 但 platforms.url 仍指 cos.accelerate | release.yml 的 `Generate latest.json` step 的 `CDN_HOST` 没改 |
| CDN host 404 + 同时有 cloudflare / 腾讯云 header | 腾讯云 CDN 回源 HOST 没改 R2 自定义域 |
| CDN host 完全 timeout / DNS NXDOMAIN | DNS 没切（Cloudflare 还开着橙云）或腾讯云 CDN 加速域名状态不是「已启用」 |
| ETag CDN ≠ R2 | CDN 缓存了陈旧 manifest（应 no-cache 但配置漏） → 控制台刷新缓存 |
| GitHub channel-beta 未更新 | `Update channel-beta pointer release` step 有日志报错；该 step 用 `gh release upload --clobber` |

---

## 应急

### R2 全挂

新客户端：endpoints 数组第三项是 GitHub Release，自动 fallback。无需人工干预。
老客户端：从 COS 拉 manifest 仍可用，但 manifest.url 指 R2 → 二进制下载也挂；应急把 latest.json 的 platforms.*.url 改写为 GitHub `/releases/download/<tag>/<file>`，上传到 GitHub Release 覆盖：

```bash
gh release upload v0.x.y latest.fallback.json --repo OpenLoaf/OpenSpeech --clobber
```

### 腾讯云 CDN 全挂

国内用户 endpoints 数组第二项是 R2 海外，自动回退（慢但能用）。无需人工干预。

### 老客户端（≤0.2.30-beta.2）+ COS 同时挂

它们的 endpoints 写死 `cos.accelerate.myqcloud.com`，**没有 R2 fallback**（fallback 只到 GitHub）。COS 全挂期间老客户端会从 GitHub `/latest/download/latest.json` 拉到一份 url 指向 R2 的 manifest（GitHub 上的 manifest 是 release.yml 一并 publish 的），仍可走完升级。

---

## R2/CDN 相关 Common Mistakes

| 错误 | 正确做法 |
|---|---|
| `R2_ENDPOINT` 带 `/openspeech` 后缀 | 只写 `https://<account>.r2.cloudflarestorage.com`，bucket 由 `R2_BUCKET` 单独传 |
| 腾讯云 CDN 回源 HOST 没改 | 必须改为 R2 自定义域名 `openspeech-r2.hexems.com`，否则 R2 拒收 404 |
| 在 Cloudflare DNS 上对 `openspeech-cdn` 开了橙云（proxy） | 必须灰云（仅 DNS），否则 Cloudflare 劫持请求，永远到不了腾讯云 CDN |
| 改 `update_channel.rs` 的 endpoint 常量后忘了发版 | endpoint 编进二进制，必须发新版才生效 |
| 改 `is_cn_runtime()` 判定逻辑后只在英文系统测 | 至少跑一次中文系统（设 `LANG=zh_CN.UTF-8`）+ `LC_ALL=en_US` 验各分支 |
| 删掉 COS legacy step 时机太早（< 2 个月） | 至少观察一到两个 stable 版本完成、老客户端日志能看到大部分已升到 0.2.30-beta.3+，再断 |
| 没把 manifest 设 `cache-control: no-cache` | CDN 缓存陈旧 manifest，发版半小时用户拿不到；R2 上传时必须显式带这个 header |
| 看 manifest url 是 cos 还是 r2 来诊断"加速生效" | 加速生效与否看 endpoints 数组顺序（来自 `is_cn_runtime`） + updater 日志的 `endpoints=[...]` 行；manifest url 现在永远是 R2 |
| `bundle.targets: "all"` 发 beta | Windows MSI 拒收 SemVer pre-release（`-beta.N`）→ build fail。`bundle.targets` 必须显式列表，去掉 `msi` |
