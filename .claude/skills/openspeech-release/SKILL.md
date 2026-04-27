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

> **维护要求：** 当 `release.yml` / `tauri.conf.json` updater 段 / `scripts/sync-version.mjs` /
> changelogs 路径约定有变更，必须同步更新本文件。

---

## 一、链路速览（先看清楚再动手）

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
      ├─ jq 拼出 latest.json（updater 入口）
      ├─ 读 docs/changelogs/{ver}/zh.md 作为 Release body
      └─ 创建 draft Release（softprops/action-gh-release）

人工：去 https://github.com/OpenLoaf/OpenSpeech/releases 点 Publish
  ↓
GitHub /latest/download/latest.json 解析到本次 tag
  ↓
旧客户端启动时（main.tsx bootPromise）或托盘"检查更新"
  ↓
tauri-plugin-updater 拉 latest.json → 校验 minisign 签名 → 下载 → 替换 → relaunch
```

**单一事实源（不要重复）：**

| 项 | SSoT |
|---|---|
| 应用版本号 | `package.json.version`（Cargo.toml / tauri.conf.json 自动同步） |
| Release 正文 | `docs/changelogs/{version}/zh.md`（缺失时回退 `en.md`，再缺回退默认文案） |
| Updater endpoint | `src-tauri/tauri.conf.json` `plugins.updater.endpoints[0]` |
| 远程仓库 | `git@github.com:OpenLoaf/OpenSpeech.git` |
| CI workflow | `.github/workflows/release.yml`（tag `v*` 触发） |

---

## 二、用户意图解析

| 用户输入 | 含义 | 默认动作 |
|---|---|---|
| 「发版」「release」「触发更新」 | 走完整流程 | 默认 `patch`，先确认 |
| 「patch / minor / major」 | 指定版本段 | 直接按指定段 bump |
| 「发个 beta」「beta release」「灰度」「内测」 | 走 beta 通道 | 见 §九.五「Beta 通道」 |
| 「转正」「beta 转 stable」 | 把当前 beta 升级成正式版 | 见 §九.五「Beta 通道」 |
| 「提交一下并发版」「全部提交并发版」 | 包含未暂存改动 | Step 1 处理累计改动 |
| 「这个 commit 不发版，只是提交」 | 仅 Step 1 | 提交后停止，不 bump |
| 「重发一下」「补一个 build」「重跑 CI」 | tag 已存在，重新触发 | 见 §九「重跑 CI」 |
| 「撤回 / 下架 / 把那个版本删了」 | unpublish 已发布 Release | 见 §九「撤回」 |

**含糊不清时：先 `git status` + `git log --oneline -5` + 当前 `package.json.version`，把现状摆给用户看，再问要不要发版、bump 哪段。**

---

## 三、Pre-flight 检查（必跑，不要跳）

```bash
# 1. 确认在 OpenSpeech 仓库（远程必须是 OpenLoaf/OpenSpeech）
git remote -v

# 2. 确认在 main 分支
git branch --show-current

# 3. 看清楚有哪些改动 / 哪些是临时文件
git status

# 4. 看下当前版本号 + 最近 commit
node -p "require('./package.json').version"
git log --oneline -5
git tag -l 'v*' | tail -5
```

**看到下列任何一项，先停下问用户：**

- 当前不在 `main`
- 远程不是 `OpenLoaf/OpenSpeech`
- 工作区有 `.tmp/` / `test.md` / `.env` / `*.p12` / `*.key` 等不应提交的文件未在 `.gitignore` 里
- `package.json.version` 与 `src-tauri/Cargo.toml` `[package].version` 不一致
- 上一个 tag 还没被 publish（`gh release view v{prev} --json isDraft` → `true`）

---

## 四、Step 1：提交累计改动

### 原则

- **不要 `git add -A` / `git add .`**：会误吞 `.tmp/`、`.env`、临时素材
- 用 `git add -u` 把已 tracked 的改动加进去，再 **逐个 add 该提交的新文件**
- commit message 走 conventional commit；scope 用 `feat / fix / chore / ci / docs / refactor` 等
- **commit message 严禁带 `[skip ci]`**——会让后面的 tag push 不触发 CI

### 命令模板

```bash
git add -u
# 然后明确列出该 add 的新文件（举例）
git add scripts/foo.sh public/new-asset.png

