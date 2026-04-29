> 来源：官方文档
> - https://cloud.google.com/translate/docs/editions
> - https://cloud.google.com/translate/docs/intro-to-v3
> - https://cloud.google.com/translate/docs/reference/rest/v3/projects/translateText
> - https://cloud.google.com/translate/pricing
> - https://cloud.google.com/translate/quotas
> - https://cloud.google.com/translate/docs/languages
>
> 抓取日期：2026-04-28

# Cloud Translation API

## 1. Editions

| Edition | API 版本 | 主要特性 |
| --- | --- | --- |
| Cloud Translation - **Basic** | v2 | 仅 NMT 模型；只能 OAuth 或 API Key；无 glossary、无 batch、无 document、无 custom model。 |
| Cloud Translation - **Advanced** | v3 | NMT + Translation LLM + Adaptive MT + AutoML custom model；支持 glossary、batch、document、model selection、`isTranslatableHtml`、Vertex AI 集成；强制 OAuth/ADC（不再支持 API Key for v3 sensitive ops）。 |

来源：https://cloud.google.com/translate/docs/editions

## 2. Streaming

- **不提供 streaming 翻译**。所有 `translateText` 都是请求-响应（同步）；超长文本走 `batchTranslateText`（异步 LRO，结果写 GCS）。
- Adaptive MT 也仅是低延迟同步，不是 token 流。
- 来源：https://cloud.google.com/translate/docs/intro-to-v3

## 3. v3 端点

- **Sync**：
  - `POST https://translation.googleapis.com/v3/projects/{project}/locations/{location}:translateText`
  - `POST .../{location}:detectLanguage`
  - `POST .../{location}:getSupportedLanguages`
  - `POST .../{location}:translateDocument`
  - `POST .../{location}:adaptiveMtTranslate`
- **Async (batch)**：
  - `POST .../{location}:batchTranslateText` → google.longrunning.Operation
  - `POST .../{location}:batchTranslateDocument`
- 来源：https://cloud.google.com/translate/docs/reference/rest

`location` 推荐 `global`；某些 feature（glossary / AutoML / Adaptive MT）必须用 region（如 `us-central1`）。

## 4. translateText 请求体（v3）

| 字段 | 说明 |
| --- | --- |
| `contents[]` | string 数组，最多 1024 段。 |
| `mimeType` | `text/plain` 或 `text/html`。 |
| `sourceLanguageCode` | 可选，省略则自动检测。 |
| `targetLanguageCode` | 必填，BCP-47。 |
| `model` | `projects/{p}/locations/{l}/models/general/nmt` 或 `.../translation-llm` 或 自定义 AutoML model 资源名。 |
| `glossaryConfig` | `{ glossary: <resource>, ignoreCase, glossaryTermsOnly }`。仅 Advanced。 |
| `transliterationConfig` | `{ enableTransliteration }`。 |
| `labels` | map<string,string>，账单分组。 |

响应：`translations[].translatedText` / `detectedLanguageCode` / `model` / `glossaryConfig`。

## 5. Limits / Quotas

来源：https://cloud.google.com/translate/quotas

- **同步内容配额**：Characters per 100 seconds per project = **10,000,000**；同等 per project per user。
- **单请求字符上限**：`translateText` 文档建议 ≤ **30K codepoints**（再多请拆分）。
- **batchTranslateText**：单次最多 100 个 GCS input 文件，单文件最多 10MB。
- **API Key auth**：仅 Basic (v2) 与 Advanced 的部分非敏感 API；Advanced 的 batch / glossary / AutoML 必须 OAuth/ADC。

## 6. 计费

来源：https://cloud.google.com/translate/pricing

- 计费单位：**characters**（含空白、换行、标点；包括无法翻译的字符）。
- NMT / 自定义 AutoML：按 input characters × target language 数收费。Free tier 500K chars/month。
- **Translation LLM**：input $10 / 1M chars + output $10 / 1M chars。
- Adaptive MT：另价。
- Document translation：按文档转出的 character 数 + 文档处理 surcharge。

## 7. 语种

来源：https://cloud.google.com/translate/docs/languages ; https://cloud.google.com/translate/docs/list-supported-languages

- **NMT** model 支持 **130+ 语言**（添加 70 新语言后）。任意支持语言可作为 source/target。
- **Translation LLM** 支持子集（含 Arabic / Hindi / Russian 等扩展）。
- 实时获取：调用 `GetSupportedLanguages` 并传 `model=<resource>` 与 `displayLanguageCode`。

## 8. 错误码

来源：https://cloud.google.com/translate/docs/reference/rest

- HTTP `400 INVALID_ARGUMENT`：language code 不支持 / contents 超长 / mimeType 错。
- `403 PERMISSION_DENIED`：API 未启用 / Service Account 无 `roles/cloudtranslate.user`。
- `429 RESOURCE_EXHAUSTED`：超 character/100s。
- `503 UNAVAILABLE`：建议指数退避。

## 9. 抓取失败 / 待补

- 「单请求 30K codepoints」「batchTranslateText 100 files / 10MB」是常见公开数值；正文确认请打开 quotas 页直读。
