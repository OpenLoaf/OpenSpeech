# 发版异常场景

> 用户说「重发」「补 build」「重跑 CI」「撤回」「下架」「改 release 正文」「热修」时读这份文档。

---

## 重跑 CI（同一 tag）

GitHub tag 推上去之后只触发一次 workflow。需要重跑：

```bash
# 找到失败的 run
gh run list --repo OpenLoaf/OpenSpeech --workflow release.yml --limit 5

# 重跑（仅失败 jobs）
gh run rerun <run-id> --failed --repo OpenLoaf/OpenSpeech

# 或重跑全部
gh run rerun <run-id> --repo OpenLoaf/OpenSpeech
```

**不要为了重跑而删 tag 再重打**——会给已经下载过 latest.json 的客户端造成混乱，
且 GitHub Release 历史会断。

---

## 撤回已 publish 的 Release

下架后立刻：

```bash
# 转回 draft（最常用）
gh release edit v0.x.y --repo OpenLoaf/OpenSpeech --draft=true

# 或彻底删除
gh release delete v0.x.y --repo OpenLoaf/OpenSpeech --yes

# tag 也一起删（可选，慎用）
git push origin :refs/tags/v0.x.y
git tag -d v0.x.y
```

撤回会让 `/latest/download/` 立刻回退到上一个 published Release。
**已经下载完替换包的客户端不会回滚**——他们已经是新版本了。

---

## 修 changelog 但不 bump 版本

只想改 GitHub Release 正文：

```bash
# 改 docs/changelogs/{ver}/zh.md
gh release edit v0.x.y --repo OpenLoaf/OpenSpeech \
  --notes-file docs/changelogs/{ver}/zh.md
```

不需要重跑 CI。

---

## 临时 hotfix 跳过 CI 矩阵的某个平台

不支持。CI `fail-fast: true` 是有意为之，避免半成品 draft。
要改架构去 `release.yml`。

---

## Tauri 2 updater 产物格式（影响 release.yml 与 latest.json 验证）

| 平台 | 产物格式 |
|---|---|
| macOS | `.app.tar.gz` + `.sig`（仍是 tarball） |
| Linux | 直接对裸 `.AppImage` 签 `.sig`，**不再产 `.AppImage.tar.gz`** |
| Windows | 直接对 `-setup.exe` 签 `.sig`，**不再产 `-setup.nsis.zip`** |

如果哪天升级 Tauri 后产物格式变化，`.github/workflows/release.yml` 的 stage / latest.json case 必须同步改。

---

## Pre-flight 异常情形

看到下列任何一项，先停下问用户，不要自动 bump / push：

| 异常 | 处理 |
|---|---|
| 当前不在 `main` 分支 | 切回 main，或确认用户故意要在分支上发版 |
| 远程不是 `OpenLoaf/OpenSpeech` | 拒绝执行，可能在 fork 上 |
| 工作区有 `.tmp/` / `test.md` / `.env` / `*.p12` / `*.key` 等不应提交文件未在 `.gitignore` 里 | 先补 `.gitignore`，再 commit |
| `package.json.version` 与 `src-tauri/Cargo.toml [package].version` 不一致 | 跑 `node scripts/sync-version.mjs`，再 commit |
| 上一个 tag 还没被 publish | `gh release view v{prev} --json isDraft` → `true` 时先把上个 draft 处理掉 |
