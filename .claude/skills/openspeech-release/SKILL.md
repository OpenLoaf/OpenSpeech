---
name: openspeech-release
description: >
  OpenSpeech 发版执行总入口。当用户在 OpenSpeech 仓库说「发版 / release / 发布新版本 /
  打个新包 / 触发自动更新 / 升级版本号 / bump / 提交并发版 / patch / minor / major /
  推 tag / 让用户能收到更新」等任意一种意图时，**都触发本 skill**。涵盖完整流程：
  提交累计改动 → 写 changelog → bump 版本号 → 推 tag → 监控 CI → publish draft Release，
  并讲清每步会动哪些文件、哪些步骤会真的影响生产（终端用户）。当用户说「让线上的人能更新到」「让
  桌面端弹出升级提示」「触发 OTA」也走这个 skill。不要凭印象 push tag——本 skill 列出的检查
  与确认动作必须按顺序跑完。
---

# OpenSpeech 发版

> **本文件是导航 + 标准 stable 流程的可执行指引。** 特殊场景（beta、跳 beta、R2/CDN 链路、撤回等）
> 进 §二 决策表，按需读对应 `references/*.md`，不要把所有内容拉进上下文。

---

## 一、链路速览（一句话版）

```
本地 commit → 写 docs/changelogs/{ver}/zh.md → pnpm version <seg>
   → git push origin main + git push origin v{ver}
   → CI（6 平台 build → release job 拼 latest.json → 上传 R2 + 镜像 COS 兜底）
   → 人工 publish draft → updater 按 region 拉 manifest（CN→CDN / 海外→R2）
   → 终端用户收到更新
```

分发改造（自 v0.2.30-beta.3）：单写 Cloudflare R2（`openspeech-r2.hexems.com`），国内由腾讯云 CDN
（`openspeech-cdn.hexems.com`）回源 R2；客户端按 `LANG / LC_*` 信号在两个 host 间分流，第三层
fallback GitHub Release。COS 仅保留 `latest.json` / `latest-beta.json` 给 ≤ v0.2.30-beta.2 老客户端兜底。

完整流程图、SSoT 表、文件索引、CI 各 step 细节看 `references/architecture.md`；R2/CDN 配置 + 验证 +
排错看 `references/r2-cdn.md`。

**最关键的几条 SSoT（不要弄反）：**

- 应用版本号 SSoT = `package.json.version`（Cargo.toml / tauri.conf.json 自动同步，**不要手改**）
- Release 正文 SSoT = `docs/changelogs/{version}/zh.md`（缺失则正文回退默认占位，体验差）
- Updater 运行时 endpoint SSoT = `src-tauri/src/update_channel.rs`（按 region × channel 4 选 1；`tauri.conf.json` 里的 `endpoints` 只是占位）
- 分发主存储 = Cloudflare R2 bucket `openspeech`（不再单写 COS；COS 只剩 manifest 兜底）
- Bundle targets **必须显式列表，无 msi**（MSI 拒收 SemVer pre-release）

---

## 二、用户意图 → 走哪条流程

| 用户输入 | 含义 | 走哪 |
|---|---|---|
| 「发版」「release」「触发更新」 | 完整 stable 流程 | 默认 patch，本文件 §四–§九 |
| 「patch / minor / major」 | 指定段 | 本文件 §四–§九 |
| 「发个 beta」「灰度」「内测」 | beta 通道 | `references/beta.md` |
| 「转正」「beta 转 stable」 | beta → stable | `references/beta.md` 末尾「Beta 转正」 |
| 「直接发 stable」「跳过 beta」「不走灰度」「直接出生产版本」 | 跳 beta | `references/skip-beta.md` |
| 「重发」「补一个 build」「重跑 CI」 | tag 已存在 | `references/troubleshooting.md` |
| 「撤回 / 下架 / 删了那个版本」 | unpublish | `references/troubleshooting.md` |
| 「只改 Release 正文」「修 changelog 不发版」 | 单独编辑 release notes | `references/troubleshooting.md` |
| 国内下载慢 / R2 / CDN / manifest 指哪儿 / updater 日志 / 回源 / 老客户端兜底 | R2 + CDN 分发链路 | `references/r2-cdn.md` |
| 改 release.yml / SDK 升级 / 排查 CI / Secrets | 架构层面 | `references/architecture.md` |

**含糊不清时**：先 `git status` + `git log --oneline -5` + `node -p "require('./package.json').version"`，
把现状摆给用户，再问要不要发版、bump 哪段、走哪个通道。

**关于 beta 与 stable**：beta **不是** stable 的强制前置。可以「先 beta 灰度 → 转正」也可以「直接发 stable」。
后者跳过真实用户验证缓冲，何时该跳何时不该跳见 `references/skip-beta.md`。

