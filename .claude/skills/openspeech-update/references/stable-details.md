# stable 发版分步细节

> SKILL.md §五（changelog）、§六（bump）、§八（publish 后验证）的展开。规则在 SKILL.md，这里放模板与命令。

---

## changelog 路径与模板

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

## `pnpm version` 做了什么

`pnpm version` 自动：

1. 改 `package.json.version`
2. 触发 `package.json.scripts.version` lifecycle → `node scripts/sync-version.mjs && git add src-tauri/Cargo.toml src-tauri/Cargo.lock`
   - `sync-version.mjs` 同步 `src-tauri/Cargo.toml [package].version` **和** `Cargo.lock` 里 openspeech 自身条目
   - `tauri.conf.json` 用 `"version": "../package.json"` 自动跟随
3. 自动 `git commit -m "0.x.y"` 把这两个文件提交
4. 自动打 annotated tag `v0.x.y`

**不要手改 Cargo.toml / Cargo.lock / tauri.conf.json 的版本号；不要 `npm version`，要 `pnpm version`。**

> 若 `pnpm version` 后 `git show --stat HEAD` 里没有 `Cargo.lock`，说明 lifecycle 没跑到（或 lock 本来就已对齐）；
> 自查：`grep -A1 '^name = "openspeech"$' src-tauri/Cargo.lock` 必须显示新版本号。

---

## Publish 后验证

```bash
# 1. /latest/download/ 应重定向到本次 tag
curl -sI https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json | grep -i location

# 2. latest.json 6 个 platform key 齐全
curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/latest/download/latest.json | jq '.platforms | keys'
# 期望：["darwin-aarch64","darwin-x86_64","linux-aarch64","linux-x86_64","windows-aarch64","windows-x86_64"]

# 3. R2 海外 + 腾讯云 CDN 两个 host 都 200，且 ETag 一致 = CDN 正确回源 R2
curl -sI https://openspeech-r2.hexems.com/latest-beta.json  | grep -iE "(^HTTP|etag)"
curl -sI https://openspeech-cdn.hexems.com/latest-beta.json | grep -iE "(^HTTP|etag|x-nws)"
```

任一返回 `Not Found` / 4xx → publish 或上传没成功；CDN 出 404 + cf-ray 同时有腾讯云 header
通常是回源 HOST 没改 R2 自定义域 —— 详见 `r2-cdn.md`「R2/CDN 相关 Common Mistakes」。

R2/CDN 全套验证（含二进制缓存命中、CN 用户分流诊断）、updater 日志路径、Tauri 2 产物格式注意点见
`r2-cdn.md` 和 `troubleshooting.md`。

### 验证客户端能收到更新

找一台装着旧版本 OpenSpeech 的机器：

- 重启应用 → boot 期 `main.tsx` 跑 `checkForUpdate()`，命中后自动下载替换
- 或：托盘菜单点「检查更新」→ 看到「发现新版本 vX.Y.Z」 toast

dev 模式 `import.meta.env.DEV === true` 跳过启动检查，只能托盘手动测。
