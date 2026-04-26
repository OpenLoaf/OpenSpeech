## v0.2.9

### 新增

- 新增打开设置的快捷键：macOS `⌘,`、Windows / Linux `Ctrl+,`。

### 修复

- 修复「关于」页版本号永远显示 `v0.1.0` 的硬编码 bug，现在动态读取真实版本号。
- 修复「关于」页源代码链接指向不存在的仓库（`openspeech/openspeech`），改为 `OpenLoaf/OpenSpeech`。

### 内部

- 升级 release CI 引用的 4 个 GitHub Actions 到支持 Node 24 的新版本，避免 2026-09 后 runner 移除 Node 20 时发版流程跑挂。