---

## 三、Pre-flight 检查（必跑，不要跳）

```bash
# 1. 远程必须是 OpenLoaf/OpenSpeech
git remote -v

# 2. 必须在 main 分支
git branch --show-current

# 3. 看清楚有哪些改动 / 哪些是临时文件
git status

# 4. 看下当前版本号 + 最近 commit
node -p "require('./package.json').version"
git log --oneline -5
git tag -l 'v*' | tail -5
```

异常情形（不在 main / 远程错 / 工作区有 .tmp / version 不一致 / 上一个 tag 还是 draft）的处理见
`references/troubleshooting.md` 末尾。

---

## 四、Step 1：提交累计改动

**原则：**

- **不要 `git add -A` / `git add .`** —— 会误吞 `.tmp/`、`.env`、临时素材
- 用 `git add -u` 把已 tracked 改动加进去，再**逐个 add 该提交的新文件**
- commit message 走 conventional commit；scope 用 `feat / fix / chore / ci / docs / refactor` 等
- **commit message 严禁带 `[skip ci]`** —— 后续 tag push 不会触发 CI

```bash
git add -u
git add scripts/foo.sh public/new-asset.png   # 明确列出要 add 的新文件

git status --short                             # 确认没有 .tmp/ 等

git commit -m "$(cat <<'EOF'
chore(release): 提交累计改动准备发版 0.x.y

- 改动概要 1
- 改动概要 2

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

**临时文件清单（默认不应提交）：** `.tmp/`、`test.md`、`.env(.|*)`（除 `.env.example`）、
`*.key / *.p12 / *.cer / *.p8`、`dist/ / node_modules/ / src-tauri/target/`。
都已在 `.gitignore` 中。新出现未被 ignore 的临时目录，**先补 `.gitignore` 再提交**。

> 「这个 commit 不发版，只是提交」→ Step 1 完事就停，不要继续 bump。

---

## 五、Step 2：写 changelog

> **`docs/changelogs/{version}/zh.md` 是 GitHub Release 正文的 SSoT。** 不写的话正文会回退默认占位，
> 用户下载页空空荡荡。

路径：

```
docs/changelogs/
  └─ {version}/        # 例：0.2.5（不带 v 前缀，与 package.json.version 一致）
      ├─ zh.md         ← CI 优先读
      └─ en.md         ← 可选，zh.md 缺失时回退
```

模板：

```markdown
## v0.2.5

### 新增
- 一句用户能看懂的描述（不要写"refactor xxx Provider"这种内部术语）

### 改进
- ……

### 修复
- ……

### 已知问题（可选）
- ……
```

写素材：

```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline   # 上一个 tag 到 HEAD
git diff --staged --stat                                     # 本轮已暂存改动
```

**只写用户能感知的改动**（新功能、UI 变化、用户报过的 bug）。纯重构 / CI / 内部测试不要写进 changelog。

---

## 六、Step 3：Bump 版本号

```bash
pnpm version patch    # 0.2.4 → 0.2.5（默认）
pnpm version minor    # 0.2.4 → 0.3.0
pnpm version major    # 0.2.4 → 1.0.0
```

`pnpm version` 自动：

1. 改 `package.json.version`
2. 触发 `package.json.scripts.version` lifecycle → `node scripts/sync-version.mjs && git add src-tauri/Cargo.toml`
   - `sync-version.mjs` 同步 `src-tauri/Cargo.toml [package].version`
   - `tauri.conf.json` 用 `"version": "../package.json"` 自动跟随
3. 自动 `git commit -m "0.x.y"` 把这两个文件提交
4. 自动打 annotated tag `v0.x.y`

**不要手改 Cargo.toml / tauri.conf.json 的版本号；不要 `npm version`，要 `pnpm version`。**

> beta 用 `pnpm version prepatch --preid=beta` 或 `prerelease --preid=beta`，详见 `references/beta.md`。

---

## 七、Step 4：Push 推 tag 触发 CI

```bash
git push origin main                           # 含 Step 1 + pnpm version 自动 commit
git push origin v0.x.y                         # 推本次 tag —— 触发 release.yml 的关键
```

**不要 `git push --tags`** —— 会把所有本地未推送 tag 一次性推上去，可能把废弃 tag 也带过去触发 CI。
**只推本次 tag。**

### 7.1 孤儿 tag 处理（本次发版前必跑）

> **背景**：上一轮发版可能只推了 commit、tag 没推上去；或本地为了实验/调试打过 `vX.Y.Z` 但
> 不再打算发布。这类「本地有 / remote 没有」的 tag 称为**孤儿 tag**。如果误用 `git push --tags`
> 会把它们一起推上去，每个都命中 `release.yml` 的 `tags: 'v*'` 触发器，跑出多余的 build。
> 更糟的是：它们也是 `-beta` / 正式版命名，会抢走 R2 上的 `latest-beta.json` / `latest.json`
> 滚动指针，让 updater 客户端被"降级"到那些旧版本。

```bash
# ① 列出所有本地有 / remote 没有的 tag
comm -23 \
  <(git tag -l 'v*' | sort) \
  <(git ls-remote --tags origin 'v*' | awk '{print $2}' | sed 's@refs/tags/@@;s/\^{}$//' | sort -u)
