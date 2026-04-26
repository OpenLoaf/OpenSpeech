## v0.2.7

> ⚠️ **本次升级所有用户会被强制重新登录一次。** 这是为了把登录凭据迁移到新的跨应用 SSO 通道，**首次启动后请重新登录一次**，之后就再也不会被踢。

### 修复

- **修复登录态被静默清空的严重 bug**：之前重启应用后会变成「未登录」，原因是凭据没真的写进系统钥匙串、只存在内存里。修复后登录状态可在重启间持久保留。
- **修复 0.2.5 / 0.2.6 自动更新无包的问题**：这两版的 CI 在 Linux / Windows 平台编译失败，没产出更新包，所以所有客户端都没收到推送。0.2.7 已修复，后续版本恢复正常 OTA。
- 修复登录失败时弹窗只显示一段刺眼英文错误、用户不知该做什么的体验：错误文案改成友好中文、加「重试」按钮，原始错误折叠到「查看详情」便于排查。

### 新增

- **跨 OpenLoaf 桌面应用 SSO**：与 OpenLoaf 桌面族其他应用（OpenLoaf 本体等）共享登录态 —— 只要在任一应用登过一次，OpenSpeech 启动时自动恢复登录，无需再走一次 OAuth。

### 改进

- 启动 / 401 时的登录恢复改用官方 SDK `auth.bootstrap` 的标准路径；优先 family token（不轮换、多端并发安全），失败再回退 refresh token。
- 登出时优先调用 `family_revoke` 实现机器级登出（一次操作清掉所有 OpenLoaf 应用的本机登录）。

### 已知问题

- macOS 在 dev 构建 / 未签名安装包下访问钥匙串会弹「输入登录密码」对话框 —— 这是 macOS 系统机制，不是 bug。正式签名版本首次弹一次后即可点 Always Allow 永久免提示。
- 跨应用 SSO 在两端都"零弹窗共享"需要 OpenLoaf 桌面端 / OpenSpeech 都用同一 Apple Developer ID 正式签名；当前版本在 dev 模式下首次访问共享条目会再弹一次密码框。

### 内部

- 升级 OpenLoaf SaaS Rust SDK 0.3.1 → 0.3.2，对接新的 `AuthStorage` 抽象；钥匙串命名空间迁移到 SDK 推荐的 `ai.openloaf.saas / default`；老命名空间 `com.openspeech.app / openloaf_refresh_token` 启动时自动清理。
- 启用 `keyring` crate 的 `apple-native / windows-native / sync-secret-service` 三平台原生 backend（之前未启用导致 token 实际写到 mock keystore 进程退出即丢——这就是登录态消失的根因）。
- 登录成功 / refresh 后日志输出 JWT 的 `iss / aud / sub / exp / iat`，便于服务端 401 排错时一行对照配置。
- `release.yml` 新增 macOS 签名硬校验：build 后强制要求 `Developer ID Application` 签名 + `TeamIdentifier` 存在，secrets 漏配时 CI 直接红，不再悄悄出 ad-hoc 包。
