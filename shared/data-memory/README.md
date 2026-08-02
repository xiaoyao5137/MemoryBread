# 数据记忆与数据 Tool 契约

`data-tools.schema.json` 定义 MemoryBread 本地“数据”资产以及创作 Agent 可调用的两个稳定 Tool。

## 稳定 Tool ID

| Tool ID | 职责 | 隐私边界 |
| --- | --- | --- |
| `data_search` | 从本地数据模块召回数据源、最近快照、时效评分和来源证据 | 只读取本机 SQLite；事件中不返回原始正文 |
| `webpage_scrape` | 对 `data_search` 选中的数据源执行按需刷新 | 优先复用现有浏览器登录会话；不读取、复制或保存 Cookie |

日报、周报、项目总结和数据分析类任务可先用 `data_search` 探测是否存在相关数据，但不预置固定后续链路。所有候选（包括报表 URL）进入同一 Top-K 排序，不为 URL 预留名额；规范 URL 完全相同、标题完全相同只作为高强度相关性信号。Top-K 形成后，Harness 对其中的报表 URL 追加 `webpage_scrape`，在本轮创作中重新取数并生成截图证据；存在通过截图校验的报表数据或可分析工作快照时才追加 `data_analysis_agent`。

## 数据来源与时效

- `report_url`：报表、看板、监控和分析平台地址。默认 `refresh_policy=on_demand`、`access_mode=browser_session`，需要最新数据时不得只采用过期快照。
- `work_memory`：从文档、工作 IM、时间线和采集正文识别出的数据陈述。其事实时间未知时以 `observed_at` 作为时效下界，并随采集时间衰减。
- 工作数据必须同时具有数值和可命名的指标、对象或统计维度，并能独立回答“什么对象的什么指标、值是多少”。百分号或金额、资源等单位只表示值的形态，不能替代指标含义；`9类 43%`、`7类33%` 等孤立数字直接丢弃。日期、时刻、版本号、计划规模、参与人数、文件变更数、导航数量、评论计数，以及只出现“用户”“客户”“数据”等泛词的界面正文不是数据；人数、条数、集数和普通时长等通用量纲本身也不足以构成数据。候选句超过 280 字符或命中明显界面噪声时直接排除。
- 工作数据使用 `data-memory.v2` 提炼视图：`summary` 说明数据主题、比较或结论，`metric_rows` 以对象、指标、数值和说明组成表格。没有任何非空指标名时不生成该视图，也不进入列表或召回。
- `data_sources` 保存稳定数据项与刷新策略；每个来源在 `data_snapshots` 中只保留一份最新快照，新采集原位覆盖旧内容；`data_source_links` 保存到 capture/timeline 的可追溯关系。
- 后台识别首批从最新采集开始；后续批次为新增记录保留主要预算，并用剩余预算持续向历史记录回填。游标只记录采集 ID，不保存正文或 URL。
- 列表与 `data_search` 对历史 `work_memory` 快照执行同口径的 v2 兼容提炼，使旧版本误识别的界面正文或无语义数字不再展示、召回或计入分页总数；原快照仍留在本地以保留来源可追溯性。未采集报表通过单独的 `pending_items` 返回，不占用数据记录的页容量。
- 数据详情展示本地数据 ID 和来源时间线，并支持软删除数据来源；删除不会删除时间线或采集记录，自动识别也不会自行恢复已删除的数据。

## 网页采集策略

1. 登录态或内网报表优先附加来源浏览器或其他正在运行的受支持浏览器。当前支持 Google Chrome/Canary、Microsoft Edge、Brave、Chromium、Vivaldi 和 Safari。
2. 普通手动刷新仍可在后台临时标签读取 DOM。创作证据模式会临时激活报表标签，以操作系统通用窗口截图截取浏览器实际渲染像素；完成或失败后关闭临时标签、恢复原标签与原前台应用。该方案不调用任何 BI、文档或数据平台的导出能力。
3. 浏览器通道不可用、页面不依赖登录态时，普通刷新可降级为直接 HTTP 抓取；但创作截图必须来自浏览器实际渲染，因此证据模式不以 HTTP 文本代替截图。Firefox、Arc 等尚无 Apple Events DOM 适配器的浏览器当前只能使用公开页面 HTTP 通道，不能生成创作截图证据。
4. 只允许 `http`/`https` URL；不执行页面提供的脚本指令，不持久化 Cookie、Authorization header 或浏览器配置。
5. 页面正文和结构化表格覆盖本机最新数据快照；截图保存到本机创作证据目录，归属 `run_id`/`session_id`，不与会被覆盖的数据快照强绑定，也不进入加密资产快照。
6. Sidecar 对截图执行 OCR，并将 OCR 与同次 DOM/表格中的指标标签和数值逐项比对，同时核对 URL、标题和采集时间。只有校验通过的数值才进入写作环境；截图证据卡只插入实际使用该数值的段落或表格下方。校验失败时不插图，也不把报表旧值或未匹配值作为当前事实。

直接 HTTP 不读取浏览器会话。登录态通常不只依赖 Cookie，还可能依赖系统钥匙串加密、`localStorage`、临时令牌、SSO 跳转、客户端证书和页面 JavaScript 请求；复制这些凭据既不可靠，也会扩大泄露面。因此 HTTP 通道只用于无需登录的页面，登录态/内网页面交给浏览器在原安全上下文中加载。

## 稳定错误码

| 错误码 | 含义 | 可恢复方式 |
| --- | --- | --- |
| `DATA_SOURCE_NOT_FOUND` | 数据源不存在或已停用 | 重新执行数据识别或选择其他来源 |
| `DATA_SOURCE_URL_MISSING` | 数据源没有可刷新的网页地址 | 使用已有工作记忆快照 |
| `BROWSER_ATTACH_UNAVAILABLE` | 没有受支持浏览器正在运行，或系统自动化权限不可用 | 打开已登录的受支持浏览器并授权 MemoryBread 控制 |
| `BROWSER_SCRIPTING_DISABLED` | 浏览器禁止 Apple Events 执行 JavaScript | 开启对应浏览器的 Apple Events JavaScript 设置 |
| `SCRAPE_AUTH_REQUIRED` | 页面落在登录/鉴权页 | 在对应浏览器完成登录后重试 |
| `SCRAPE_EMPTY` | 页面没有可用正文或表格 | 检查页面加载状态或改用其他来源 |
| `SCRAPE_FAILED` | 两种采集通道均失败 | 保留旧快照并展示采集时间 |
| `EVIDENCE_CONTEXT_REQUIRED` | 创作截图缺少运行或会话身份 | 由 Creation Harness 补齐 `run_id`/`session_id` 后重试 |
| `SCREENSHOT_FAILED` | 页面已读取但浏览器窗口截图失败 | 检查系统录屏权限后重试 |
| `EVIDENCE_VALIDATION_FAILED` | 截图 OCR 与 DOM/表格或页面元数据不一致 | 不采用当前数值，改用其他证据或人工核验 |
| `DATA_SEARCH_UNAVAILABLE` | 本地数据索引暂时不可用 | Agent 基于其他记忆继续并标记数据缺口 |

## 兼容规则

- `data_search` 与 `webpage_scrape` 属于必备创作 Tool。旧客户端不传 `enabled_tools` 时，Core Engine 与 Sidecar 自动补齐。
- 新 Tool 只在 Harness 判断任务需要数据证据时进入候选计划，不影响普通创作的执行步数；`webpage_scrape` 与数据分析 Agent 是否执行由前一步反馈动态决定。
- 未识别字段必须被兼容读取方忽略；契约新增字段默认保持可选。