```

逐条判断：

| 该 tag 是… | 处理 |
|---|---|
| 本次刚 `pnpm version` 打出来的（即将发版） | 保留，单推：`git push origin v0.x.y` |
| 已经 publish 过 release / 已构建归档过的旧 tag | **跳过**——本地删除：`git tag -d v0.x.y`（remote 不动，已发布的 release 不受影响） |
| 实验/调试残留 / 决定放弃的版本 | **跳过**——本地删除：`git tag -d v0.x.y` |
| 上一轮发版漏推的、确实需要补打 build | 单推：`git push origin v0.x.y`（接受会跑一条 CI） |

**铁律：永远 `git push origin <single-tag>` 单推。** 只有在确认本地未推 tag 列表全是"需要触发 CI 的"
才能用 `git push --tags`，绝大多数发版场景都不该用。

### 7.2 误推孤儿 tag 的应急

如果不小心 `--tags` 把孤儿推上去了，**立刻**：

```bash
# 取消已被触发但还没跑完的 workflow run
gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 5 \
  --json databaseId,headBranch,status \
  | jq '.[] | select(.headBranch=="v0.x.y" and .status=="in_progress")'
gh run cancel <run-id> --repo OpenLoaf/OpenSpeech

# 删除 remote 上的孤儿 tag（destructive，但因为它没对应 release，安全）
git push origin :refs/tags/v0.x.y
```

如果 workflow 已经跑完上传过 R2（`latest-beta.json` 被改写），需要重新触发本次发版的 tag
让 manifest 指针压回正确版本——`gh workflow run` 或 `git push origin :refs/tags/v0.x.y`
后再 `git push origin v0.x.y`。

监控：

```bash
gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 3
gh run watch --repo OpenLoaf/OpenSpeech <run-id>          # 参考耗时 ~12-13 分钟
gh run view --repo OpenLoaf/OpenSpeech <run-id> --log-failed   # 失败时
```

CI `fail-fast: true`：任一 platform 失败就取消其他。重跑见 `references/troubleshooting.md`。

---

## 八、Step 5：Publish draft Release

CI 成功后只创建 **draft**，**不会自动让用户看到**。必须 publish：

```bash
# 看下 draft 是否就绪
gh release view v0.x.y --repo OpenLoaf/OpenSpeech --json isDraft,assets

# 一键 publish
gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --draft=false
```

也可在 https://github.com/OpenLoaf/OpenSpeech/releases 网页点击 Publish。

### Publish 后立刻验证

```bash
# 1. /latest/download/ 应重定向到本次 tag
curl -sI https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json | grep -i location

# 2. latest.json 6 个 platform key 齐全
curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json | jq '.platforms | keys'
# 期望：["darwin-aarch64","darwin-x86_64","linux-aarch64","linux-x86_64","windows-aarch64","windows-x86_64"]

# 3. R2 海外 + 腾讯云 CDN 两个 host 都 200，且 ETag 一致 = CDN 正确回源 R2
curl -sI https://openspeech-r2.hexems.com/latest-beta.json  | grep -iE "(^HTTP|etag)"
curl -sI https://openspeech-cdn.hexems.com/latest-beta.json | grep -iE "(^HTTP|etag|x-nws)"

