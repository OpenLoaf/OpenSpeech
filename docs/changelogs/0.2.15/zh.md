## v0.2.15

### 改进

- 自动更新改为非阻塞。之前发现新版后会在启动阶段下载几十 MB 安装包，期间 LoadingScreen 一直转着，看起来像「卡死」；现在启动只检测，发现新版会在主界面右下角弹一条 toast，点「立即安装」再下载替换并重启，下载与启动彻底解耦。
- DMG 安装界面美化：窗口尺寸更紧凑，背景换成自定义品牌引导图（金色箭头从 OpenSpeech.app 指向 Applications），第一次打开就能直观看出怎么装。
- 引导页 (Onboarding) 顶部显示当前版本号，方便排查问题或反馈时直接核对。
- 登录弹窗与引导登录页新增 OpenLoaf 产品族说明：OpenSpeech 是 OpenLoaf 旗下产品，一个账号、点数在 OpenLoaf 全产品通用。

### 修复

- macOS 权限相关日志增强：`IOHIDRequestAccess` 调用前后会同时打印 `IOHIDCheckAccess` 状态，权限检查接口 (`permission_check_microphone / accessibility / input_monitoring`) 全部走 plugin-log。当出现「设置里显示已授权但应用仍提示需要授权」时（自动更新后 TCC csreq 不匹配的常见场景），可以从日志一眼看清是注册失败、缓存未刷新还是真的没有权限。