# 检查暂存区，确认没有 .tmp/ 之类
git status --short

git commit -m "$(cat <<'EOF'
chore(release): 提交累计改动准备发版 0.x.y

- 第一句改动概要
- 第二句改动概要
- ……

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 临时文件常见名单（默认不提交）

| 路径 | 处理 |
|---|---|
| `.tmp/` | 已在 `.gitignore` 中，本地素材 |
| `test.md` | 已在 `.gitignore` 中，对话总结 |
| `.env` / `.env.*`（除 `.env.example`） | 已在 `.gitignore` 中 |
| `*.key` / `*.p12` / `*.cer` / `*.p8` | 已在 `.gitignore` 中，签名密钥 |
| `dist/` / `node_modules/` / `src-tauri/target/` | 已在 `.gitignore` 中 |

发现 `.gitignore` 没覆盖的临时目录，**先补 `.gitignore`，再提交**。

---

## 五、Step 2：写 changelog（用户看得到的内容）

> Release 正文 SSoT = `docs/changelogs/{version}/zh.md`。**没写文件的话 GitHub Release 正文会回退成默认占位文案，下载页空空荡荡，对用户体验不好。**

### 路径约定

```
docs/changelogs/
  └─ {version}/                # 例：0.2.5
      ├─ zh.md     ← 默认正文（必填，CI 优先读这个）
      └─ en.md     ← 可选，zh.md 缺失时回退
```

`{version}` 不带 `v` 前缀，只是 semver 数字串（与 `package.json.version` 一致）。

### 文件模板

```markdown
## v0.2.5

### 新增
- 简短一句，用户能看懂的描述（不要写"refactor xxx Provider"这种内部术语）

### 改进
- ……

### 修复
- ……

### 已知问题（可选）
- ……
```

### 写 changelog 的素材

跟用户对齐这次发版包含哪些改动。可参考：

```bash
# 上一个 tag 到 HEAD 的所有 commit
git log $(git describe --tags --abbrev=0)..HEAD --oneline

# 本轮已暂存改动统计
git diff --staged --stat
```

筛选 **用户能感知到** 的改动（新功能、UI 变化、修复了用户报过的 bug）。**纯重构 / CI 改动 / 内部测试** 不要写进 changelog。

---

## 六、Step 3：Bump 版本号

```bash
pnpm version patch    # 0.2.4 → 0.2.5（默认）
pnpm version minor    # 0.2.4 → 0.3.0
pnpm version major    # 0.2.4 → 1.0.0
```

`pnpm version` 会自动：

1. 改 `package.json.version`
2. 触发 `package.json.scripts.version` lifecycle → `node scripts/sync-version.mjs && git add src-tauri/Cargo.toml`
   - `sync-version.mjs` 同步 `src-tauri/Cargo.toml` `[package].version`
   - `tauri.conf.json` 用 `"version": "../package.json"` 自动跟随，不需要改
3. 自动 `git commit -m "0.x.y"` 把这两个文件提交
4. 自动打 annotated tag `v0.x.y`

**不要手改 `Cargo.toml` 或 `tauri.conf.json` 的版本号；不要 `npm version`，要 `pnpm version`。**

---

## 七、Step 4：Push 推 tag 触发 CI

```bash
# main 分支推送（包含 Step 1 的 commit + pnpm version 自动 commit）
git push origin main

# 推送 tag —— 这是触发 release.yml 的关键
git push origin v0.x.y
```

**不要 `git push --tags`**：会把所有本地未推送 tag 一次性推上去，可能把废弃的 tag 也带过去触发 CI。**只推本次的 tag**。

### 监控 CI

