# RAG SSE 交互协议

悬浮球咨询通过 `POST /api/rag/stream` 建立 SSE 响应。请求体与现有
`POST /api/rag/jobs` 保持兼容，至少包含 `query` 和 `top_k`；客户端仍可在
不支持流式消费的场景使用旧的异步任务接口。

响应使用 `Content-Type: text/event-stream`。每个 `data:` 块都是 JSON 对象，
通过 `type` 区分事件：

| type | 关键字段 | 说明 |
| --- | --- | --- |
| `status` | `stage`、`message`、`progress` | 当前任务阶段和建议进度值 |
| `references` | `contexts` | RAG 召回结果；必须在答案生成前发送 |
| `delta` | `text` | 本次新增的答案文本，客户端按顺序追加 |
| `done` | `answer`、`contexts`、`model`、`elapsed_ms`、`inference_elapsed_ms` | 最终结果与耗时；客户端以 `answer` 校准累计文本 |
| `error` | `code`、`message` | 流建立后的终止错误 |

标准阶段顺序为 `queued` → `understanding`（按需）→ `retrieving` →
`references` → `waiting_generation`（推理资源繁忙时）→ `answering`。
`retrieving` 只覆盖本地参考资料检索，不得包含 LLM 队列等待或答案生成耗时。
`progress` 只用于界面反馈，不作为服务端完成度或计费依据。

在响应头发送前发生的参数、模型就绪或资源错误继续使用 HTTP `4xx/5xx`；
流建立后发生的错误使用 `error` 事件。服务端每 15 秒发送一次 keep-alive，
客户端必须忽略注释行和未知事件类型。

协议事件、日志和错误详情不得包含用户问题正文、回答正文以外的内部路由信息，
也不得暴露供应商模型名、供应商密钥或购买成本。客户端只消费稳定的品牌模型
标识。
