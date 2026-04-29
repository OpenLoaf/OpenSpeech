# 腾讯云 Provider 文档调研索引

> 抓取日期：2026-04-28
> 范围：仅 `cloud.tencent.com` / `tencent.com` 官方域名
> 用途：为 OpenSpeech 多 Provider Adapter 系统的腾讯云适配器提供事实依据

---

## 文档清单

| # | 文档 | 覆盖产品 | 主要官方源 |
|---|------|---------|-----------|
| 1 | [`asr-realtime.md`](./asr-realtime.md) | 实时语音识别（WebSocket） | https://cloud.tencent.com/document/product/1093/48982 |
| 2 | [`asr-sentence.md`](./asr-sentence.md) | 一句话识别 SentenceRecognition | https://cloud.tencent.com/document/product/1093/35646 |
| 3 | [`asr-recording.md`](./asr-recording.md) | 录音文件识别 CreateRecTask + 极速版 FlashRecognize | https://cloud.tencent.com/document/product/1093/37823 |
| 4 | [`translation.md`](./translation.md) | 机器翻译 TextTranslate / LanguageDetect | https://cloud.tencent.com/document/product/551/15619 |
| 5 | [`auth-and-billing.md`](./auth-and-billing.md) | 通用鉴权 (TC3-HMAC-SHA256 + WebSocket HMAC-SHA1) + 计费 | https://cloud.tencent.com/document/api/1093/35640 |
| 6 | [`capability-summary.md`](./capability-summary.md) | OpenSpeech capability 模型逐项映射 | （汇总） |

---

## 主要官方文档入口（深链）

### ASR
- 产品总览：https://cloud.tencent.com/product/asr
- API 概览：https://cloud.tencent.com/document/product/1093/35637
- 产品功能矩阵：https://cloud.tencent.com/document/product/1093/35682
- 计费概述（在线版）：https://cloud.tencent.com/document/product/1093/35686
- 公共参数：https://cloud.tencent.com/document/api/1093/35640
- 公共错误码（汇总）：https://cloud.tencent.com/document/api/1093/35647

### ASR 各接口
- 实时语音识别（WebSocket）：https://cloud.tencent.com/document/product/1093/48982
- 一句话识别 `SentenceRecognition`：https://cloud.tencent.com/document/product/1093/35646
- 录音文件识别 `CreateRecTask`：https://cloud.tencent.com/document/product/1093/37823
- 录音文件识别结果查询 `DescribeTaskStatus`：https://cloud.tencent.com/document/product/1093/37822
- 录音识别回调说明：https://cloud.tencent.com/document/product/1093/52632
- 录音文件识别极速版 `FlashRecognize`：https://cloud.tencent.com/document/product/1093/52097
- 语音流异步识别 `CreateAsyncRecognitionTask`：https://cloud.tencent.com/document/product/1093/52061
- 数据结构（SentenceDetail 等）：https://cloud.tencent.com/document/api/1093/37824
- 热词表配置方法：https://cloud.tencent.com/document/product/1093/40996

### 机器翻译（TMT）
- 产品总览：https://cloud.tencent.com/product/tmt
- 简介：https://cloud.tencent.com/document/product/551/15611
- API 概览：https://cloud.tencent.com/document/product/551/15612
- 文本翻译 `TextTranslate`：https://cloud.tencent.com/document/product/551/15619
- 语种识别 `LanguageDetect`：https://cloud.tencent.com/document/product/551/15620
- 语音翻译 `SpeechTranslate`：https://cloud.tencent.com/document/product/551/16611
- 端到端图片翻译 `ImageTranslateLLM`：https://cloud.tencent.com/document/product/551/118482
- 文件翻译请求：https://cloud.tencent.com/document/product/551/73920
- 计费概述：https://cloud.tencent.com/document/product/551/35017

### 鉴权
- 签名方法 v3 (TC3-HMAC-SHA256)：https://cloud.tencent.com/document/api/1093/35641
- 签名方法 v1（仅遗留）：https://cloud.tencent.com/document/api/1093/35642
- API 密钥管理控制台：https://console.cloud.tencent.com/cam/capi

---

## 抓取覆盖统计

| 产品/主题 | 抓取页数 | 覆盖完整度 | 备注 |
|----------|---------|-----------|------|
| 实时语音识别 (WebSocket) | 1 + VAD/热词补充 3 | 高 | 唯一遗憾：单连接最长时长官方未明确写 |
| 一句话识别 | 1 | 高 | 计费在独立页 |
| 录音文件识别 | 4 (主接口/查询/回调/数据结构) | 高 | 角色分离能力官方有完整描述 |
| 录音文件极速版 | 1 | 中 | 错误码列表官方语焉不详 |
| 机器翻译 | 4 (Text/Lang/Speech/Batch/计费) | 中 | LanguageDetect 页 SPA SSR 渲染异常，靠搜索片段确认；TextTranslateBatch 在概览页已被移除 |
| 鉴权 | 公共参数 + 签名 v3 | 高 | |
| 计费 | 在线版计费 + TMT 计费 | 高 | "增值类"功能（情绪/角色分离）单独计费但具体单价官方未列出 |

---

## 官方文档语焉不详 / 待补的项目

后续接 SDK 时如果踩坑要查这些：

1. **实时语音识别单连接最长时长**：官方仅说 `max_speak_time` 单句最长 90s + 客户端 15s 不发音频会断；连接整体时长上限官方文档未明示。
2. **TextTranslateBatch（批量文本翻译）**：API 概览页只列了 `TextTranslate` + `ImageTranslateLLM` 两个接口，老版本曾出现的 `TextTranslateBatch` 在 2026-04 版本概览中已不存在。如需批量需多次串行调用 `TextTranslate`。
3. **角色分离 / 增值功能的单独定价**：在线计费页指出"增值类需购买资源包后开启 + 单独计费"，但具体角色分离每小时多少元、情绪识别每千次多少元，官方在线计费页未列出，需购买页 https://buy.cloud.tencent.com/asr 才能看到 SKU。
4. **方言、医疗、法庭等垂直引擎是否加价**：在线计费页未明确说明。
5. **LanguageDetect 的字符上限和支持语种枚举**：页面 SPA SSR 异常，搜索片段只确认了 Action/Host/Version/请求字段，详细取值需控制台或 API Explorer 验证。
6. **ASR Region 支持**：公共参数页只列了 `ap-guangzhou` 一个；多 region 支持情况官方 ASR 文档未提及（官网控制台只在国际站和国内站之间切，没有按 region 分接入点）。
