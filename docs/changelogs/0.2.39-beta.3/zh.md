## v0.2.39-beta.3

这是一次基线对齐版本，相对 0.2.39-beta.2 **没有新功能或代码改动**——只是
把 Cargo.lock 同步补齐，作为后续修复的干净基线。

如果你已经在 0.2.39-beta.2 上，本版升不升都行，体验完全一致。

### 已知问题

- 0.2.39-beta.2 里新建的 history schema 列（title / speaker_names_json /
  credits_asr / credits_refine）UI 仍未对外开放，按计划继续在后续 beta 接入。
- 无线麦克风功能 UI 仍未开放，沿袭前几版状态，仅供内部测试。
