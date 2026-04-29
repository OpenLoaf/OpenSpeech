# Azure Translator（独立服务）

> 来源：
> - https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/overview
> - https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/v3/reference
> - https://learn.microsoft.com/en-us/azure/ai-services/translator/document-translation/overview
> - https://learn.microsoft.com/en-us/azure/ai-services/translator/service-limits
>
> 抓取日期：2026-04-28

---

## 1. 与 Speech Translation 的区别

| 项 | Azure Translator | Speech Translation (in Speech SDK) |
| --- | --- | --- |
| 输入 | **文本** | 音频 |
| 输出 | 翻译后文本 | 翻译后文本 + （可选）TTS 音频 |
| 协议 | REST | WebSocket（SDK 封装） |
| 计费 | 按字符 | 按音频时长 |
| 用例 | 后期翻译已转写文本、UI 文本国际化 | 实时同声传译 |

OpenSpeech 中：
- "用户问 AI 之前先翻译输入" → Translator
- "字幕实时翻译" → Speech Translation

## 2. API 版本

- **GA 当前**：`3.0`
- **Preview**：`2025-10-01-preview`（可选 NMT 或 LLM 部署：GPT-4o-mini / GPT-4o）

## 3. 服务 Endpoint

| 服务端 | 处理数据中心 | 用途 |
| --- | --- | --- |
| `api.cognitive.microsofttranslator.com`（推荐 Global） | 最近的可用 DC | 默认 |
| `api-nam.cognitive.microsofttranslator.com` | East US 2 / West US 2 | 美洲数据驻留 |
| `api-apc.cognitive.microsofttranslator.com` | Japan East / Southeast Asia | 亚太 |
| `api-eur.cognitive.microsofttranslator.com` | France Central / West Europe | 欧洲（不含瑞士） |
| 瑞士 custom endpoint | Switzerland North/West | 瑞士专属 |

VNet 启用后必须用自定义 endpoint：`https://<your-resource-name>.cognitiveservices.azure.com`，不能用 Bearer token，必须用 key + region header。

## 4. 鉴权

| 方式 | header |
| --- | --- |
| Resource key | `Ocp-Apim-Subscription-Key: <KEY>` |
| Token bearer | `Authorization: Bearer <TOKEN>`（issueToken 换） |
| Microsoft Entra ID | OAuth |

如果用 multi-service Foundry resource 或 region 化 endpoint，**必须额外加** `Ocp-Apim-Subscription-Region: <REGION>`。

详见 https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/authentication

## 5. Text Translation API（v3）

### 5.1 Operations

| Endpoint | 用途 |
| --- | --- |
| `GET /languages` | 取支持语种列表（无需鉴权） |
| `POST /translate` | 翻译；可一次到多语种 |
| `POST /transliterate` | 字符转写 |
| `POST /detect` | 语种识别 |
| `POST /breaksentence` | 句子切分 |
| `POST /dictionary/lookup` | 词典反查 |
| `POST /dictionary/examples` | 词典上下文示例 |

### 5.2 基础调用

```bash
curl -X POST "https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&from=en&to=fr&to=es" \
  -H "Ocp-Apim-Subscription-Key: <KEY>" \
  -H "Content-Type: application/json" \
  -d '[{"Text":"Hello world"}]'
```

响应：
```json
[
  {
    "translations": [
      { "text": "Bonjour le monde", "to": "fr" },
      { "text": "Hola mundo", "to": "es" }
    ]
  }
]
```

### 5.3 自动检测 source

省略 `from`，或调 `/detect` 拿到语种再 `/translate`。也可用 `/translate?api-version=3.0&to=fr`（不指定 `from`）让服务自动识别。

## 6. 字符与数组限制

| Operation | 单元素最大字符 | 数组最多元素 | 单请求总字符 |
| --- | --- | --- | --- |
| Translate | 50,000 | 1,000 | **50,000** |
| Transliterate | 5,000 | 10 | 5,000 |
| Detect | 50,000 | 100 | 50,000 |
| BreakSentence | 50,000 | 100 | 50,000 |
| Dictionary Lookup | 100 | 10 | 1,000 |
| Dictionary Examples | 100×2 | 10 | 2,000 |

**计费**：按字符数计算，不按请求数。多目标语种时 = 字符 × 目标语种数。

## 7. 速率（Tier）

| Tier | 字符 / 小时 |
| --- | --- |
| F0 (free) | 2,000,000 |
| S1 | 40,000,000 |
| S2 / C2 | 40,000,000 |
| S3 / C3 | 120,000,000 |
| S4 / C4 | 200,000,000 |

> 滑动窗口：F0 大约 33,300 字符/分钟（2M / 60min），太集中也会被限流。
> 无并发请求数限制。

**Custom Translator 模型**：每模型 3,600 字符/秒上限。

## 8. 延迟

- 标准模型最大 15s
- Custom 模型最大 120s
- 100 字符以内通常 150-300ms

## 9. Streaming？

**官方文档未提到 streaming 翻译响应**。Translator REST 设计为 batch / 一次 POST 一次返回。如果要 streaming "边说边翻"必须用 Speech Translation SDK。

> 如果用 preview 版本 + LLM 部署（GPT-4o），可能可走 SSE，但官方文档没明确提供 streaming 协议契约——等同于"未明确说明"。

## 10. 支持语种

完整列表（≥ 100 语对）：https://learn.microsoft.com/en-us/azure/ai-services/translator/language-support

## 11. Document Translation

### 11.1 两种模式

| 模式 | 用途 | 大小限制 |
| --- | --- | --- |
| **Asynchronous (batch)** | 多文件，需 Azure Blob 存储 | 单文件 ≤ 40 MB；总 ≤ 250 MB；最多 1000 文件；最多 10 个目标语种 |
| **Synchronous (single file)** | 单文件，直接 POST 返回 | 单文件 ≤ 10 MB；单语种；6M 字符/分钟 |

### 11.2 支持的格式

PDF / DOCX / PPTX / XLSX / HTML / Markdown / TXT / CSV / TSV / RTF / MSG / ODT / ODS / ODP / XLF / MHTML

Image (preview)：`.jpeg .png .bmp .webp`（按图计费）

### 11.3 Glossary 格式

`.csv / .tsv / .xlf`（异步 ≤ 10 MB，同步 ≤ 1 MB）

### 11.4 安全

- 异步：需要 SAS token 或 Managed Identity
- 同步：custom domain endpoint

## 12. Custom Translator

支持训练领域定制翻译模型，部署后通过 `category` 参数调用。瑞士 region 暂不支持。

## 13. 错误码（Translator）

| 状态 | 含义 |
| --- | --- |
| 401 | Key 错或缺 |
| 403 | Key 对，但 tier 不支持该操作 / region 不匹配 |
| 429 | 字符配额或速率超限 |
| 400 | 请求格式错误 / 不支持的语种 |

详见 https://learn.microsoft.com/en-us/azure/ai-services/translator/text-translation/reference/status-response-codes

## 14. OpenSpeech 适配建议

- **"翻译已转写文本"**：Translator REST 是首选；50K 字符/请求够用。
- **"翻译用户输入到 LLM"**：v3.0 默认 NMT，简单稳定；如果要 LLM 翻译用 preview 版本（要求 Foundry resource）。
- **批量翻译用户笔记 / 历史**：Document Translation 异步，但要先上传到 Blob，对桌面应用麻烦——多数情况下分块调 Text /translate 即可。
