# 创作 Tool 契约

`creation-tools.schema.json` 定义创作模块传给 Core Engine 与 AI Sidecar 的稳定 Tool ID 和 Tool 事件形态。

## 兼容规则

- `enabled_tools` 是新增的可选请求字段；旧客户端不传时，Core Engine 与 Sidecar 都补齐 `internet_search`、`memory_search`。
- `internet_search`、`memory_search` 是必备 Tool，客户端不得卸载或关闭，服务端收到空数组时也必须补齐。
- 可选 Tool 当前包括 `plantuml_diagram`、`github_search`。未安装或未开启时不得进入 Agent 计划。
- 未识别的 Tool ID 保留在转发契约中，但旧 Sidecar 不调用，以便新客户端与旧服务兼容。
- `enable_rag`、`enable_web_search` 暂时保留供旧客户端兼容；新客户端以 `enabled_tools` 为准。

## 错误码

| 错误码 | 含义 |
| --- | --- |
| `TOOL_NOT_INSTALLED` | 请求调用尚未安装的可选 Tool |
| `TOOL_DISABLED` | Tool 已安装但当前关闭 |
| `TOOL_UNAVAILABLE` | Tool 的本地或外部依赖暂时不可用 |
| `TOOL_EXECUTION_FAILED` | Tool 已启动但执行失败 |

Tool 失败通过 `creation.agent.v1` 的 `tool.failed` 事件返回，不得在日志或事件中写入用户原始 prompt、密钥或本地记忆正文。
