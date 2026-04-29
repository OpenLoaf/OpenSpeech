# 腾讯云 机器翻译（TMT / 翻译君）

> 来源：
> - 简介：https://cloud.tencent.com/document/product/551/15611
> - API 概览：https://cloud.tencent.com/document/product/551/15612
> - 文本翻译 TextTranslate：https://cloud.tencent.com/document/product/551/15619
> - 语种识别 LanguageDetect：https://cloud.tencent.com/document/product/551/15620
> - 语音翻译 SpeechTranslate：https://cloud.tencent.com/document/product/551/16611
> - 计费：https://cloud.tencent.com/document/product/551/35017
>
> 抓取日期：2026-04-28

---

## 0. 产品族总览

按 2026-04-28 时点的 API 概览页（551/15612），TMT 公开列出的接口只有 **2 个**：

| Action | 用途 | 限频 | 文档 |
|--------|------|------|------|
| `TextTranslate` | 文本翻译 | 5 次/秒 | /document/api/551/15619 |
| `ImageTranslateLLM` | 端到端图片翻译 | 1 次/秒 | /document/api/551/118482 |

> ⚠️ 旧版本曾出现的 `TextTranslateBatch`（文本批量翻译）在 2026-04 概览页**已不再列出**；老版 `ImageTranslate`（551/17232）和 `SpeechTranslate`（551/16611）也仍有独立文档页但未在最新概览页强推。如需批量翻译需自己串行调 `TextTranslate`。

---

## 1. TextTranslate — 文本翻译

### 1.1 基本

| 项 | 值 |
|----|----|
| Endpoint | `tmt.tencentcloudapi.com` |
| Action | `TextTranslate` |
| Version | `2018-03-21` |
| 协议 | HTTPS POST JSON |
| 鉴权 | API 3.0 签名 v3（TC3-HMAC-SHA256） |
| Region | 官方文档未列具体子域；默认走主域 |

### 1.2 请求参数

| 参数 | 必填 | 类型 | 说明 |
|------|------|------|------|
| `SourceText` | 是 | String | 待翻译文本，UTF-8，**单次 < 6000 字符** |
| `Source` | 是 | String | 源语种代码（见 §1.3） |
| `Target` | 是 | String | 目标语种代码 |
| `ProjectId` | 是 | Integer | 项目 ID，默认 0 |
| `UntranslatedText` | 否 | String | 标记不希望被翻译的词 |
| `TermRepoIDList` | 否 | Array | 术语库 ID 列表 |
| `SentRepoIDList` | 否 | Array | 例句库 ID 列表 |

### 1.3 支持语种

官方简介页（551/15611）原文：
> "目前可支持中文、英文、日语、韩语、德语、法语、西班牙语、意大利语、土耳其语、俄语、葡萄牙语、越南语、印尼语、马来语、泰语等 **18 个语种**"

确认支持的源语言代码列表（来自 TextTranslate 接口页）：
`zh`、`zh-TW`、`en`、`ja`、`ko`、`fr`、`es`、`it`、`de`、`tr`、`ru`、`pt`、`vi`、`id`、`th`、`ms`、`ar`、`hi`

> 是否支持 `Source=auto` 自动检测：**接口页未明确提及**。建议先调用 `LanguageDetect` 拿语种，再传 `Source`。

### 1.4 响应

```json
{
  "Response": {
    "TargetText": "翻译后的文本",
    "Source": "zh",
    "Target": "en",
    "UsedAmount": 12,
    "RequestId": "xxx"
  }
}
```

### 1.5 限制 / 限频 / 流式

| 项 | 值 |
|----|----|
| 单次字符上限 | **6000 字符** |
| 默认 QPS | **5 次/秒** |
| 流式（streaming） | **不支持** —— 接口为同步 REST，无 SSE / WebSocket 模式 |
| 自动语种检测 | 接口本身无 `auto` 字段；需先调 `LanguageDetect` |

### 1.6 错误码

页面提到 17 项业务错误码（`FailedOperation.*`、`UnsupportedOperation.*` 系列）+ 公共错误码：
- `FailedOperation.NoFreeAmount` 资源耗尽
- `FailedOperation.UserNotRegistered` 服务未开通
- `UnsupportedOperation.UnsupportedSourceLanguage` 源语种不支持
- `UnsupportedOperation.UnsupportedTargetLanguage` 目标语种不支持
- `UnsupportedOperation.UnsupportedLanguage` 语种对不支持

