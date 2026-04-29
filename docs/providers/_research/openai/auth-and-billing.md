> 来源：OpenAI 官方文档
> 抓取日期：2026-04-28

# Auth & Billing

## 鉴权

- 标准 HTTP Bearer：`Authorization: Bearer <OPENAI_API_KEY>`
- 多组织 / 多项目 header：`OpenAI-Organization: org_xxx` / `OpenAI-Project: proj_xxx`，用量计入指定的组织与项目
- Realtime API ephemeral：`POST /v1/realtime/client_secrets` 生成 client secret，用于浏览器 / 移动端等不能放长期 key 的场景

来源：
- https://platform.openai.com/docs/api-reference/authentication
- https://platform.openai.com/docs/api-reference/introduction
- https://platform.openai.com/docs/api-reference/realtime

## Rate Limits

> Rate limits 在 5 个维度计量：RPM（请求/分）、RPD（请求/日）、TPM（token/分）、TPD（token/日）、IPM（图像/分）。任意一项触顶都会被限。
> Rate limits 定义在 **organization 与 project** 级别，**不是** user 级别。

随消费额增长自动晋升 usage tier，对应的 rate limit 同步上调。

来源：
- https://developers.openai.com/api/docs/guides/rate-limits
- https://platform.openai.com/docs/guides/rate-limits

## 计费

- 按 token 计量（input / cached input / output 分别计价）
- 音频：whisper-1 按 **音频时长**（per-minute）；Realtime 同时按 **音频时长 + 文本 token** 双计量
- pricing 总表：https://openai.com/api/pricing/、https://developers.openai.com/api/docs/pricing

## 错误码（常见）

| HTTP | 含义 |
|---|---|
| 400 | 请求参数错误 |
| 401 | 鉴权失败（key 无效 / 已撤销） |
| 403 | 权限不足 / 国家/地区不可用 |
| 404 | 模型或资源不存在 |
| 429 | rate limit / quota 超限 |
| 500 / 503 | 服务端错误 |

来源：https://platform.openai.com/docs/guides/error-codes

## 受限页面

- https://platform.openai.com/docs/api-reference/authentication — 403
- https://platform.openai.com/docs/guides/rate-limits — 403
- https://platform.openai.com/docs/guides/error-codes — 403
- https://openai.com/api/pricing/ — 域名安全检查拒绝
