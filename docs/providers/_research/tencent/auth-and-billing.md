# 腾讯云通用鉴权 + 计费汇总

> 来源：
> - 公共参数：https://cloud.tencent.com/document/api/1093/35640
> - 签名 v3：https://cloud.tencent.com/document/api/1093/35641
> - ASR 计费：https://cloud.tencent.com/document/product/1093/35686
> - TMT 计费：https://cloud.tencent.com/document/product/551/35017
> - 公共错误码：https://cloud.tencent.com/document/api/1093/35647
>
> 抓取日期：2026-04-28

---

## 1. 鉴权 — 两种体系

腾讯云 ASR / TMT 使用**两种不同**的鉴权方式，OpenSpeech 适配器要分别实现：

| 体系 | 用于 | 算法 |
|------|------|------|
| **API 3.0 签名 v3** | 一句话识别、录音文件识别、TextTranslate、LanguageDetect 等所有 `*.tencentcloudapi.com` REST 接口 | TC3-HMAC-SHA256（Header 携带） |
| **WebSocket 签名 v1** | 实时语音识别（`asr.cloud.tencent.com/asr/v2/...`）、录音文件极速版（`asr.cloud.tencent.com/asr/flash/v1/...`） | HMAC-SHA1 + Base64 + URL 编码（Query 或 Header 携带） |

### 1.1 API 3.0 签名 v3（TC3-HMAC-SHA256）

#### Step 1 — CanonicalRequest
```
HTTPRequestMethod\n
CanonicalURI\n
CanonicalQueryString\n
CanonicalHeaders\n
SignedHeaders\n
HashedRequestPayload
```
- `HashedRequestPayload` = `hex(sha256(body))`

#### Step 2 — StringToSign
```
TC3-HMAC-SHA256\n
RequestTimestamp\n
CredentialScope\n
HashedCanonicalRequest
```
- `CredentialScope` = `<Date>/<service>/tc3_request`，例：`2026-04-28/asr/tc3_request`

#### Step 3 — Signature
```
SecretDate    = HMAC_SHA256("TC3" + SecretKey, Date)
SecretService = HMAC_SHA256(SecretDate, service)
SecretSigning = HMAC_SHA256(SecretService, "tc3_request")
Signature     = hex(HMAC_SHA256(SecretSigning, StringToSign))
```

#### Step 4 — Authorization Header
```
Authorization: TC3-HMAC-SHA256 Credential=<SecretId>/<CredentialScope>, SignedHeaders=<...>, Signature=<...>
```

#### 必填公共 Header
| Header | 说明 |
|--------|------|
| `Host` | `<service>.tencentcloudapi.com` |
| `Content-Type` | `application/json; charset=utf-8`（POST JSON） |
| `X-TC-Action` | 接口名（如 `SentenceRecognition`） |
| `X-TC-Version` | API 版本（ASR=`2019-06-14`、TMT=`2018-03-21`） |
| `X-TC-Timestamp` | UNIX 秒 |
| `Authorization` | 见上 |

#### 可选公共 Header
| Header | 说明 |
|--------|------|
| `X-TC-Region` | 地域；ASR 接口**不需要传** |
| `X-TC-Token` | 临时凭证（CAM STS） |
| `X-TC-Language` | 返回语言（如 `zh-CN`、`en-US`） |

