---
name: openspeech-update
description: >
  OpenSpeech 发版与 OTA 推送的执行总入口：发版 / release / bump 版本号（patch、minor、major）/ 推 tag /
  出 beta 或跳过 beta / 让桌面端用户收到自动更新，以及双仓发版里前端私仓 src/ 推 npm
  （publish frontend、npm 401 / OTP / bypass 2FA、「上一版前端没生效」补救）时都用本 skill。
  覆盖 src/ 私仓 pnpm publish → 主仓 bump frontend 依赖 → 提交 → changelog → pnpm version →
  推 tag → 监控 CI → publish draft Release 的完整顺序与每步影响面。硬约束：前端 npm 包必须先于后端 bump
  发到 npm，否则 CI 打出带老前端的空版本；不要凭印象推 tag，检查步骤必须按序跑完。
  开发期的签名 / updater 原理问题看 openspeech-dev。
---

# OpenSpeech 版本更新

> 导航 + 标准 stable 流程。特殊场景按 §二 决策表只读对应 `references/*.md`。

---

## 一、链路速览

```
[src/ 私仓] 改前端 → bump src/package.json → pnpm publish → npm 上有新 frontend
   ↓
[主仓] 改 package.json frontend 依赖到新版 → pnpm install 同步 lockfile
   ↓
本地 commit → 写 docs/changelogs/{ver}/zh.md → pnpm version <seg>
   → git push origin main + git push origin v{ver}
   → CI（6 平台 build → release job 拼 latest.json → 上传 R2）
   → 人工 publish draft → updater 按 region 拉 manifest（CN→CDN / 海外→R2）
   → 终端用户收到更新
```

分发 = 单写 Cloudflare R2（`openspeech-r2.hexems.com`），国内由腾讯云 CDN（`openspeech-cdn.hexems.com`）
回源 R2；客户端按 `LANG / LC_*` 在两个 host 间分流，第三层 fallback GitHub Release。

**最关键的几条 SSoT（不要弄反）：**

- 应用版本号 SSoT = `package.json.version`（Cargo.toml / tauri.conf.json 自动同步，**不要手改**）
- 前端 SSoT = npm registry 上的 `@openloaf/openspeech-frontend@<ver>`（**不是** `src/` 目录），主仓通过 `package.json.devDependencies` + `pnpm-lock.yaml` 锁定；`src/` 是独立私仓（`OpenLoaf/OpenSpeech-Frontend`），被主仓 `.gitignore` 忽略
- Release 正文 SSoT = `docs/changelogs/{version}/zh.md`（缺失则正文回退默认占位，体验差）
- Updater 运行时 endpoint SSoT = `src-tauri/src/update_channel.rs`（按 region × channel 4 选 1；`tauri.conf.json` 里的 `endpoints` 只是占位）
- 分发主存储 = Cloudflare R2 bucket `openspeech`；CI 已不写 COS
- Bundle targets **必须显式列表，无 msi**（MSI 拒收 SemVer pre-release）

---

## 二、用户意图 → 走哪条流程

| 用户输入 | 含义 | 走哪 |
|---|---|---|
| 「发版」「release」「触发更新」 | 完整 stable 流程 | 默认 patch，本文件 §三–§八 |
| 「patch / minor / major」 | 指定段 | 本文件 §三–§八 |
| 「发个 beta」「灰度」「内测」 | beta 通道 | `references/beta.md` |
| 「转正」「beta 转 stable」 | beta → stable | `references/beta.md` 末尾「Beta 转正」 |
| 「直接发 stable」「跳过 beta」「不走灰度」「直接出生产版本」 | 跳 beta | `references/skip-beta.md` |
| 「重发」「补一个 build」「重跑 CI」 | tag 已存在 | `references/troubleshooting.md` |
| 「撤回 / 下架 / 删了那个版本」 | unpublish | `references/troubleshooting.md` |
| 「只改 Release 正文」「修 changelog 不发版」 | 单独编辑 release notes | `references/troubleshooting.md` |
| 国内下载慢 / R2 / CDN / manifest 指哪儿 / updater 日志 / 回源 | R2 + CDN 分发链路 | `references/r2-cdn.md` |
| 改 release.yml / SDK 升级 / 排查 CI / Secrets | 架构层面 | `references/architecture.md` |
| 前端 npm publish 报错 / token 401 / OTP 拦截 / 「上一版前端没生效要补救」 | 双仓发版 / npm 凭据 | `references/frontend-npm.md` |
| 「src 下的也要发」「全量发」「前端也要推」 | 双仓同步发版 | 本文件 §三 + `references/frontend-npm.md` |

