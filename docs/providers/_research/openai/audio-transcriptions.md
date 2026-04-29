> 来源：OpenAI 官方文档（platform.openai.com）
> 抓取日期：2026-04-28
> 注：platform.openai.com 阻止了直接 fetch（403），以下事实通过 WebSearch 抓取的官方文档摘录整理；每条都附原始官方深链，可人工核对。

# Audio Transcriptions API (`/v1/audio/transcriptions`)

## Endpoint

`POST https://api.openai.com/v1/audio/transcriptions`

- 官方 reference：https://platform.openai.com/docs/api-reference/audio/createTranscription
- 官方 guide：https://platform.openai.com/docs/guides/speech-to-text
- Quickstart：https://platform.openai.com/docs/guides/speech-to-text/quickstart

## 模型

| 模型 ID | 说明 | 文档 |
|---|---|---|
| `whisper-1` | 开源 Whisper V2 的托管版本，最早可用的转写模型 | https://platform.openai.com/docs/guides/speech-to-text |
| `gpt-4o-transcribe` | 基于 GPT-4o 的转写模型，相比 whisper 在 WER 与多语种识别上有提升 | https://platform.openai.com/docs/models/gpt-4o-transcribe |
| `gpt-4o-mini-transcribe` | gpt-4o-transcribe 的更小/更便宜版本 | https://platform.openai.com/docs/models/gpt-4o-mini-transcribe |
| `gpt-4o-mini-transcribe-2025-12-15` | gpt-4o-mini-transcribe 的日期化快照 | https://platform.openai.com/docs/api-reference/audio/createTranscription |
| `gpt-4o-transcribe-diarize` | 自带说话人分离的变体；输入 > 30 秒时必须设置 `chunking_strategy` | https://platform.openai.com/docs/api-reference/audio/createTranscription |

## 输入

### 支持的音频格式

`flac, mp3, mp4, mpeg, mpga, m4a, ogg, wav, webm`

> 文件上传当前限制为 25 MB。
> 来源：https://platform.openai.com/docs/guides/speech-to-text

### 长音频处理

> 当 `chunking_strategy=auto`，服务端会先做响度归一，再用 VAD 选择切分边界；不设则整段转写。`gpt-4o-transcribe-diarize` 输入 > 30 秒时必须设置该参数。
> 来源：https://platform.openai.com/docs/api-reference/audio/createTranscription

## 请求参数

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `file` | file | 是 | 音频文件对象（非文件名） |
| `model` | string | 是 | 见上表 |
| `language` | string | 否 | 输入音频语种（ISO-639-1） |
| `prompt` | string | 否 | 用于提示术语 / 拼写纠正。**whisper-1 只考虑 prompt 最后 224 token**，更早的内容会被忽略 |
| `response_format` | string | 否 | whisper-1：`json / text / srt / verbose_json / vtt`；gpt-4o-transcribe / gpt-4o-mini-transcribe：仅 `json / text` |
| `temperature` | number | 否 | 采样温度 |
| `timestamp_granularities[]` | array | 否 | `segment` 或 `word` 或两者都；启用后输出结构化时间戳，需配合 `verbose_json`（仅 whisper-1） |
| `stream` | boolean | 否 | 流式输出；仅 `gpt-4o-transcribe` / `gpt-4o-mini-transcribe` 系列支持，whisper-1 不支持 stream（详见下） |
| `chunking_strategy` | string / object | 否 | `auto` 或自定义 |
| `include[]` | array | 否 | 控制是否返回 `logprobs` 等附加字段 |

来源：https://platform.openai.com/docs/api-reference/audio/createTranscription

## 输出

### `json`（默认）

```json
{ "text": "..." }
```

### `verbose_json`（仅 whisper-1）

包含 `language`, `duration`, `segments[]`，启用 `timestamp_granularities=["word"]` 时还含 `words[]`。
来源：https://platform.openai.com/docs/guides/speech-to-text

### 流式输出

`stream=true` 时返回 SSE，事件类型 `transcript.text.delta` / `transcript.text.done`。**仅 gpt-4o-transcribe / gpt-4o-mini-transcribe 支持**。
来源：https://platform.openai.com/docs/api-reference/audio/createTranscription（"Only emitted when you create a transcription with the Stream parameter set to true"）

## Prompt 参数（hints）

> 可用 `prompt` 传入正确拼写、专有名词、风格指令。Whisper 只考虑 prompt 最后 224 token。
> 来源：https://platform.openai.com/docs/guides/speech-to-text、https://platform.openai.com/docs/api-reference/audio/createTranscription

## 支持的语种

官方 guide 列出 whisper 支持 50+ 语种（含中文、英文、日文、韩文、德语、法语、西语、葡语、俄语、阿拉伯语等）。具体清单见 guide 页 "Supported languages" 段：
https://platform.openai.com/docs/guides/speech-to-text

> gpt-4o-transcribe / gpt-4o-mini-transcribe 据官方说明在多语种 WER 上优于 whisper。
> 来源：https://platform.openai.com/docs/models/gpt-4o-transcribe

## 计费

按音频时长（per-minute）。具体单价见：
- 官方 pricing：https://openai.com/api/pricing/
- 历史价位：whisper-1 约 $0.006/min；gpt-4o-mini-transcribe ≈ $0.003/min；gpt-4o-transcribe ≈ $0.006/min（以 pricing 页为准）

## 受限页面

- `https://platform.openai.com/docs/guides/speech-to-text` — fetch 返回 403（Cloudflare / bot 拦截），事实通过 WebSearch 摘要 + 多次结果交叉确认。
- `https://platform.openai.com/docs/api-reference/audio/createTranscription` — 同上。