#### Python 示例
```python
import hashlib, hmac, json, time
from datetime import datetime, timezone

secret_id, secret_key = "AKID...", "..."
service, host = "asr", "asr.tencentcloudapi.com"
action, version = "SentenceRecognition", "2019-06-14"
ts = int(time.time())
date = datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d")

payload = json.dumps({"EngSerViceType":"16k_zh","SourceType":1,"VoiceFormat":"wav","Data":"<b64>","DataLen":12345})
hashed_payload = hashlib.sha256(payload.encode()).hexdigest()
canonical = f"POST\n/\n\ncontent-type:application/json; charset=utf-8\nhost:{host}\nx-tc-action:{action.lower()}\n\ncontent-type;host;x-tc-action\n{hashed_payload}"

scope = f"{date}/{service}/tc3_request"
str_to_sign = f"TC3-HMAC-SHA256\n{ts}\n{scope}\n{hashlib.sha256(canonical.encode()).hexdigest()}"

kd = hmac.new(("TC3"+secret_key).encode(), date.encode(), hashlib.sha256).digest()
ks = hmac.new(kd, service.encode(), hashlib.sha256).digest()
kr = hmac.new(ks, b"tc3_request", hashlib.sha256).digest()
sig = hmac.new(kr, str_to_sign.encode(), hashlib.sha256).hexdigest()

auth = f"TC3-HMAC-SHA256 Credential={secret_id}/{scope}, SignedHeaders=content-type;host;x-tc-action, Signature={sig}"
```

完整示例工程：https://github.com/TencentCloud/signature-process-demo

---

### 1.2 WebSocket 签名 v1（HMAC-SHA1）

用于：
- 实时语音识别 `wss://asr.cloud.tencent.com/asr/v2/<appid>?...`
- 录音文件识别极速版 `https://asr.cloud.tencent.com/asr/flash/v1/<appid>?...`

#### 流程
1. 把除 `signature` 外的所有 query 参数按 key 字典序排序
2. 拼成 URL（不带 `wss://` 或 `https://`）：
   ```
   asr.cloud.tencent.com/asr/v2/<appid>?engine_model_type=16k_zh&expired=...&nonce=...&secretid=...&timestamp=...&voice_id=...
   ```
3. `raw_sig = HMAC_SHA1(SecretKey, signing_string)`
4. `b64_sig = base64(raw_sig)`
5. URL 编码后作为 `signature` query 参数加入请求

#### 必填 Query
| 参数 | 含义 |
|------|------|
| `secretid` | SecretId |
| `timestamp` | UNIX 秒 |
| `expired` | 过期时间戳，> timestamp，差 < 90 天 |
| `nonce` | 随机正整数（≤10 位） |
| `signature` | 签名 |

> 实时识别还需 `voice_id` (UUID) 和 `engine_model_type`；极速版还需 `appid` (在 path 上)、`engine_type`。

---

## 2. 公共参数（v3）

| 参数 | 类型 | 必选 | Header 名 |
|------|------|------|-----------|
| Action | String | ✅ | `X-TC-Action` |
| Region | String | 否（ASR 不需要） | `X-TC-Region` |
| Timestamp | Integer | ✅ | `X-TC-Timestamp` |
| Version | String | ✅ | `X-TC-Version` |
| Authorization | String | ✅ | `Authorization` |
| Token | String | 否 | `X-TC-Token` |
| Language | String | 否 | `X-TC-Language` |

### Region 支持
- ASR 公共参数页**仅列出 `ap-guangzhou` 一个 region**
- 多 region 部署：腾讯云 ASR 文档没有多 region endpoint 列表（不像 OSS / CVM 那样有 `service.ap-shanghai.tencentcloudapi.com` 这样的子域），实际接入直接走主域 `asr.tencentcloudapi.com`

---

## 3. 公共错误码

| 错误码 | 含义 |
|--------|------|
| `ActionOffline` | 接口已下线 |
| `AuthFailure.InvalidAuthorization` | Authorization 头格式错 |
| `AuthFailure.InvalidSecretId` | SecretId 类型错 |
| `AuthFailure.MFAFailure` | MFA 错误 |
| `AuthFailure.SecretIdNotFound` | 密钥不存在 |
| `AuthFailure.SignatureExpire` | 签名过期 |
| `AuthFailure.SignatureFailure` | 签名错 |
| `AuthFailure.TokenFailure` | Token 错 |
| `AuthFailure.UnauthorizedOperation` | 未授权 |
| `DryRunOperation` | DryRun 模式 |
| `FailedOperation` | 操作失败 |
| `InternalError` | 内部错 |
| `InvalidAction` | 接口不存在 |
| `InvalidParameter` | 参数错 |
| `InvalidParameterValue` | 取值错 |
| `InvalidRequest` | multipart 格式错 |
| `IpInBlacklist` / `IpNotInWhitelist` | IP 黑/白名单 |
| `LimitExceeded` | 配额超限 |
| `MissingParameter` | 缺少参数 |
| `RequestLimitExceeded` | 请求频率超限 |
| `ResourceNotFound` | 资源不存在 |
| `ServiceUnavailable` | 服务不可用 |
| `UnsupportedOperation` | 操作不支持 |