# 4. COS 老客户端兜底 manifest 也应已就位（≤0.2.30-beta.2 用户走这里）
curl -s https://openspeech-1329813561.cos.accelerate.myqcloud.com/latest-beta.json | jq '.version'
```

任一返回 `Not Found` / 4xx → publish 或上传没成功；CDN 出 404 + cf-ray 同时有腾讯云 header
通常是回源 HOST 没改 R2 自定义域 —— 详见 `references/r2-cdn.md`「踩过的坑」。

R2/CDN 全套验证（含二进制缓存命中、CN 用户分流诊断）、updater 日志路径、Tauri 2 产物格式注意点见
`references/r2-cdn.md` 和 `references/troubleshooting.md`。

### 验证客户端能收到更新

找一台装着旧版本 OpenSpeech 的机器：

- 重启应用 → boot 期 `main.tsx` 跑 `checkForUpdate()`，命中后自动下载替换
- 或：托盘菜单点「检查更新」→ 看到「发现新版本 vX.Y.Z」 toast

dev 模式 `import.meta.env.DEV === true` 跳过启动检查，只能托盘手动测。

---

## 九、Common Mistakes（高频）

| 错误 | 正确做法 |
|---|---|
| `git add -A` 把 `.tmp/` 一起提交 | `git add -u` + 逐个 add 新文件，先验 `git status --short` |
| commit message 写 `[skip ci]` | **永远不要** —— tag push 后 CI 不会跑 |
| 手改 `Cargo.toml` 或 `tauri.conf.json` 的 version | 走 `pnpm version`，由 `sync-version.mjs` 同步 |
| `npm version` 替代 `pnpm version` | npm 不触发 `scripts.version` 的 pnpm lifecycle |
| `git push --tags` | 用 `git push origin v0.x.y`，**只推本次 tag**。本地若残留过孤儿 tag（上一轮发版漏推的、或实验残留），`--tags` 会把它们一起推上去触发多余 CI 并抢 manifest 指针——发版前先按 §7.1 列差集、本地 `git tag -d` 删掉孤儿 |
| CI 跑完忘了 publish draft | `/latest/download/` 不解析 draft，用户拿不到更新 |
| 没写 `docs/changelogs/{ver}/zh.md` | Release 正文回退默认占位，体验差 |
| 删 tag 重打来重跑 CI | 用 `gh run rerun`；删 tag 会破坏 Release 历史 |
| publish 前没验证 `latest.json` 的 6 个 platform key | 漏一个就有平台用户拿不到更新；publish 后立刻 `curl + jq` 验 |
| dev 模式测 updater | dev 跳过 `check()`，必须 release 包测；或托盘手动触发 |

**Beta 专属、跳 beta 专属、R2/CDN 专属的 Common Mistakes** 分别在
`references/beta.md` / `references/skip-beta.md` / `references/r2-cdn.md` 末尾。

---

## 十、Quick Reference（标准 stable 一把梭）

```bash
git status                                        # ① 看清楚
git add -u && git add <new-files>                 # ② 暂存
git commit -m "feat(xxx): ..."                    # ③ 提交累计改动
$EDITOR docs/changelogs/<下一个版本号>/zh.md       # ④ 写 changelog
pnpm version patch                                # ⑤ bump + auto-commit + tag
git push origin main                              # ⑥ 推 commit
git push origin "v$(node -p "require('./package.json').version")"   # ⑦ 推 tag → 触发 CI
gh run watch --repo OpenLoaf/OpenSpeech \
  $(gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 1 --json databaseId -q '.[0].databaseId')
                                                  # ⑧ 监控
gh release edit "v$(node -p "require('./package.json').version")" \
  --repo OpenLoaf/OpenSpeech --draft=false        # ⑨ publish
curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json | jq .
                                                  # ⑩ 验证
```

| 操作 | 命令 |
|---|---|
| 查最近 release runs | `gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 5` |
| 查某 run 失败日志 | `gh run view <id> --repo OpenLoaf/OpenSpeech --log-failed` |
| 重跑失败 jobs | `gh run rerun <id> --failed --repo OpenLoaf/OpenSpeech` |
| 看当前所有 draft | `gh release list --repo OpenLoaf/OpenSpeech` |
| Publish draft | `gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --draft=false` |
| 撤回（转 draft） | `gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --draft=true` |
| 永久删除 release | `gh release delete v0.x.y --repo OpenLoaf/OpenSpeech --yes` |
| 删除远程 tag | `git push origin :refs/tags/v0.x.y` |

---

## 十一、参考文档索引

| 场景 | 文档 |
|---|---|
| 完整链路图 / SSoT 大表 / 文件索引 / GitHub Secrets | `references/architecture.md` |
| Beta 通道发版 / 转正 | `references/beta.md` |
| 跳过 beta 直接发 stable | `references/skip-beta.md` |
| R2 + CDN 分发 / 回源配置 / updater 日志 / 应急 / 老客户端兜底 | `references/r2-cdn.md` |
| 重跑 CI / 撤回 / 修 changelog / Tauri 2 产物 / Pre-flight 异常 | `references/troubleshooting.md` |

> **维护要求**：`release.yml` / `tauri.conf.json` updater 段 / `update_channel.rs` /
> `sync-version.mjs` / `docs/changelogs/` 路径约定 / R2 / 腾讯云 CDN / COS 兜底链路有变更时，
> 必须同步本 SKILL.md 与对应 `references/*.md`（特别是 `references/r2-cdn.md` 与 `references/architecture.md`）。