```bash
# 看本次 run 状态
gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 3

# watch 直到结束（参考耗时：~12-13 分钟）
gh run watch --repo OpenLoaf/OpenSpeech <run-id>
```

历史耗时参考（看 build 矩阵的瓶颈）：

- macOS Intel 通常最慢（aarch64 runner 上交叉编译 x86_64）
- Linux ARM64 次慢
- Windows / macOS ARM64 较快

**任一 platform 失败 → fail-fast 取消其他**。失败时先看 build 那一格的日志：

```bash
gh run view --repo OpenLoaf/OpenSpeech <run-id> --log-failed
```

---

## 八、Step 5：Publish draft Release

CI 成功后会创建 **draft** Release，**不会自动让用户看到**。必须手动 publish：

```bash
# 看下 draft 是否就绪
gh release view v0.x.y --repo OpenLoaf/OpenSpeech --json isDraft,assets

# 一键 publish
gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --draft=false
```

也可以去 https://github.com/OpenLoaf/OpenSpeech/releases 网页点击 Publish 按钮。

### Publish 后立刻验证

```bash
# 1. /latest/download/ 重定向应该指向本次 tag
curl -sI https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json | grep -i location

# 2. latest.json 应能正常返回 + 6 个 platform key 齐全
curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json | jq '.platforms | keys'
# 期望：["darwin-aarch64","darwin-x86_64","linux-aarch64","linux-x86_64","windows-aarch64","windows-x86_64"]
```

返回 `Not Found` 说明 publish 没成功，回 §八 重做。

### 验证客户端能收到更新

随便找一台装着 **旧版本** OpenSpeech 的机器：

- 重启应用 → boot 期 `main.tsx` 会跑 `checkForUpdate()`，命中后自动下载替换
- 或：托盘菜单点「检查更新」→ 看到「发现新版本 vX.Y.Z」 toast

dev 模式 `import.meta.env.DEV === true` 会跳过启动检查，只能托盘手动测。

---

## 九、特殊场景

### 重跑 CI（同一 tag）

GitHub tag 推上去之后只触发一次 workflow。需要重跑：

```bash
# 找到失败的 run
gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 5

# 重跑（仅失败 jobs）
gh run rerun <run-id> --failed --repo OpenLoaf/OpenSpeech
# 或重跑全部
gh run rerun <run-id> --repo OpenLoaf/OpenSpeech
```

**不要为了重跑而删 tag 再重打**——会给已经下载过 latest.json 的客户端造成混乱，且 GitHub Release 历史会断。

### 撤回已 publish 的 Release

下架后立刻：

```bash
gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --draft=true
# 或彻底删除
gh release delete v0.x.y --repo OpenLoaf/OpenSpeech --yes
# tag 也一起删（可选，慎用）
git push origin :refs/tags/v0.x.y
git tag -d v0.x.y
```

撤回会让 `/latest/download/` 立刻回退到上一个 published Release。**已经下载完替换包的客户端不会回滚**——他们已经是新版本了。

### 九.五、Beta 通道

OpenSpeech 支持双更新通道：用户在「设置 → 关于 → 更新通道」选 `Stable` 或 `Beta`。Beta 通道的 endpoint 是 `releases/download/channel-beta/latest-beta.json`（一个滚动指针 release）。

**关键约定：**

| 项 | 规则 |
|---|---|
| 版本号 | `0.x.y-beta.N`（SemVer 预发布段，N 从 0 起） |
| Tag | `v0.x.y-beta.N` |
| GitHub Release | 自动标记为 `prerelease: true`（`releases/latest/download/` 不会指过去） |
| 入口文件 | 主 release 上传 `latest.json` + `latest-beta.json`（内容相同），CI 自动把 `latest-beta.json` `--clobber` 到 `channel-beta` 这个固定 tag 的 release |
| Stable 用户 | 不会拉到 beta（GitHub 的 `latest` 算法跳过 prerelease） |
| Beta 用户 | 拉 `channel-beta/latest-beta.json` → 永远是最新 beta-or-stable |
| 关闭 Beta 后 | SemVer 规定 `0.3.0 > 0.3.0-beta.N`，所以 stable 高于当前 beta 时才会更新；stable 还停在 beta 之前 → updater 判 "已是最新"，不更新 |

