# Azure Speech / Translator / OpenAI — 鉴权 + Region + 计费

> 来源：
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/how-to-configure-azure-ad-auth
> - https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits
> - https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/
> - https://azure.microsoft.com/pricing/details/cognitive-services/translator/
> - https://azure.microsoft.com/pricing/details/azure-openai/
>
> 抓取日期：2026-04-28

---

## 1. 鉴权（Speech）

支持三种，按推荐顺序：

### 1.1 Subscription Key
最简单。Header `Ocp-Apim-Subscription-Key: <KEY>`。两个 key 自动轮换。

### 1.2 Token-based（issueToken）
```
POST https://<REGION>.api.cognitive.microsoft.com/sts/v1.0/issueToken
Ocp-Apim-Subscription-Key: <KEY>
```
Body 即 JWT，**有效期 10 分钟**。建议每 9 分钟刷新。后续请求用 `Authorization: Bearer <JWT>`。

### 1.3 Microsoft Entra ID（推荐生产）

要求：
1. Speech 资源开 **custom subdomain**（**一次性，不可逆**）：
   ```
   az cognitiveservices account update \
     --name <speech-resource> \
     --resource-group <rg> \
     --custom-domain <unique-name>
   ```
   开了之后 endpoint 变成 `https://<unique-name>.cognitiveservices.azure.com/`
2. 给调用者分配角色：`Cognitive Services Speech User` 或 `Cognitive Services Speech Contributor`
3. 拿 token：scope = `https://cognitiveservices.azure.com/.default`
4. 构造 SDK 用的 `aad#<resourceId>#<entraToken>` 字符串作为 authorization token

```python
from azure.identity import InteractiveBrowserCredential
ibc = InteractiveBrowserCredential()
aadToken = ibc.get_token("https://cognitiveservices.azure.com/.default")
```

**SDK 类对鉴权方式有差异**：
- `SpeechRecognizer` / `ConversationTranscriber`：可直接 `SpeechConfig(token_credential=cred, endpoint=custom_endpoint)`
- `TranslationRecognizer`：同上
- `SpeechSynthesizer`：必须走 `aad#...` 字符串
- `ConversationTranslator`：**不支持** Entra ID
- Python 的 `VoiceProfileClient`：不可用

## 2. 鉴权（Translator）

| 方式 | header |
| --- | --- |
| Resource key | `Ocp-Apim-Subscription-Key` |
| Token | `Authorization: Bearer` |
| Entra ID | `Authorization: Bearer` (managed identity / SP) |

**额外**：region 化或 multi-service resource 必须加 `Ocp-Apim-Subscription-Region: <REGION>`。

## 3. 鉴权（Azure OpenAI）

详见 [`azure-openai.md`](./azure-openai.md)。要点：`api-key` header 或 Entra Bearer。

## 4. Region 列表（Speech 全部 33 个）

来源：https://learn.microsoft.com/en-us/azure/ai-services/speech-service/regions

| Geography | Region | Identifier |
| --- | --- | --- |
| Africa | South Africa North | `southafricanorth` |
| Asia Pacific | East Asia | `eastasia` |
| Asia Pacific | Southeast Asia | `southeastasia` |
| Asia Pacific | Australia East | `australiaeast` |
| Asia Pacific | Central India | `centralindia` |
| Asia Pacific | Japan East | `japaneast` |
| Asia Pacific | Japan West | `japanwest` |
| Asia Pacific | Korea Central | `koreacentral` |
| Canada | Canada Central | `canadacentral` |
| Canada | Canada East | `canadaeast` |
| Europe | North Europe | `northeurope` |
| Europe | West Europe | `westeurope` |
| Europe | France Central | `francecentral` |
| Europe | Germany West Central | `germanywestcentral` |
| Europe | Italy North | `italynorth` |
| Europe | Norway East | `norwayeast` |
| Europe | Sweden Central | `swedencentral` |
| Europe | Switzerland North | `switzerlandnorth` |
| Europe | Switzerland West | `switzerlandwest` |
| Europe | UK South | `uksouth` |
| Europe | UK West | `ukwest` |
| Middle East | UAE North | `uaenorth` |
| Middle East | Qatar Central | `qatarcentral` |
| South America | Brazil South | `brazilsouth` |
| US | Central US | `centralus` |
| US | East US | `eastus` |
| US | East US 2 | `eastus2` |
| US | North Central US | `northcentralus` |
| US | South Central US | `southcentralus` |
| US | West Central US | `westcentralus` |
| US | West US | `westus` |
| US | West US 2 | `westus2` |
| US | West US 3 | `westus3` |

**不支持 Speech 处理的**：`southindia`, `spaincentral`。

### 4.1 关键能力的 Region 子集

