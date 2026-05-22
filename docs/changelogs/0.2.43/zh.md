## v0.2.43

### 修复

- **macOS 26.2 上 OpenSpeech 启动几秒后闪退**：26.2 给输入法管理 API 加了严格
  的「只许主线程调用」断言，0.2.42 的输入法切换日志监听跑在后台线程里，第二
  次轮询就触发断言、整个 app 被 macOS 直接干掉。本版把所有跟输入法相关的系统
  调用都改成「派发到主线程同步执行，原线程等结果」，对应的还包括 0.2.41 引入
  的注音 / 仓颉 / RIME / 搜狗 / 百度 IME 粘贴修复——那段代码也会调到同一组
  API，理论上在 macOS 26.2 也会偶发踩雷，本版顺手一起根治。
  - 26.2 之前的 macOS 表现不变。
  - 输入法切换日志保留：每次切换在 OpenSpeech.log 写一行 `[ime] switched`，
    便于后续排查「这个输入法下粘贴怎么了」。

### 内部

- 把 `onlyBuiltDependencies` 加上 `esbuild`，避免新装环境 `pnpm install` 把
  esbuild 的 native binary postinstall 跳过、本地 dev 启动后 vite 立刻
  `write EPIPE` 崩。