**含糊不清时**：先跑 §三 的前几条命令把现状摆给用户，再问要不要发版、bump 哪段、走哪个通道。
beta **不是** stable 的强制前置；直接发 stable 会跳过真实用户验证缓冲，何时可跳见 `references/skip-beta.md`。

---

## 三、Pre-flight 检查（必跑，不要跳）

```bash
git remote -v                                   # 远程必须是 OpenLoaf/OpenSpeech
git branch --show-current                       # 必须在 main
git status                                      # 看清改动 / 临时文件
node -p "require('./package.json').version"
git log --oneline -5 && git tag -l 'v*' | tail -5
```

异常情形（不在 main / 远程错 / 工作区有 .tmp / version 不一致 / 上一个 tag 还是 draft）的处理见
`references/troubleshooting.md`「Pre-flight 异常情形」。

### 双仓顺序：前端先上 npm，再发后端

**CI 跑 `pnpm install --frozen-lockfile` 只从 npm 拉 lockfile 锁定的 frontend 版本，不读 `src/` 目录。**
顺序搞反 → desktop bundle 跑老前端 → 本版 changelog 承诺全没生效，只能 bump 下一版重发。

- `src/` 有改动：按 `references/frontend-npm.md` §四 在 `src/` 内提交、bump、`pnpm publish`，publish 输出必须看到
  `+ @openloaf/openspeech-frontend@x.y.z`，再 `npm view <pkg>@<ver>` 独立验证；然后主仓改 devDependencies → `pnpm install`。
- `src/` 没改动也不能跳：仍要确认主仓引用的版本在 npm 上存在。
- **发后端 bump 前必跑三方对齐检查**（主仓 package.json / pnpm-lock.yaml / npm registry 三者相等），脚本见
  `references/frontend-npm.md` §六；不对齐不许往下走。
- npm token / OTP / 401 / 403 / `Bash(npm *)` 白名单等错误诊断见 `references/frontend-npm.md` §三、§五。

---

## 四、Step 1：提交累计改动

- **不要 `git add -A` / `git add .`** —— 会误吞 `.tmp/`、`.env`、临时素材；用 `git add -u` + **逐个 add 该提交的新文件**，提交前 `git status --short` 确认
- commit message 走 conventional commit（`feat / fix / chore / ci / docs / refactor` 等），body 列改动概要
- **commit message 严禁带 `[skip ci]`** —— 后续 tag push 不会触发 CI
- 默认不应提交：`.tmp/`、`test.md`、`.env*`（除 `.env.example`）、`*.key / *.p12 / *.cer / *.p8`、`dist/`、`node_modules/`、`src-tauri/target/`（都已在 `.gitignore`）；新出现未被 ignore 的临时目录，**先补 `.gitignore` 再提交**
- 「这个 commit 不发版，只是提交」→ Step 1 完事就停，不要继续 bump

---

## 五、Step 2：写 changelog

**`docs/changelogs/{version}/zh.md` 是 GitHub Release 正文的 SSoT**（`{version}` 不带 v 前缀；`en.md` 可选，zh 缺失时回退），
不写正文会回退默认占位。**只写用户能感知的改动**（新功能、UI 变化、用户报过的 bug），纯重构 / CI / 内部测试不写，
不用内部术语。模板与取素材命令见 `references/stable-details.md`。

---

## 六、Step 3：Bump 版本号

```bash
pnpm version patch    # 默认；minor / major 同理
```

`pnpm version` 自动改 `package.json.version` → lifecycle 跑 `scripts/sync-version.mjs` 同步 `Cargo.toml` 与
`Cargo.lock` → 自动 commit + 打 annotated tag `v0.x.y`（细节与 `Cargo.lock` 自查见 `references/stable-details.md`）。

**不要手改 Cargo.toml / Cargo.lock / tauri.conf.json 的版本号；不要 `npm version`，要 `pnpm version`。**
beta 用 `pnpm version prepatch --preid=beta` 或 `prerelease --preid=beta`，详见 `references/beta.md`。

---

## 七、Step 4：Push 推 tag 触发 CI

