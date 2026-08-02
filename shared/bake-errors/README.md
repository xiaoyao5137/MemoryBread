# Bake Sidecar 错误契约

`/bake/extract` 与 `/bake/merge_document` 的非 2xx 响应必须符合
[`bake-error.schema.json`](bake-error.schema.json)，Core 同时校验 `code`、
`scope`、`retryable`，不允许只凭 HTTP 状态判断是否暂停整条流水线。

| 范围 | 错误码 | Core 行为 |
| --- | --- | --- |
| `service` | `INFERENCE_PREEMPTED`、`MODEL_RATE_LIMITED`、`MODEL_UNAVAILABLE` | 不消耗候选重试；等待整服务恢复 |
| `candidate`，可重试 | `INFERENCE_TIMEOUT`、`BAKE_OUTPUT_TRUNCATED`、`BAKE_OUTPUT_INVALID`、`BAKE_MODEL_RESPONSE_INVALID`、`BAKE_MODEL_UPSTREAM_ERROR`、`BAKE_INTERNAL_ERROR` | 记录候选失败；最多 3 次后进入终态并推进 watermark |
| `candidate`，不可重试 | `BAKE_MODEL_REQUEST_INVALID`、`BAKE_REQUEST_INVALID` | 当前候选立即进入终态并推进 watermark |

未知、缺字段或三元组冲突的 5xx 统一映射为
`BAKE_UNCLASSIFIED_UPSTREAM_ERROR`，按候选有界重试。Core 自己检测到的成功响应
损坏和产物结构错误分别使用 `BAKE_SIDECAR_RESPONSE_INVALID` 与
`BAKE_ARTIFACT_PAYLOAD_INVALID`，同样不得永久卡住队首。

