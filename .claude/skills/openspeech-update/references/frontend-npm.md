# 前端 npm 包发布（必读，否则发的版本会"空版本"）

> **这一节是这次发版踩了大坑后补的——0.2.39 版本发出去的 desktop bundle 里跑的是 0.2.38 前端，changelog 里承诺的修复全没生效**。
> 后端发版前，前端 npm 包必须先到 npm registry，否则 CI 在 `pnpm install --frozen-lockfile` 时会拿到老 frontend 包，构出来的 desktop 就是个**空版本**。

---

## 一、架构关系

OpenSpeech 桌面端实际由两部分组成，分属**两个 git 仓**：

| 部分 | 路径 | git 仓 | 角色 |
|---|---|---|---|
| 后端 / 打包配置 | 主仓根（`src-tauri/`、`package.json`、`docs/`） | `OpenLoaf/OpenSpeech`（GitHub 公开） | Tauri 配置、Release CI、changelog |
| 前端代码 | `src/`（被主仓 `.gitignore` 忽略） | `OpenLoaf/OpenSpeech-Frontend`（GitHub 私有） | React 代码、UI、`@openloaf/openspeech-frontend` npm 包源 |

**关键事实**：

- 主仓 `package.json.devDependencies."@openloaf/openspeech-frontend"` 锁定的是一个 **npm 版本号**，不是本地 `src/` 路径
- CI 跑构建时拉的是 **npm registry 上的 frontend 包**（通过 lockfile 锁定），不会读 `src/` 目录
- 因此 **`src/` 改了不发 npm，后端发版构建出来的 bundle 还是用老 frontend**

---

## 二、铁律：发版顺序

```
① 在 src/ 改前端代码
   ↓
② src/package.json bump（手改或 npm version）
   ↓
③ 在 src/ 跑 pnpm publish → npm registry 出现 @openloaf/openspeech-frontend@N+1
   ↓
④ 主仓 package.json 把 devDependencies."@openloaf/openspeech-frontend" 改成 N+1
   ↓
⑤ 主仓 pnpm install → pnpm-lock.yaml 同步锁到 N+1
   ↓
⑥ 主仓 git commit（含 package.json + pnpm-lock.yaml + 本轮所有 src-tauri 改动）
   ↓
⑦ 主仓 pnpm version patch → 自动 bump + tag
   ↓
⑧ git push origin main + git push origin v0.x.y → CI
   ↓
⑨ CI 跑 pnpm install --frozen-lockfile，拿到正确的 frontend N+1 → 打包 → 上传
   ↓
⑩ publish draft Release
```

**顺序搞反的后果**：用户更新到 v0.x.y 后看到的还是老前端，所有 changelog 承诺都没生效。
**补救只能 bump 到 0.x.y+1 重发**（参见末尾「补救方案」）。

---

## 三、首次配置（一次性，配好以后免输 OTP）

### 3.1 npm token

OpenSpeech 在用 `org-hex` 账号下的 `@openloaf` org（npmjs.com）。

- npm 平台对 scoped package（`@openloaf/...`）**强制要求 publish 时通过 2FA**
- 即使账号关闭 2FA、org 没开 enforcement，**这一层平台策略也绕不掉**
- 自动化场景的唯一解：**用 Granular Access Token 并勾上 "Bypass two-factor authentication (2FA)" Security setting**

生成步骤（npm 账号 owner 操作）：

1. 账号必须先**启用 2FA**（npm 要求生成 bypass token 的前提）：https://www.npmjs.com/settings/<账号>/profile → Enable 2FA
2. https://www.npmjs.com/settings/<账号>/tokens → Generate New Token → **Granular Access Token**
   - Name: `openspeech-frontend-publish`
   - Expiration: 1 年（或更长）
   - Packages and scopes: `@openloaf` scope 整个 → **Read and write**
   - **Security settings 区域勾选 "Bypass two-factor authentication (2FA)"**
3. 复制 token

### 3.2 ~/.npmrc

```ini
registry=https://registry.npmmirror.com/
//registry.npmjs.org/:_authToken=npm_<你的 bypass-2FA token>
```

第一行：默认走淘宝镜像（国内下载快）。
第二行：**专门给 npmjs.org 配 token**（项目 `.npmrc` 里 `@openloaf:registry=https://registry.npmjs.org/` 强制 `@openloaf` 走官方源，这个 token 就用在这里）。

验证：

```bash
npm whoami --registry https://registry.npmjs.org
# 期望输出: org-hex（或你的账号）
# 401 / Unauthorized → token 失效，回 3.1 重生成
```

### 3.3 Claude Code 白名单

`.claude/settings.local.json` 加：

```json
{
  "permissions": {
    "allow": ["Bash(npm *)"]
  }
}
```

否则 Claude Code 跑 `npm publish` 会被 auto mode 当成「向公开 npm 发布」hard block。加了白名单后 `Bash(npm publish)` 直接放行。

---

## 四、标准 publish 流程（src/ 私仓内）

```bash
cd src/

# ① 看 src/ 私仓状态
git status
git log --oneline -3

# ② bump src/package.json 版本（必须和主仓即将发的版本号一致）
#   假设主仓即将发 0.2.40
node -e "const p=require('./package.json');p.version='0.2.40';require('fs').writeFileSync('./package.json',JSON.stringify(p,null,2)+'\n')"
# 或：手动编辑 src/package.json 把 "version" 改成 0.2.40

# ③ 提交 src 私仓累计改动
git add -u
git add <new-files>
git commit -m "chore(release): 0.2.40 — <简要说明>"
git push origin main

# ④ Publish 到 npm
pnpm publish --no-git-checks
# 看到 + @openloaf/openspeech-frontend@0.2.40 = 成功

# ⑤ 立即用独立请求验证 npm registry 真的有了
npm view @openloaf/openspeech-frontend@0.2.40 --registry https://registry.npmjs.org
# 没报错就 OK
```