#### 命令模板

```bash
# 当前 0.2.17 → 第一个 beta
pnpm version prepatch --preid=beta   # 0.2.17 → 0.2.18-beta.0
# 后续 beta 迭代
pnpm version prerelease --preid=beta # 0.2.18-beta.0 → 0.2.18-beta.1

# beta 转正（同一 0.2.18 周期）
pnpm version patch                    # 0.2.18-beta.N → 0.2.18

# 推 tag（注意 tag 名带 -beta）
git push origin main
git push origin "v$(node -p "require('./package.json').version")"
```

#### Beta changelog

`docs/changelogs/{version}/zh.md` 的 `{version}` 必须包含 beta 后缀，例如：

```
docs/changelogs/0.2.18-beta.1/zh.md
```

beta release 的 changelog 通常更短，列出本轮 beta 想验证的功能 + 已知风险即可。**正式版本（去掉 -beta 后）需要单独写一份 changelog**，不能复用 beta 的。

#### Beta 完整流程

1. Pre-flight 检查（同 §三）
2. 提交累计改动（§四）
3. `mkdir -p docs/changelogs/0.x.y-beta.N && $EDITOR docs/changelogs/0.x.y-beta.N/zh.md`
4. `pnpm version prepatch --preid=beta`（首发）或 `pnpm version prerelease --preid=beta`（迭代）
5. `git push origin main && git push origin v0.x.y-beta.N`
6. 监控 CI（§七）
7. Publish draft release —— **publish 时 prerelease 标志已由 release.yml 自动打上**，不需要手动改：
   ```bash
   gh release edit v0.x.y-beta.N --repo OpenLoaf/OpenSpeech --draft=false
   ```
8. 验证 beta 通道入口：
   ```bash
   curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/download/channel-beta/latest-beta.json | jq '.version, .platforms | keys'
   ```
9. 让 beta 测试用户在 OpenSpeech 设置里切到 Beta 通道，重启或托盘"检查更新"即收到。

#### Beta 转正

beta 测够了要转正：

```bash
# 假设当前是 0.2.18-beta.3，转成 0.2.18 正式
pnpm version patch    # 0.2.18-beta.3 → 0.2.18
```

正常推 tag、走 CI、publish。stable 用户和 beta 用户都会收到这个 0.2.18（beta 通道的 latest-beta.json 也会被本次 release 覆盖更新成 stable 0.2.18）。

#### Beta Common Mistakes

| 错误 | 正确做法 |
|---|---|
| 用 `pnpm version patch` 发 beta | 必须 `prepatch --preid=beta` 或 `prerelease --preid=beta` |
| `--preid` 写成 `alpha / rc / dev` 等 | release.yml 只检测 `-beta`；其他后缀仍走 stable，会污染正式通道 |
| 手改 package.json 版本号成 `0.2.18-beta.1` | 必须用 `pnpm version prerelease`，否则 git tag 不会自动打 |
| beta release publish 后没去 `channel-beta` 看 latest-beta.json 是否更新 | CI 用 `gh release upload --clobber` 自动覆盖；publish 主 release 后手动 curl 一次确认 |
| 把 beta 的 changelog 当 stable 的 | 转正时新建 `docs/changelogs/0.2.18/zh.md`，把 beta N 轮的反馈合并写一份 |

---

### 修 changelog 但不 bump 版本

只想改 GitHub Release 正文：

```bash
# 改 docs/changelogs/{ver}/zh.md
gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --notes-file docs/changelogs/{ver}/zh.md
```

不需要重跑 CI。

### 临时 hotfix 跳过 CI 矩阵的某个平台

不支持。CI `fail-fast: true` 是有意为之，避免半成品 draft。要改架构去 `release.yml`。

