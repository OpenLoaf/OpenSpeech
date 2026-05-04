# OpenSpeech 业务规则文档

本目录只描述 **业务规则**：软件要做什么、不做什么、用户如何使用、各状态下的行为约束。不包含技术实现细节。

## 目录

| 文档 | 内容 |
|---|---|
| [product.md](./product.md) | 产品定位、目标用户、核心价值 |
| [features.md](./features.md) | 功能总览 |
| [voice-input-flow.md](./voice-input-flow.md) | 语音输入核心流程与状态机 |
| [hotkeys.md](./hotkeys.md) | 全局快捷键规则 |
| [history.md](./history.md) | 历史记录规则 |
| [dictionary.md](./dictionary.md) | 词典规则 |
| [settings.md](./settings.md) | 设置项定义 |
| [privacy.md](./privacy.md) | 数据与隐私规则 |
| [permissions.md](./permissions.md) | 各平台系统权限规则 |
| [onboarding.md](./onboarding.md) | 首次启动向导 + 持久横条 |
| [subscription.md](./subscription.md) | 订阅与计费规则 |
| [speech-providers.md](./speech-providers.md) | 语音引擎 Provider 抽象规划（多服务商 / 开源适配器） |
| [cloud-endpoints.md](./cloud-endpoints.md) | 云接口接入点 × 供应商能力矩阵（实现层快照）|

## 术语

- **听写（Dictation）**：按住快捷键讲话 → 转文字 → 写入当前光标所在的输入框。
- **问 AI（Ask AI）**：按住快捷键讲话 → 由大模型理解并生成回答 → 写入当前光标位置。
- **翻译（Translate）**：按住快捷键讲话 → 翻译为目标语言 → 写入当前光标位置。
- **当前应用（Active App）**：触发快捷键时系统焦点所在的应用与输入框。
- **大模型（LLM/STT Provider）**：用户配置的远程 REST 服务，OpenSpeech 本身不包含模型。