> **`prepublishOnly` 钩子会自动跑 `pnpm install --frozen-lockfile && pnpm build`**，dist 会被刷新到最新代码。**不要手动跑 build 然后用脏 dist publish**。

---

## 五、Publish 错误诊断速查

| 错误 | 含义 | 处理 |
|---|---|---|
| `401 Unauthorized - GET /-/whoami` | token 失效 / 过期 / 被吊销 | 重生成 bypass-2FA token（§3.1），更新 ~/.npmrc |
| `404 Not Found - PUT /@openloaf%2f...` | token 没有 `@openloaf` scope 的写权限，或 token 失效 | 同上 |
| `403 Forbidden ... Two-factor authentication ... is required` | 用了普通 token，没勾 bypass 2FA | 重生成时**勾上 "Bypass two-factor authentication (2FA)"** |
| `EOTP ... requires a one-time password` | token 没勾 bypass 2FA，npm 要求当场输入 OTP | 同上；若要立刻发版可 `pnpm publish --otp=<6 位>` 临时绕过 |
| `npm error EPUBLISHCONFLICT` / `cannot publish over the previously published versions` | 这个版本号已经发过了 | 改 `src/package.json` bump 一档再试 |
| Claude Code 报「Create Public Surface hard block」 | `.claude/settings.local.json` 没加 `Bash(npm *)` 白名单 | 加上（§3.3） |
| `npm ERR! 404` 在 `pnpm install` 时（主仓） | 主仓 package.json 引用了 npm 上还不存在的 frontend 版本 | 顺序搞反了，**先回到 src/ 跑 publish**，再回主仓 `pnpm install` |

---

## 六、Pre-flight：版本一致性检查（发后端前必跑）

每次发后端版本之前，必须确认前端已经在 npm 上：

```bash
# 主仓里跑
NPM_VER=$(node -p "require('./package.json').devDependencies['@openloaf/openspeech-frontend']")
LOCK_VER=$(grep -A 1 "'@openloaf/openspeech-frontend':" pnpm-lock.yaml | grep specifier | head -1 | awk '{print $NF}')
REMOTE_VER=$(npm view @openloaf/openspeech-frontend version --registry https://registry.npmjs.org 2>/dev/null)

echo "主仓 package.json 引用: $NPM_VER"
echo "pnpm-lock.yaml 锁定:    $LOCK_VER"
echo "npm registry 最新:      $REMOTE_VER"

# 三者应该相等。其中任何一个不匹配都不能发后端。
[ "$NPM_VER" = "$LOCK_VER" ] && [ "$LOCK_VER" = "$REMOTE_VER" ] \
  && echo "✅ 一致，可以发后端" \
  || echo "❌ 不一致，先把前端发版顺序补齐"
```

`prepublishOnly` 拉 `--frozen-lockfile` 时如果 lockfile 锁的版本和 package.json 引用的不一致会直接 fail，但 lockfile 锁的版本与 **npm registry 最新版本** 不一致 CI 不会主动报错——会成功构建出**带老前端的 desktop bundle**，这就是 0.2.39 那个坑。**所以必须三方对齐**。

---

## 七、补救方案：发现刚发的版本里前端是老的

**症状**：用户升级到 v0.x.y 后看到的还是旧 UI / 旧 bug，本版 changelog 列的修复一个都没生效。

**根因**：构建时 lockfile 锁的 `@openloaf/openspeech-frontend` 不是最新版本。

**补救流程（推荐 bump 重发，不要撤回）**：

1. 先去 npm 把正确的 frontend 版本发出去（参见 §四）
2. 主仓改 `package.json.devDependencies."@openloaf/openspeech-frontend"` 到正确版本
3. 主仓 `pnpm install`
4. 写 `docs/changelogs/0.x.y+1/zh.md`，开头**明确说明**「上一版 0.x.y 是个空版本，本版本才真正生效」
5. `pnpm version patch` → 0.x.y+1
6. `git push origin main && git push origin v0.x.y+1` → CI 重新构建
7. publish draft

**为什么不撤回**：用户拿到 0.x.y（含老前端）的客户端 updater 会判定「已是最新」不再更新；只有当 GitHub Release / R2 `latest.json` 指向更高版本号时，他们才会被推到正确版本。

---

## 八、未来自动化方向（TODO，不强制现在做）

人工跑「前端 publish → 主仓 bump → CI 构建」三步现在主要痛点：

- 每次 publish 都得本地跑命令，依赖本地 ~/.npmrc 配的 token
- 容易忘了 bump 主仓 / 没跑 `pnpm install` / 顺序搞反

可优化方向：

- 在 `OpenSpeech-Frontend` 私仓加 `.github/workflows/publish.yml`：监听 `main` push 或 tag push 时自动 `pnpm publish`，token 走 GitHub Secrets
- 在主仓 `release.yml` 第一步加 version 一致性预检（§六的检查脚本），不一致直接 fail-fast 不进入打包阶段
- 写一个 `scripts/bump-with-frontend.sh` 把「bump frontend → 等 npm 出现 → bump root 依赖 → install → 后端 bump」串成一条命令

未做之前**严格按 §二 的顺序手动跑**，不要凭印象跳步。