```bash
git push origin main                           # 含 Step 1 + pnpm version 自动 commit
git push origin v0.x.y                         # 推本次 tag —— 触发 release.yml 的关键
```

**不要 `git push --tags`，只推本次 tag。** 推之前先按 `references/troubleshooting.md`「孤儿 tag」
列出本地有 / remote 没有的 tag 逐条处理（误推应急也在那里）。

### 7.1 Push 完必输出 Actions run URL（给用户点击）

**强制规则**：`git push origin v0.x.y` 成功后**立刻**拿本次 run-id，把完整 GitHub Actions URL
输出给用户。**不能省略也不能等用户问**——发版 summary 里必须含这一行。

```bash
RUN_ID=$(gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 1 \
  --json databaseId --jq '.[0].databaseId')
echo "Release run: https://github.com/OpenLoaf/OpenSpeech/actions/runs/$RUN_ID"
```

完整 URL 原样贴进最终 summary（不要改成相对路径、不要省略 `https://`），保证能 cmd-click 跳转。

### 7.2 监控（可选深度操作）

`gh run watch --repo OpenLoaf/OpenSpeech <run-id>`（参考耗时 ~12-13 分钟）；失败看 `--log-failed`。
CI `fail-fast: true`：任一 platform 失败就取消其他。重跑与常用 gh 命令见 `references/troubleshooting.md`。

---

## 八、Step 5：Publish draft Release

CI 成功后只创建 **draft**，**不会自动让用户看到**。必须 publish：

```bash
gh release view v0.x.y --repo OpenLoaf/OpenSpeech --json isDraft,assets   # draft 是否就绪
gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --draft=false           # publish（或网页点 Publish）
```

Publish 后**立刻验证**：`/latest/download/` 重定向到本次 tag、`latest.json` 6 个 platform key 齐全、
R2 与 CDN 两个 host 都 200 且 ETag 一致；再找旧版客户端确认能收到更新（dev 模式跳过启动检查）。
命令见 `references/stable-details.md`「Publish 后验证」。

---

## 九、Common Mistakes（高频）

| 错误 | 正确做法 |
|---|---|
| **直接发后端没先发前端到 npm** | 按 §三「双仓顺序」，发后端前必须跑三方对齐检查 |
| 主仓 `git add src/...` 报 ignored | `src/` 是独立私仓（被主仓 `.gitignore`），src 改动**只能在 `cd src/` 下提交**，远程是 `OpenLoaf/OpenSpeech-Frontend` |
| npm publish 报 401/403/404 当成 npmjs 故障 | 99% 是 token 问题，参见 `references/frontend-npm.md` §五 |
| 普通 npm token publish 被卡 OTP | npm 平台**强制 scoped package publish 走 2FA**，长期解：用 **Granular Access Token + 勾上 "Bypass two-factor authentication (2FA)"** |
| `npm version` 替代 `pnpm version` | npm 不触发 `scripts.version` 的 pnpm lifecycle |
| `git push --tags` | **只推本次 tag**；孤儿 tag 会触发多余 CI 并抢 manifest 指针，先按 `references/troubleshooting.md`「孤儿 tag」清理 |
| CI 跑完忘了 publish draft | `/latest/download/` 不解析 draft，用户拿不到更新 |
| 删 tag 重打来重跑 CI | 用 `gh run rerun`；删 tag 会破坏 Release 历史 |
| publish 前没验证 `latest.json` 的 6 个 platform key | 漏一个就有平台用户拿不到更新；publish 后立刻 `curl + jq` 验 |
| dev 模式测 updater | dev 跳过 `check()`，必须 release 包测；或托盘手动触发 |

Beta / 跳 beta / R2·CDN 专属的 Common Mistakes 在对应分册末尾。

---

## 十、分册与维护

分册路由见 §二；stable 流程的模板 / 命令展开在 `references/stable-details.md`，链路图 / SSoT 大表 / Secrets 在 `references/architecture.md`。

> **维护要求**：`release.yml` / `tauri.conf.json` updater 段 / `update_channel.rs` /
> `sync-version.mjs` / `docs/changelogs/` 路径约定 / R2 / 腾讯云 CDN 链路 /
> `src/` 私仓与 `@openloaf/openspeech-frontend` npm 包之间的发版顺序有变更时，
> 必须同步本 SKILL.md 与对应 `references/*.md`。
