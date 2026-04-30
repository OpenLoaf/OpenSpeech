## v0.2.26-beta.4

### 改进

- **更新链路再优化**：GitHub Release 上的 `latest.json` / `latest-beta.json` 也改为 COS url 版。这意味着即使是**老版本（< 0.2.26）的客户端**——它们的 endpoint 写死指向 GitHub——拉到 manifest 后下载安装包也直接走 COS 加速，无需先升级到新 endpoint 才生效。
- 自动更新增加日志：托盘检查更新时，日志里会打出选中的 endpoint、当前平台对应的 manifest install URL，便于"到底走的哪条线"排查。

### 测试重点

- 用 v0.2.25（老版本）「检查更新」走升级，**这次安装包下载应明显加速**（之前从 GitHub 拉 ~10MB/分钟，COS 加速后应快很多）。
- `~/Library/Logs/com.openspeech.app/OpenSpeech.log` 里搜 `openspeech::updater`，应该能看到 endpoints 数组与 install_url 字段。

### 已知

- 取舍：GitHub 上的 manifest 也指 COS 之后，**COS 全挂时没有自动 fallback**。如果发生，可以手工 `gh release upload --clobber` 一份 GitHub-url 版 manifest 顶替到 channel-beta / latest 应急。
