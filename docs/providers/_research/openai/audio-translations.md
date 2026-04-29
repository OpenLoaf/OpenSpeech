> 来源：OpenAI 官方文档
> 抓取日期：2026-04-28

# Audio Translations API (`/v1/audio/translations`)

## Endpoint

`POST https://api.openai.com/v1/audio/translations`

- 官方 reference：https://platform.openai.com/docs/api-reference/audio/createTranslation
- 官方 guide：https://platform.openai.com/docs/guides/speech-to-text

## 行为

> The translations endpoint differs from the Transcriptions endpoint since the output is **not in the original input language** and is instead translated to **English text**. **This endpoint supports only the `whisper-1` model.**

输入任意支持的语种音频，输出 **仅为英文文本**（当前 OpenAI 只支持英文为目标语种）。
来源：https://platform.openai.com/docs/guides/speech-to-text、https://openai.com/index/whisper/

## 模型

- 仅 `whisper-1`
- gpt-4o-transcribe / gpt-4o-mini-transcribe **不暴露** translations 端点（按 reference 路由设计）

## 参数

与 transcriptions 类似，但 **没有 `language` 参数**（目标语固定为英文）：

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | file | 是 | 音频文件 |
| `model` | string | 是 | `whisper-1` |
| `prompt` | string | 否 | hints，**英文** |
| `response_format` | string | 否 | `json / text / srt / verbose_json / vtt` |
| `temperature` | number | 否 | 采样温度 |

来源：https://platform.openai.com/docs/api-reference/audio/createTranslation

## 注意

- 受 25 MB 单文件上限约束（同 transcriptions）
- 不支持 streaming
- 输出语种固定 English；其他目标语需通过 transcriptions + LLM 二次翻译实现

## 受限页面

- https://platform.openai.com/docs/api-reference/audio/createTranslation — 403