| 能力 | 支持的 region |
| --- | --- |
| Real-time STT | 所有 33 个 |
| Batch transcription | 所有 33 个 |
| **Fast transcription** | 22 个：`australiaeast / brazilsouth / canadacentral / centralindia / eastus / eastus2 / francecentral / germanywestcentral / italynorth / japaneast / japanwest / koreacentral / northcentralus / northeurope / southcentralus / southeastasia / swedencentral / uksouth / westeurope / westus / westus2 / westus3` |
| Whisper via batch | 7 个：`australiaeast / eastus / japaneast / southcentralus / southeastasia / uksouth / westeurope` |
| Real-time Translation | 所有 33 个 |
| Video translation | 9 个：`centralus / eastus / eastus2 / northcentralus / southcentralus / westcentralus / westeurope / westus / westus2 / westus3` |
| Live Interpreter | 5 个：`eastus / japaneast / southeastasia / westeurope / westus2` |
| LLM speech (preview) | 5 个：`centralindia / eastus / northeurope / southeastasia / westus` |

> **重要**：Key 创建在 region X，只能调 region X 的 endpoint。跨 region 调会 401。
> Azure 不会把数据搬出 region：if `westus` resource → 数据只在 `westus`。

### 4.2 Translator Region

Translator 的 endpoint 是按"地理"路由的，而不是 region：
- Global：`api.cognitive.microsofttranslator.com`
- 美洲：`api-nam.cognitive.microsofttranslator.com`
- 亚太：`api-apc.cognitive.microsofttranslator.com`
- 欧洲：`api-eur.cognitive.microsofttranslator.com`
- 瑞士：custom endpoint

## 5. Quotas（Speech S0）

| 项目 | 默认 |
| --- | --- |
| Real-time STT + Translation 并发 | 100 |
| Custom endpoint 并发 | 100 |
| Real-time diarization 单 session | 240 min |
| **Fast transcription** 单文件 | < 500 MB / < 5h（diarization < 2h） |
| **Fast transcription** 请求/分钟 | 600 |
| Batch transcription 单文件 | ≤ 1 GB |
| Batch transcription 单请求文件数 | ≤ 1,000 |
| Batch transcription REST 速率 | 100 req / 10s |
| LLM speech (preview) 请求/分钟 | 600 |
| TTS 实时 TPS | 200（默认）→ 可申请到 1,000 |

F0 几乎所有都是 1 或不可用。详见 https://learn.microsoft.com/en-us/azure/ai-services/speech-service/speech-services-quotas-and-limits

## 6. 计费速览（list price）

> 实际价格随 region/tier 浮动；以官方 pricing 页为准。

### 6.1 Speech (S0 standard)

| 能力 | List 单价 |
| --- | --- |
| Real-time STT | ~$1/audio hour |
| Fast transcription | 与 STT 相同档位 |
| Batch transcription | ~$1/hour（audio） |
| Custom Speech 训练 | 按训练 hour |
| Custom Speech 部署 endpoint hosting | 月费 |
| Speech translation | **$2.50/audio hour**（覆盖 ≤ 2 target） |
| TTS Neural voices | ~$15/百万字符 |

### 6.2 F0 免费额度（Speech）

每月免费用量（典型）：
- STT 5 hours / month
- TTS 0.5M chars / month standard, 0.5M chars / month neural

具体见 https://azure.microsoft.com/pricing/details/speech/

### 6.3 Translator

| Tier | 字符 / 月 | 价格 |
| --- | --- | --- |
| F0 | 2M / 月 | 免费 |
| S1 | 0-250M | $10/百万字符 |
| S2-S4 | 量级越大单价越低 | 阶梯 |
| C2-C4 | Commitment tier，长期承诺折扣 | 阶梯 |

Custom Translator 模型训练 + 部署有额外费用。

### 6.4 Azure OpenAI

按 token，input/output 分档：
- GPT-4o：$2.50/M input, $10/M output（list；2025 价位）
- GPT-4o-mini：~$0.15/M input, $0.60/M output
- GPT-5 / o1 系列：reasoning token 单独计

详见 https://azure.microsoft.com/pricing/details/cognitive-services/openai-service/

## 7. 数据驻留 / 合规

- Speech：处理在 resource 创建的 region 内完成，不出 region
- Translator：可选 Global / 区域化 endpoint；关心 EU 数据驻留用 `api-eur`
- Azure OpenAI：standard 部署在 region；global 部署可能跨 region；data zone 可锁定到 zone

## 8. Sovereign Clouds

- **Azure Government**（US Gov 实体）：endpoint 在 `*.usgovvirginia.cognitive.microsoft.com` 等
- **Azure operated by 21Vianet**（中国大陆）：endpoint 不同

详见 https://learn.microsoft.com/en-us/azure/ai-services/speech-service/sovereign-clouds

## 9. OpenSpeech 适配建议

- **桌面端默认推 Subscription Key**（用户配 1 个 key 就能用）
- 企业用户切到 Entra ID（要求自己开 custom domain，做 RBAC）
- **Region 选择**：让用户在 onboarding 时选；或自动用 `eastus`/`westus`/`westeurope` 这种全能 region
- 注意 Fast transcription 和 LLM speech 不在所有 region 可用，UI 应根据所选 region 收起对应能力
- 计费监控：实时 STT 与 Translation **共享并发配额**，需要在 SDK 端做 backoff
