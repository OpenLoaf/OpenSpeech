# Beta 通道发版

> 用户说「发个 beta」「灰度」「内测」，或当前已经在 beta 周期里继续迭代时读这份文档。
> 想从 beta 转回 stable 看本文末尾「Beta 转正」一节；想完全跳过 beta 看 `skip-beta.md`。

OpenSpeech 在「设置 → 关于 → 更新通道」给用户两个选项：`Stable` / `Beta`。
Beta 通道入口是 `releases/download/channel-beta/latest-beta.json`（一个滚动指针 release）。

---

## 关键约定

| 项 | 规则 |
|---|---|
| 版本号 | `0.x.y-beta.N`（SemVer 预发布段，N 从 0 起） |
| Tag | `v0.x.y-beta.N` |
| GitHub Release | 自动 `prerelease: true`（`/latest/download/` 不会指过去） |
| 入口文件 | 主 release 上传 `latest.json` + `latest-beta.json`（内容相同），CI 自动把 `latest-beta.json` `--clobber` 到固定 tag `channel-beta` 的 release |
| Stable 用户 | 不会拉到 beta（GitHub `latest` 算法跳 prerelease） |
| Beta 用户 | 拉 `channel-beta/latest-beta.json` → 永远是最新 beta-or-stable |
| 关闭 Beta 后 | SemVer 规定 `0.3.0 > 0.3.0-beta.N`，stable 高于当前 beta 时才会收到更新；stable 还停在 beta 之前则 updater 判 "已是最新"，不更新 |

---

## 命令模板

```bash
# 当前 0.2.17（stable）→ 第一个 beta
pnpm version prepatch --preid=beta   # 0.2.17 → 0.2.18-beta.0

# 后续 beta 迭代
pnpm version prerelease --preid=beta # 0.2.18-beta.0 → 0.2.18-beta.1

# 推 tag（注意 tag 名带 -beta）
git push origin main
git push origin "v$(node -p "require('./package.json').version")"
```

---

## Changelog

`docs/changelogs/{version}/zh.md` 的 `{version}` 必须包含 beta 后缀：

```
docs/changelogs/0.2.18-beta.1/zh.md
```

beta release 的 changelog 通常更短，列出本轮 beta 想验证的功能 + 已知风险即可。
**正式版本（去掉 -beta 后）需要单独写一份 changelog**，不能复用 beta 的（见末尾「Beta 转正」）。

---

## 完整流程

1. Pre-flight 检查（同主 SKILL.md §三）
2. 提交累计改动（同主 SKILL.md §四）
3. 写 changelog：
   ```bash
   mkdir -p docs/changelogs/0.x.y-beta.N
   $EDITOR docs/changelogs/0.x.y-beta.N/zh.md
   ```
4. Bump：
   - 首次进 beta：`pnpm version prepatch --preid=beta`
   - 已在 beta 里迭代：`pnpm version prerelease --preid=beta`
5. 推：
   ```bash
   git push origin main
   git push origin v0.x.y-beta.N
   ```
6. 监控 CI（同主 SKILL.md §七）
7. Publish draft —— **prerelease 标志已由 release.yml 自动打上**，不需要手动改：
   ```bash
   gh release edit v0.x.y-beta.N --repo OpenLoaf/OpenSpeech --draft=false
   ```
8. 验证 beta 入口：
   ```bash
   curl -sL https://github.com/OpenLoaf/OpenSpeech/releases/download/channel-beta/latest-beta.json \
     | jq '.version, .platforms | keys'
   ```
9. 让 beta 测试用户在 OpenSpeech 设置里切到 Beta 通道，重启或托盘「检查更新」即收到。

---

## Beta 转正

beta 测够了要转正：

```bash
# 假设当前 0.2.18-beta.3，转成 0.2.18 正式
pnpm version patch    # 0.2.18-beta.3 → 0.2.18
```

正常推 tag、走 CI、publish。stable 用户和 beta 用户都会收到这个 0.2.18
（beta 通道的 `latest-beta.json` 也会被本次 release 覆盖更新成 stable 0.2.18）。

> 也可以**反过来**——根本不走 beta，本轮改动直接发 stable，见 `skip-beta.md`。
> 「先 beta 灰度 → 转正」不是强制路径，只是更稳的路径。

---

## Beta Common Mistakes

| 错误 | 正确做法 |
|---|---|
| 用 `pnpm version patch` 发 beta | 必须 `prepatch --preid=beta` 或 `prerelease --preid=beta` |
| `--preid` 写成 `alpha / rc / dev` 等 | release.yml 只检测 `-beta`；其他后缀仍走 stable，会污染正式通道 |
| 手改 `package.json` 版本号成 `0.2.18-beta.1` | 必须用 `pnpm version prerelease`，否则 git tag 不会自动打 |
| beta release publish 后没去 `channel-beta` 看 latest-beta.json 是否更新 | CI 用 `gh release upload --clobber` 自动覆盖；publish 主 release 后手动 curl 一次确认 |
| 把 beta 的 changelog 当 stable 的 | 转正时新建 `docs/changelogs/0.2.18/zh.md`，把 beta N 轮反馈合并写一份 |