完整错误码：https://cloud.tencent.com/document/api/551/30637

---

## 2. LanguageDetect — 语种识别

### 2.1 基本

> ⚠️ 该页面 SPA SSR 输出异常，WebFetch 拿到的是 ImageTranslate 的占位内容。以下信息以 WebSearch 抓回的搜索片段（来自 cloud.tencent.com SERP cache）为准。

| 项 | 值 |
|----|----|
| Endpoint | `tmt.tencentcloudapi.com` |
| Action | `LanguageDetect` |
| Version | `2018-03-21` |
| 协议 | HTTPS POST JSON |
| 鉴权 | API 3.0 签名 v3 |
| 文档 | https://cloud.tencent.com/document/product/551/15620 |

### 2.2 参数

| 参数 | 必填 | 说明 |
|------|------|------|
| `Text` | 是 | 待识别文本 |
| `ProjectId` | 是 | 项目 ID |

### 2.3 响应

```json
{ "Response": { "Lang": "zh", "RequestId": "xxx" } }
```

### 2.4 缺失

- 字符上限：**官方文档未明确说明**（页面渲染异常无法直接确认）
- 支持识别的语种枚举：**官方文档未明确说明**；推测与 TextTranslate 18 语种一致
- 限频：**官方文档未明确说明**

---

## 3. SpeechTranslate — 语音翻译

> 文档：https://cloud.tencent.com/document/product/551/16611（页面 SPA SSR 异常，WebFetch 拿到的同样是 ImageTranslate 占位）

依据腾讯云一直以来的接口设计（在产品 SDK 中可见）：
- `SpeechTranslate` 是**分片上传 + 流式翻译**接口（区别于纯 ASR），需配合 `SessionUuid` / `Seq` / `IsEnd` 字段
- 主要用途：实时语音通话翻译，输入 PCM 分片，输出源文 + 译文
- 但官方在线文档的字段定义当前抓不到原文，**接入时需以 SDK 实测为准**

> 建议：OpenSpeech 的 ASR + 翻译流程不依赖该接口，按"先 ASR 出文 → 再 TextTranslate"两步走更稳。

---

## 4. 计费

来源：https://cloud.tencent.com/document/product/551/35017

### 文本翻译后付费阶梯

| 月用量 | 单价 |
|-------|------|
| 0 – 100 百万字符 | **58 元/百万字符** |
| ≥ 100 百万字符 | **50 元/百万字符** |

结算：月结。

### 免费额度
| 服务 | 月免费 |
|------|-------|
| **文本翻译** | **每月 500 万字符** |
| 图片翻译 | 每月 1 万次调用 |
| 端到端图片翻译 | 10 次（有效期 3 个月） |
| 语音翻译 | 每月 1 万次调用 |

### 资源包（预付费）
| 规格 | 有效期 | 价格 |
|------|-------|------|
| 1000 万字符 | 1 年 | 550 元 |
| 5000 万字符 | 1 年 | 2470 元 |
| 2 亿字符 | 1 年 | 8700 元 |
| 10 亿字符 | 1 年 | 37700 元 |
| 20 亿字符 | 1 年 | 63800 元 |
| 10 亿字符 | 90 天 | 33900 元 |

### 语种价格差异
**官方未提及** —— 定价对所有语种统一。

---

## 5. 关键链接

| 页面 | 链接 |
|------|------|
| TMT 产品总览 | https://cloud.tencent.com/product/tmt |
| 简介 | https://cloud.tencent.com/document/product/551/15611 |
| API 概览 | https://cloud.tencent.com/document/product/551/15612 |
| TextTranslate | https://cloud.tencent.com/document/product/551/15619 |
| LanguageDetect | https://cloud.tencent.com/document/product/551/15620 |
| SpeechTranslate | https://cloud.tencent.com/document/product/551/16611 |
| ImageTranslate | https://cloud.tencent.com/document/product/551/17232 |
| ImageTranslateLLM | https://cloud.tencent.com/document/product/551/118482 |
| 文件翻译请求 | https://cloud.tencent.com/document/product/551/73920 |
| 文件翻译查询 | https://cloud.tencent.com/document/product/551/73919 |
| 计费 | https://cloud.tencent.com/document/product/551/35017 |
| 控制台 | https://console.cloud.tencent.com/tmt/settings |
| 购买资源包 | https://buy.cloud.tencent.com/tmt |
| API Explorer | https://console.cloud.tencent.com/api/explorer?Product=tmt&Version=2018-03-21&Action=TextTranslate |
