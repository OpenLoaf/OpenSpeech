# 订阅与计费规则

OpenSpeech 的计费**全部由 OpenLoaf SaaS 后端处理**，客户端只做"拉取会员状态 / 余额 + 跳转到 OpenLoaf Web 管理页"两件事，不在 App 内实现订阅或支付流程。

---

## 两种使用模式

### 1. SaaS 云端模式（默认）

- 必须登录 OpenLoaf 账户（Google / 微信 OAuth）
- 调用 OpenLoaf SDK 的 `ai.v3_tool_execute("realtimeAsrLlm")` / `realtime` 等接口走云端推理
- 按**积分**扣费，余额不足会被服务端拒绝（`SaaSError::Http { status: 402 }`）
- 本地客户端不对扣费做任何决策，服务端扣多少是多少

### 2. BYO 自带模型模式

- 用户在"设置 → 通用 → 听写源"里切到 "BYO"
- 用户填入自己的 REST 端点 + API Key（保存在系统密钥链）
- 所有请求走用户自己的端点 → **不消耗 OpenLoaf 积分**
- 此模式下即使**未登录** OpenLoaf 也能正常工作
- 适合：自托管模型、走自己已有的 API 额度、隐私敏感场景

> 两种模式互斥但可随时切换。设置项：`settings.general.dictationSource = "SAAS" | "BYO"`（默认 SAAS）。

---

## OpenLoaf 套餐与积分关系

OpenSpeech **本身不发行套餐**。套餐是由**姊妹产品 OpenLoaf** 统一发行，购买后同一账户在 OpenSpeech 与 OpenLoaf 下所有相关产品共享权益。

| OpenLoaf 套餐 | 月价 / 年价 | 月积分 | 对 OpenSpeech 的影响 |
|---|---|---|---|
| Free | ¥0 | 0 | 只能用 BYO；SaaS 模式下每次调用都会被扣积分（起始为 0 → 不足会被拒） |
| Lite | ¥35 / ¥300 | 5,000 / 60,000（年） | SaaS 调用按积分计费，扣完即停 |
| Pro | ¥140 / ¥1,200 | 20,000 / 240,000 | SaaS 调用按积分计费，套餐积分用完后可继续充值 |
| Premium | ¥420 / ¥3,600 | 60,000 / 720,000 | SaaS 调用按积分计费，套餐积分用完后可继续充值 |

**关键规则**：

- **所有套餐均按积分计费**。客户端不再对 Pro / Premium 做"无限 / 不扣积分"的特殊展示。
- 任意等级用户均可通过"充值"直接给账户加积分（1 元 = 100 积分），不绑定套餐。
- **扣费逻辑完全在 SaaS 端判定**。前端只根据 `user.current` 返回的 `membership_level` 展示徽章。

---

## 前端可展示的状态（只读）

| 数据来源 | 含义 | UI 位置 |
|---|---|---|
| `profile.membershipLevel` | 当前套餐等级 | 顶部徽章（FREE / LITE / PRO / PREMIUM / INFINITY） |
| `profile.creditsBalance` | 当前剩余积分 | 侧栏 Time-left Rail（折算成可用分钟） |
| `realtimeAsrCreditsPerMinute` | 实时 ASR 单价（积分/分钟） | 侧栏 Time-left Rail 折算分母 |
| `profile.email` / `profile.name` / `profile.avatarUrl` | 身份展示 | 侧栏账户按钮 + AccountDialog |

### 侧栏 Time-left Rail（剩余可用时长）

侧栏不再裸露"剩余积分"数字，而是折算成"还能录多少分钟"，这是终端用户更直观的口径。

- **拉到单价**：展示 `≈ floor(creditsBalance / realtimeAsrCreditsPerMinute) 分钟`，所有套餐等级一致。
- **单价拉失败 / 还没拉回**：退化展示原始积分，避免假"0 min"误导。

`realtimeAsrCreditsPerMinute` 由 `openloaf_fetch_realtime_asr_pricing` 在登录成功 / bootstrap 恢复后拉一次，
当前调用 SDK 的 V3 capabilities 端点 `ai.tools_capabilities("realtimeAsrLlm")` 取 `credits_per_minute`。

> ⚠️ **隐性耦合，必须维护**
>
> 当前 sidebar 的"剩余分钟"假设：**V3 capabilities 的 `realtimeAsrLlm.credits_per_minute`
> 与客户端实际跑的 V4 通道 `OL-TL-RT-002`（Qwen3-ASR-Flash-Realtime, `src-tauri/src/stt/mod.rs`）
> 走相同 credits/min 单价**。
>
> **若 V4 通道改了计费规则**（换模型 / 换通道 / 改单价 / 改成按字符 / 按秒分档 /
> 任何与"按分钟单一单价"不一致的策略），必须**立即**把换算数据源换掉，否则 sidebar
> 会与服务端真实扣费偏离，误导用户：
>
> 1. **优先**：让 SDK 暴露 V4 capabilities 接口直接拉 `OL-TL-RT-002` 真单价；
> 2. **兜底**：客户端从 realtime `credits` 事件里 `consumed_credits / consumed_seconds` 反推实际单价并缓存。
>
> 修改入口在 `src-tauri/src/openloaf/mod.rs` 的 `openloaf_fetch_realtime_asr_pricing`，
> 同时同步更新 `src/stores/auth.ts` 中 `realtimeAsrCreditsPerMinute` 字段的注释与本节。

---

## 订阅 / 充值入口

客户端**不内嵌**二维码或支付流程，统一**跳转 OpenLoaf Web**，由用户在浏览器里完成：

| 入口 | 行为 |
|------|------|
| AccountDialog → "管理订阅" | 打开 `<OPENLOAF_WEB_URL>/pricing`（或 `/account/subscription`） |
| AccountDialog → "充值积分" | 打开 `<OPENLOAF_WEB_URL>/recharge` |
| 积分不足提示 | 同上，跳转到充值页 |

`OPENLOAF_WEB_URL` 是构建期常量，默认：
- `debug` → `http://localhost:5180`
- `release` → `https://openloaf.hexems.com`
- 可用环境变量 `OPENLOAF_WEB_URL=...` 覆盖

支付完成后用户回到 App，点击"刷新"或触发任意 SaaS 调用时会自动拉一次 `user.current`，UI 自然更新。

---

## 为什么不在 App 内做订阅 UI

1. **套餐由 OpenLoaf 统一管理**，在 OpenSpeech 内重复做一套 UI + 支付 state machine 会分叉、易变；
2. **支付回调、退款、升级差价、代金券**等边角情况由 SaaS Web 兜，客户端只需要最终状态；
3. **避免 App 携带支付相关合规负担**（发票、税务、地区限制）。

---

## 未来可能的调整（非本期需求）

- Cmd+K 或菜单项里加一个"查看积分 / 套餐"快捷跳转
- 账户页展示本月积分流水（需 SDK 暴露 `memberCredits.transactions`，目前 Rust SDK 0.2.6 未暴露）
