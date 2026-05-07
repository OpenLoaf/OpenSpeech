# 跳过 beta 直接发 stable

> 用户说「直接发 stable」「跳过 beta」「不走灰度」「直接出生产版本」时读这份文档。

**核心规则**：beta 不是 stable 的强制前置阶段。任何时刻你都可以选择不走 beta、把当前累计改动直接发成正式版。

**代价**：跳过 beta = 跳过真实用户验证缓冲。出了回归直接砸到 stable 全量用户头上，没有「灰度名单先看一眼」的机会。

---

## 何时合理跳过 beta

| 场景 | 合理理由 |
|---|---|
| 文档 / i18n 文案 / 落地页 / changelog 修订 | 不影响 runtime 行为，无回归风险 |
| 纯 UI 样式（颜色 / 间距 / icon），无逻辑改动 | 视觉问题人眼能直接发现，不需要 beta 灰度 |
| 紧急修明确 bug（已经在 dev 复现、改动小、风险低） | beta 灰度的等待时间反而让线上更多用户中招 |
| 当前 working tree 改动已在内测人员真机上跑过几天 | 已经"事实上 beta 化"，再走一轮 beta 是仪式 |
| 升级版本号但代码内容跟上一个 stable 几乎一致（小依赖 bump、build 配置微调） | 没有有意义的 beta 验证目标 |

---

## 什么时候**不要**跳过 beta（即使用户说"直接发 stable"也要先确认）

| 强信号 | 为什么必须 beta |
|---|---|
| 改动涉及 `src-tauri/src/audio/` / `src-tauri/src/stt/` / `src-tauri/src/openloaf/` / inject / 全局快捷键 | OS 交互层，CI 跑不出来，必须真机灰度 |
| 升级了 `tauri-plugin-*` 或 `openloaf-saas` SDK 大版本 | 新 SDK 的 runtime 行为只能在用户机器上观察 |
| 改了 `tauri.conf.json` 的 bundle / updater / capabilities | 影响打包 / 升级 / 权限，错了的话会全量"装不上"或"装上不能更新" |
| 跨平台兼容性改动（macOS Hardened Runtime / Windows NSIS / Linux AppImage） | 三平台行为差异大，必须每个平台都过用户手 |
| 核心录音 / FSM 状态机重构 | 用户真实使用模式比 dev 写测试覆盖得广 |
| 引入新的全局监听 / 后台线程 / 状态栏菜单项 | 资源泄漏 / 占用类问题只有长时间真实使用才暴露 |

碰到这些强信号还想直接发 stable 时，**主动告诉用户风险、列出可能的 fallout，再让他二次确认**。
不要因为用户嘴上说「直接发」就跳过这一步。

---

## 命令模板

按当前所在的版本起点决定 `pnpm version` 的参数。

### 情况 A：当前已在 stable（例如 `0.2.18`）

```bash
pnpm version patch    # 0.2.18 → 0.2.19
pnpm version minor    # 0.2.18 → 0.3.0
pnpm version major    # 0.2.18 → 1.0.0
```

### 情况 B：当前在 beta（例如 `0.2.26-beta.6`），想发同周期 stable（`0.2.26`）

```bash
pnpm version patch    # 0.2.26-beta.6 → 0.2.26（脱掉 -beta 后缀）
```

### 情况 C：当前在 beta，想跳过同周期 stable、直接发下一个 patch（`0.2.27`）

不能一步到位。`pnpm version patch` 在 `-beta.N` 上只会脱后缀，不会再 +1。

```bash
# 方案 1：用 minor 一次性进位
pnpm version minor    # 0.2.26-beta.6 → 0.3.0   ← 注意进的是 minor，不是 patch

# 方案 2：分两步
pnpm version patch    # 0.2.26-beta.6 → 0.2.26
# (不发 0.2.26，直接继续 bump)
pnpm version patch    # 0.2.26       → 0.2.27
```

### 情况 D：当前在 beta，想发下一个 minor（`0.3.0`）

```bash
pnpm version minor    # 0.2.26-beta.6 → 0.3.0
```

### 情况 E：当前在 beta，想发 major（`1.0.0`）

```bash
pnpm version major    # 0.2.26-beta.6 → 1.0.0
```

---

## Changelog（必须新建一份）

正式版的 release notes **不能复用任何 beta 的 changelog**：

- beta 文档是给灰度用户看「本轮想验什么」
- stable 文档是给所有用户看「这一版相对上一个 stable 改了什么」

```bash
mkdir -p docs/changelogs/0.x.y
$EDITOR docs/changelogs/0.x.y/zh.md
```

如果是从 beta（如 `0.2.26-beta.6`）转正到同周期 stable（`0.2.26`）：把 beta.0 ~ beta.N 的 changelog
合并去重写一份 `0.2.26/zh.md`，**面向最终用户**而非内测人员。

---

## Publish 后的影响面

- `latest.json`（COS + GitHub `/latest/download/`）刷成本次 stable 版本 → stable 通道用户全量收到
- `latest-beta.json`（COS + GitHub `channel-beta`）也会被刷成同一 stable 版本（CI 在 stable release 上同时 clobber 两份 manifest）→ beta 通道用户也收到这个 stable
- 已经下载完替换包的客户端不会回滚——他们已经是新版本了

---

## 跟「Beta 转正」的区别

| 维度 | beta 转正（见 `beta.md`） | 直接发 stable（本文档） |
|---|---|---|
| 前置 | 至少有一个 beta release 已 publish | 不需要 |
| 路径 | beta.0 → ... → beta.N → stable | working tree → stable |
| 真实用户验证 | 有（beta 通道用户用过 beta.N 天） | 无 |
| changelog | 转正时新建一份综合 beta 反馈 | 新建一份基于 commit 历史 |
| 命令 | `pnpm version patch` 脱后缀 | 同左（情况 B），或 `minor / major`（情况 C/D/E） |
