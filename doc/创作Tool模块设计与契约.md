# 创作 Tool 模块设计与契约

## 目标

创作模块通过独立的“工具”Tab 管理 Agent 在创作过程中的可调用能力。Tool 与 Skill 分工如下：

- Tool 执行检索、代码生图等动作，把结果写回本轮创作环境。
- Skill 约束文档结构、行文、标题和图示风格。
- Agent 根据用户意图和已开启 Tool 动态生成执行计划，不因 Tool 已开启就无条件调用。

## 内置 Tool

| Tool ID | 名称 | 安装策略 | 调用条件 | 数据边界 |
| --- | --- | --- | --- | --- |
| `internet_search` | 互联网检索 Tool | 默认安装、始终开启 | 任务涉及最新信息、政策、标准、行业/市场调研等 | 只使用公开网页摘要与 URL，不记录 prompt |
| `memory_search` | 记忆搜索 Tool | 默认安装、始终开启 | 每轮创作优先召回本地参考 | 本地执行，原始记忆不因 Tool 调用自动上传 |
| `plantuml_diagram` | PlantUML 画图 Tool | 用户选择安装和开启 | 任务明确要求架构图、流程图、时序图等 | 输出可编辑的 PlantUML 代码 |
| `github_search` | GitHub 检索 Tool | 用户选择安装和开启 | 任务涉及 GitHub、公开仓库、开源或技术选型 | 只检索公开仓库，不读取或存储 GitHub Token |

## 请求契约

桌面 UI 向 `POST /api/creation/agent/run` 发送：

```json
{
  "enabled_tools": [
    "internet_search",
    "memory_search",
    "plantuml_diagram"
  ]
}
```

完整 JSON Schema 位于 `shared/creation-tools/creation-tools.schema.json`。

兼容规则：

1. `enabled_tools` 为新增字段，旧客户端不传时由 Core Engine 和 Sidecar 补齐两个必备 Tool。
2. 即使客户端传空数组或遗漏必备 Tool，服务端仍补齐 `internet_search` 与 `memory_search`。
3. 旧字段 `enable_rag`、`enable_web_search` 暂时保留；新客户端以 `enabled_tools` 为准。
4. Tool ID 在 Core Engine 转发时只做去重，不删除未知 ID；旧 Sidecar 忽略不认识的 ID，允许后续灰度扩展。

## 执行与可观察性

Agent 计划中的每次 Tool 调用都产生 `creation.agent.v1` 事件：

- `tool.started`：Tool 开始执行。
- `tool.completed`：Tool 完成，`data.result_count` 或 `data.diagram_type` 描述结果规模。
- `tool.failed`：Tool 暂时不可用，`data.error_code` 返回稳定错误码；Agent 使用已有上下文继续创作。

执行结果写回环境：

- 记忆搜索：`references`
- 互联网检索：`web_results`
- GitHub 检索：`github_results`
- PlantUML：`plantuml_diagram`

文档撰写 Agent 只消费必要摘要和公开链接，不把 Tool 密钥、供应商信息或本地记忆正文写入日志。

## 页面行为

- “工具”页沿用“技能”页的扁平页头、状态标签、白底卡片和底部按钮组，不展示额外介绍框或调用链。
- 必备 Tool 展示“官方工具”和“始终开启”，安装、开启状态不可修改。
- 可选 Tool 的“安装”和“开启”是两个独立按钮；安装后默认关闭，由用户明确开启，也可以关闭或卸载。
- 配置持久化在本机 `localStorage` 的 `memory-bread_creation_tools_v1`，不上传云端。
- 桌面端使用与技能页一致的自适应卡片网格，窄屏切换为单列；所有可操作控件提供键盘焦点状态。
