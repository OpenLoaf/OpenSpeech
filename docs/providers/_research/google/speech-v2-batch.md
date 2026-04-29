> 来源：官方文档 https://cloud.google.com/speech-to-text/v2/docs/batch-recognize ; https://cloud.google.com/speech-to-text/v2/docs/reference/rest/v2/projects.locations.recognizers/batchRecognize
> 抓取日期：2026-04-28

# Speech-to-Text V2 — Batch (异步) Recognize

## 1. Endpoint

- **REST**：`POST https://speech.googleapis.com/v2/projects/{project}/locations/{location}/recognizers/{recognizer}:batchRecognize`
- **gRPC**：`google.cloud.speech.v2.Speech.BatchRecognize`
- 返回 `google.longrunning.Operation`，需轮询 `operations.get`。

## 2. 关键约束

来源：https://cloud.google.com/speech-to-text/v2/docs/batch-recognize

- **音频必须放在 GCS**：`gs://bucket/object`。不接受 inline `content`。
- 每个请求 N 个 `BatchRecognizeFileMetadata`，每个对应一个音频文件。
- 输出有两种：`gcs_output_config`（写到 GCS）或 `inline_response_config`（结果直接随 Operation 完成时返回，**仅当只有 1 个 audio file 时可用**）。
- 长音频上限：单文件 ≤ **8 小时**（V2 实际值由文件解码后总时长决定，参考 quotas 页）。

## 3. BatchRecognizeRequest

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `recognizer` | string | recognizer 资源名。 |
| `config` | RecognitionConfig | 与 recognizer default 合并。 |
| `config_mask` | FieldMask | 覆盖 mask。 |
| `files[]` | BatchRecognizeFileMetadata | 每条 `{ uri: gs://..., config?, config_mask? }`。 |
| `recognition_output_config` | RecognitionOutputConfig | `gcs_output_config { uri }` 或 `inline_response_config {}`。 |
| `processing_strategy` | enum | `DYNAMIC_BATCHING` 等，影响吞吐/排队。 |

## 4. RecognitionOutputConfig

来源：https://docs.cloud.google.com/php/docs/reference/cloud-speech/latest/V2.RecognitionOutputConfig

- `gcs_output_config { uri: "gs://bucket/output-prefix/" }` — 将结果以 JSON 写入。
- `inline_response_config {}` — 完成后随 `BatchRecognizeResponse.results` 直接回填。
- `output_format_config` — 可选 `native` / `vtt` / `srt`。

## 5. BatchRecognizeResponse

- `results: map<string, BatchRecognizeFileResult>`，key 是输入文件 URI。
- 每个文件结果含：
  - `uri`（写出位置）或 `transcript`（inline 模式）。
  - `error`：单文件失败时的 google.rpc.Status。
  - `metadata.total_billed_duration`。

## 6. Operation 轮询

- LRO：`projects/{project}/locations/{location}/operations/{op_id}`。
- `metadata` 字段类型：`OperationMetadata`，含 `progress_percent`、`create_time`、`update_time`、`resource`（recognizer 名）。
- `response` 字段：完成时为 `BatchRecognizeResponse`。

## 7. 错误码

- 与 sync 相同；额外：`FAILED_PRECONDITION` (e.g. recognizer 状态非 ACTIVE)、`PERMISSION_DENIED` (GCS bucket 不可读 / 不可写)。

## 8. 抓取失败 / 待补

- 单文件最大时长「8 小时」是从公开 V2 文档的常见叙述提炼，正文确认请直接打开 https://cloud.google.com/speech-to-text/v2/quotas 复核。