---

## 十、Common Mistakes

| 错误 | 正确做法 |
|---|---|
| `git add -A` 把 `.tmp/` 一起提交 | `git add -u` + 逐个 add 新文件，先验证 `git status --short` |
| commit message 写 `[skip ci]` | **永远不要**——tag push 后 CI 不会跑 |
| 手改 `src-tauri/Cargo.toml` 的 version | 走 `pnpm version`，由 `sync-version.mjs` 同步 |
| 手改 `tauri.conf.json` 的 version | 它是 `"../package.json"` 自动 resolve，**完全不要碰** |
| 用 `npm version` 替代 `pnpm version` | npm 不会触发 `scripts.version` 的 pnpm lifecycle |
| `git push --tags` | 用 `git push origin v0.x.y`，**只推本次 tag** |
| CI 跑完忘了 publish draft | `/latest/download/` 不解析 draft，用户拿不到更新 |
| 没写 `docs/changelogs/{ver}/zh.md` | Release 正文回退到默认占位，用户体验差 |
| 删 tag 重打来重跑 CI | 用 `gh run rerun`；删 tag 会破坏 Release 历史 |
| 把 Apple 证书 / `*.key` commit 进去 | 已在 `.gitignore`；新增任何 `*.p12 / *.p8 / *.cer` 路径前先确认 ignore |
| dev 模式测 updater | dev 跳过 `check()`，必须 release 包测；或托盘手动触发 |
| publish 前没验证 `latest.json` 的 6 个 platform key | 漏一个就有平台用户拿不到更新；publish 后立刻 `curl + jq` 验 |

---

## 十一、Quick Reference

```bash
# 完整流程一把梭（patch）
git status                                        # ① 看清楚
git add -u && git add <new-files>                 # ② 暂存
git commit -m "feat(xxx): ..."                    # ③ 提交累计改动
$EDITOR docs/changelogs/$(node -p "require('./package.json').version | (split('.')|.[0:2]|join('.')+'.'+((.|split('.').[2]|tonumber+1)|tostring))")/zh.md
                                                  # ④ 写 changelog（路径用预测的下个版本号）
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

## 十二、相关文件索引

| 文件 | 作用 |
|---|---|
| `.github/workflows/release.yml` | CI 入口，tag `v*` 触发 |
| `scripts/sync-version.mjs` | npm version lifecycle，同步 Cargo.toml |
| `package.json.scripts.version` | hook 配置：`node scripts/sync-version.mjs && git add src-tauri/Cargo.toml` |
| `src-tauri/tauri.conf.json` | `plugins.updater.{pubkey,endpoints}` + `bundle.createUpdaterArtifacts: false`（CI override true）；`endpoints` 仅作 stable 默认，beta 通道由 Rust 自定义 command 在 runtime 注入 |
| `src-tauri/src/lib.rs` | `tauri_plugin_updater::Builder::new().build()` 注册 + 托盘"检查更新"菜单项 |
| `src-tauri/src/update_channel.rs` | Beta 通道实现：`get/set_update_channel` + `check_for_update` 自定义 command（按 channel 文件切 endpoints，rid 共享 webview ResourceTable） |
| `src/lib/updaterInstall.ts` | 前端 `checkForUpdateForChannel` + `installUpdateWithProgress`（toast 进度条） |
| `src/main.tsx` | bootPromise 启动检查（30s 超时；走 channel 命令） |
| `src/components/Layout.tsx` | 托盘"检查更新" → toast 反馈 |
| `src/components/SettingsContent.tsx` | 设置 → 关于 → 更新通道 RadioGroup |
| `docs/changelogs/{version}/zh.md` | **GitHub Release 正文 SSoT** |
| `~/.tauri/openspeech.key` | minisign 私钥（本地，不入库） |
| GitHub Secrets | `TAURI_SIGNING_PRIVATE_KEY` / `MAC_CER_BASE64` 等，详见 release.yml 注释 |
