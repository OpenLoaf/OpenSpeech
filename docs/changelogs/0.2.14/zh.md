## v0.2.14

### 改进

- macOS 默认听写快捷键调整为 `Fn + Control`（之前是单 `Fn`）。Intel Mac 与外接 USB 键盘上单 `Fn` 经常拿不到键盘事件；组合键避开这类硬件兼容坑。已经自定义过快捷键的老用户绑定保持不变。
- 应用日志覆盖大幅扩展。之前录制失败、麦克风打不开、快捷键注册失败等场景在日志文件里看不到任何线索（写在 stderr）；现在全部落到 `~/Library/Logs/com.openspeech.app/OpenSpeech.log`，方便自助排查或反馈给我们时一并贴上。

### 内部

- 升级 release CI 中 `softprops/action-gh-release` 到 v3（Node 24），避开 GitHub 计划 2026-09 后移除 Node 20 时发版流程跑挂。