ASR 业务错误码（节选）：
- `FailedOperation.ErrorRecognize`、`FailedOperation.NoSuchTask`、`FailedOperation.UserNotRegistered`、`FailedOperation.ServiceIsolate`
- `InvalidParameter.ErrorInvalidVoiceFormat`、`InvalidParameterValue.ErrorVoicedataTooLong`、`InvalidParameterValue.NoHumanVoice`
- `LimitExceeded.VocabFull`

---

## 4. 计费汇总

### 4.1 ASR 在线版（来源 https://cloud.tencent.com/document/product/1093/35686）

| 产品 | 计费方式 | 后付费起步价 | 月免费 |
|------|---------|------------|-------|
| 实时语音识别 | 按时长（小时） | 3.20 元/小时（0–299 时/日） | 5 小时 |
| 实时语音识别 (大模型版) | 同上 | 4.80 元/小时 | 含在 5 小时内 |
| 一句话识别 | 按调用次数（千次） | 3.20 元/千次 | 5000 次 |
| 录音文件识别 | 按时长（小时） | 1.75 元/小时（0–12 万时/月） | 10 小时 |
| 录音文件识别极速版 | 按时长 | （查购买页 SKU） | 5 小时 |
| 语音流异步识别 | 按时长 | 3.20 元/小时 | 5 小时 |

降量阶梯：高用量段单价显著下探（如录音文件 30 万+小时/月降到 0.95 元/小时）。

### 4.2 ASR 资源包

| 产品 | 示例 |
|------|------|
| 实时识别 | 60 时 270 元 / 1000 时 4200 元 / 10000 时 35000 元 |
| 一句话 | 30 千次 90 元 / 1000 千次 1800 元 / 100000 千次 120000 元 |
| 录音文件 | 60 时 90 元 / 1000 时 1200 元 / 300000 时 210000 元 |

### 4.3 ASR 增值收费

文档原文："增值类产品的功能，需在购买资源包后设置对应参数方可生效"。
- 情绪识别 / 角色分离 / NLP 语义分段 / 口语转书面语 = **单独计费**
- 但**具体单价在线计费页未列出**，需控制台或 https://buy.cloud.tencent.com/asr 查 SKU

### 4.4 TMT 文本翻译

| 阶梯 | 单价 |
|------|------|
| 0 – 100 百万字符/月 | **58 元/百万字符** |
| ≥ 100 百万字符/月 | **50 元/百万字符** |
| 月免费 | **500 万字符** |

资源包：1000 万字符 1 年 = 550 元 ... 20 亿字符 1 年 = 63800 元。

---

## 5. 关键链接

| 页面 | 链接 |
|------|------|
| 公共参数 | https://cloud.tencent.com/document/api/1093/35640 |
| 签名 v3 | https://cloud.tencent.com/document/api/1093/35641 |
| 签名 v1（遗留） | https://cloud.tencent.com/document/api/1093/35642 |
| 公共错误码 | https://cloud.tencent.com/document/api/1093/35647 |
| ASR 计费 | https://cloud.tencent.com/document/product/1093/35686 |
| TMT 计费 | https://cloud.tencent.com/document/product/551/35017 |
| 控制台密钥 | https://console.cloud.tencent.com/cam/capi |
| 购买 ASR | https://buy.cloud.tencent.com/asr |
| 购买 TMT | https://buy.cloud.tencent.com/tmt |
| 签名示例工程 | https://github.com/TencentCloud/signature-process-demo |
