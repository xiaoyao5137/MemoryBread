# 创作 Skill 模块设计与自测

## 1. 目标与范围

创作 Skill 用于把一篇既有文档沉淀成可复用的写作方法。首期覆盖两类来源：

- 方案创作记录；
- Bake 中已经生成的完整文档。

用户点击“沉淀 Skill”后，MemoryBread 在本机分析文档，自动产出并持久化可编辑的 Skill 草稿。草稿包含抽象用途标题、适用场景与目标、常见标题、标题风格、内容文本风格、画图风格、常见结构和写作规则；六类内容各自包含“字段名 + 用途说明”的两层标题与脱离原文的 few-shot 示例，并额外生成一份使用全新虚构主题的完整 Markdown 示例文档。系统同时根据原文自动推荐完整四级创作类目。用户显式保存后，Skill 才从草稿转为已保存；已保存 Skill 默认不安装，可由用户安装、用于创作或公开到创作市场。

## 2. 核心流程

1. 用户从方案创作结果、创作记录或 Bake 文档点击“沉淀 Skill”。
2. Core Engine 将原文只转发给本机 Creation Sidecar。
3. Sidecar 优先使用本地文本模型生成结构化分析；提示词要求所有字段通用化、逐字段生成独立示例并生成完整示例文档。本地模型不可用时使用确定性启发式分析，且不会把源标题或原章节直接写入兜底结果。
4. 分析界面展示确定性百分比进度；分析结果立即以 `draft` 状态自动保存，后续编辑也会防抖保存。
5. 用户在编辑器中修改所有字段、二级说明标题、逐字段示例和完整示例文档，并确认系统推荐的完整四级类目。Skill 的任何字段都只能描述可复用方法，禁止带入具体公司、部门、事业部、团队、项目、产品、系统、客户、人员、日期、指标或金额。
6. 用户点击“保存 Skill”后状态变为 `saved`，此时仍为未安装；只有已保存 Skill 可以安装。
7. 创作指令框输入 `@` 可以选择已安装 Skill；未显式选择时，客户端也会根据指令与 Skill 的适用场景、目标、常见标题和类目动态匹配。
8. 命中的 Skill 会把标题、场景目标、完整类目、文本/标题/画图风格、结构、写作规则、逐字段示例和完整示例文档注入本次真实生成请求。示例只作为 few-shot 学习结构与表达，不允许照抄示例主题；Skill 只约束写法，不虚构业务事实。
9. 用户在“创作 Skill”页点击“发布”时，客户端才把当前结构化 Skill 上传到市场；发布成功后操作切换为“取消发布”，下架后仍保留本地 Skill 和云端幂等标识，之后可以重新发布。
10. 客户端内置 Skill 市场，直接调用公开列表接口搜索、分页、查看详情并安装，不要求跳转官网。安装只下载市场已经公开的结构化 Skill 内容，并以 `source_kind=market` 保存为本地只读来源副本。
11. 编辑器只负责修改和保存用户从本地文档沉淀的 Skill，不提供发布入口；已发布 Skill 编辑后，需要回到“创作 Skill”页再次点击“发布”来更新市场版本。市场来源副本不显示编辑或发布操作，避免把其他作者的 Skill 当作本人作品更新。

## 3. 四级类目模型

产品描述中的“一二级行业、三级工种、四级具体分类”实际对应四级树，因此实现按四级建模：

| 级别 | 含义 | 示例 |
| --- | --- | --- |
| 一级 | 行业 | 互联网、金融、制造、医疗健康、教育、建筑地产、农林牧渔等 20 类 |
| 二级 | 细分行业 | 电商零售、云计算与 AI、医院与基层医疗、工程建设、航空运输等 94 类 |
| 三级 | 工种/角色 | 产品经理、架构师、临床医师、工程项目经理、科研人员等 199 类 |
| 四级 | 具体文档类型 | 产品需求文档、临床诊疗路径、施工组织设计、科研项目研究方案等 375 类 |

服务端只接受启用状态的第四级叶子类目。类目使用稳定 `key` 和 UUID，新增类目通过扩展迁移完成。客户端保留同 ID 的完整离线目录，云端接口不可用时仍能选择和自动推荐类目。

## 4. 数据边界与隐私

本模块遵循 Local First：

- 原文、来源类型、来源 ID、草稿/保存/安装状态保存在本地；
- 从市场安装时，本地只保存公开 Skill 的结构化内容、云端 Skill ID 和 `market` 来源，不保存作者私有来源信息；
- 分析请求只访问本机 Core Engine 和本机 Sidecar；
- 首次发布后，云端只接收标题、简介、四级叶子类目和结构化 Skill 内容；
- 发布请求不包含原文、来源 ID、来源类型、本地引用、模型名、供应商密钥或模型成本；
- 提炼后会检查明显组织线索和大段原文重合；命中时使用安全通用兜底，不把可疑值写入 Skill；
- 客户端离线兜底不会使用源文档标题，也不会直接复制源章节名；章节只归并为“背景与目标”“总体方案”“实施计划”等通用角色；
- Admin API 发布校验会以 `SKILL_CONTENT_NOT_GENERALIZED` 拒绝仍含具体组织线索、日期或指标的内容或示例；
- 服务端 `POST /v1/creation-skills` 拒绝 `published=false`，防止客户端误把私有草稿上传；
- 公开列表和详情只查询 `published_at is not null` 且未删除的数据；
- Outbox 审计事件只记录 Skill ID 和作者用户 ID，不复制内容。

本地 Skill 已纳入 MemoryBread 资产快照，跨设备恢复时可恢复 Skill 生命周期；公开状态由 `cloud_skill_id` 和本地状态共同记录。旧快照没有 `status`/`installed` 字段时仍可兼容恢复。

## 5. 本地接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/api/creation/skills/analyze` | 在本机分析来源文档 |
| `GET` | `/api/creation/skills` | 获取本地 Skill；可按 `source_kind` + `source_id` 或 `installed` 筛选 |
| `POST` | `/api/creation/skills` | 新建本地 Skill（分析流程写入 `draft`） |
| `GET` | `/api/creation/skills/:id` | 获取本地 Skill 详情 |
| `PUT` | `/api/creation/skills/:id` | 更新草稿、保存、安装或公开状态 |
| `DELETE` | `/api/creation/skills/:id` | 软删除未公开的本地 Skill |

## 6. 云端接口

| 方法 | 路径 | 权限 | 说明 |
| --- | --- | --- | --- |
| `GET` | `/v1/creation-skill-categories` | 公开 | 获取全部启用类目 |
| `GET` | `/v1/creation-skills` | 公开 | 搜索、类目筛选和分页 |
| `GET` | `/v1/creation-skills/:id` | 公开 | 获取已发布详情 |
| `GET` | `/v1/me/creation-skills` | 登录 | 获取当前作者的 Skill |
| `POST` | `/v1/creation-skills` | 登录 | 首次公开；按作者和本地 key 幂等 |
| `PUT` | `/v1/creation-skills/:id` | 作者 | 编辑、重新公开或下架 |

主要业务错误码：

- `CREATION_SKILL_PUBLISH_REQUIRED`：首次提交未确认公开；
- `INVALID_CLIENT_SKILL_KEY`：本地幂等标识不合法；
- `INVALID_SKILL_TITLE` / `INVALID_SKILL_SUMMARY`：标题或简介不合法；
- `INVALID_SKILL_CONTENT`：结构化内容不完整或超长；
- `SKILL_CONTENT_NOT_GENERALIZED`：字段或示例仍包含具体组织线索、日期或指标，需要改写为通用表达；
- `INVALID_SKILL_CATEGORY`：类目不存在或已停用；
- `SKILL_CATEGORY_NOT_LEAF`：没有选择第四级具体文档类型；
- `CREATION_SKILL_NOT_FOUND`：详情不存在、未公开或不属于当前作者。
- `CREATION_SKILL_MARKET_INITIALIZING`：服务已部署但市场表尚未迁移；公开读取返回空市场，写操作返回可识别的 503。

## 7. 页面与交互

桌面端：

- 方案创作结果和每条创作记录都提供“沉淀 Skill”；
- Bake 文档详情提供“沉淀 Skill”；
- Bake 文档和方案创作结果都会展示按来源查询到的关联 Skill，点击默认打开只读详情，需要修改时再从管理卡片进入编辑器；
- 创作面板增加“创作 Skill”页签，集中管理草稿、已保存、安装与发布状态；卡片标题和“查看详情”都能打开完整只读详情；已安装 Skill 的操作显示为“卸载”，已保存 Skill 可直接点击“发布”进入创作市场，已发布 Skill 显示“取消发布”，草稿禁止安装和发布；
- “Skill 市场”子页提供客户端内搜索、分页、作者与完整类目展示、详情预览和安装操作；已安装项明确显示状态并禁止重复安装；
- 编辑器展示“正在本机分析文档写法”的阶段文案、确定性百分比进度条、自动草稿状态、四级级联选项卡和全部可编辑内容，只保留保存操作；六个字段沿用官网的两层标题，其中“常见标题”的二级标题固定为“这类文档标题通常怎么命名”；每个字段下展示并允许编辑脱离原文的示例，末尾展示完整示例文档；
- 创作输入框支持 `@` 已安装 Skill 选择器，并展示“@ 已选择”或“自动匹配”的本次使用标签；
- 已发布 Skill 在桌面端暂不提供删除操作，避免官网出现失去作者控制的孤儿内容。

官网：

- 导航增加“创作市场”；
- `/creation-skills` 提供专题头图、搜索、四级类目筛选和 Skill 卡片；
- `/creation-skills/[id]` 展示作者昵称、完整类目路径、两层标题、逐字段示例及完整示例文档；
- 页面使用服务端动态渲染，发布或下架后无需重新构建站点。
- Admin API 与官网兼容“官网先于数据库迁移完成”的部署窗口：此时展示正常空态，不再显示“创作市场暂时无法读取”。

## 8. 自测记录

截至 2026-07-23 已完成：

| 范围 | 命令 | 结果 |
| --- | --- | --- |
| Admin 合约与 API 单测 | `cargo test -p mb-admin-api creation_skill -- --nocapture` | 通过，5 项 |
| Core Engine Skill 单测 | `cargo test --manifest-path core-engine/Cargo.toml --lib creation_skill -- --nocapture` | 通过，5 项，含市场来源、本地幂等与安装筛选 |
| 本地资产快照恢复 | `cargo test --manifest-path core-engine/Cargo.toml --lib asset_snapshot_excludes_raw_capture_payloads_and_imports_idempotently -- --nocapture` | 通过，Skill 可幂等恢复 |
| Sidecar 分析测试 | `PYTHONPATH=ai-sidecar/.venv/lib/python3.14/site-packages:ai-sidecar:shared/ipc-protocol/python python3 -m pytest ai-sidecar/tests/test_creation_skill.py -q` | 通过，5 项，含组织名去除、数字细节去除和标题归一化 |
| 桌面端完整 Vitest 回归 | `npm test -- --run` | 通过，39 个文件、214 项 |
| 安装/发布/详情/市场/@ 交互测试 | `npm test -- --run src/__tests__/CreationPanelSkills.test.tsx` | 通过，4 项；取消发布、只读详情、客户端市场搜索安装、安装后选择和生成请求注入均通过 |
| 分析进度/自动草稿测试 | `npm test -- --run src/__tests__/CreationSkillEditor.test.tsx` | 通过，2 项；进度百分比、自动草稿、显式保存、默认未安装及编辑器无发布入口均通过 |
| 桌面端生产构建 | `npm run build` | 通过 |
| 官网 Vitest 回归 | `npm test -- --run` | 通过，3 个文件、10 项 |
| 官网生产构建 | `npm run build` | 通过 |
| 运行态本机模型验收 | Core → Sidecar 真实分析请求 | 带“商业化研发中心/电商产品部”的原文最终标题为“跨部门技术沟通会文档”，类目关键词自动生成 |
| 桌面端浏览器验收 | 运行中的 Core + Admin API + 桌面页面 | 已发布卡片显示“取消发布”；只读详情在宽屏和窄屏下正常；市场搜索返回真实公开 Skill；无浏览器控制台错误 |
| 官网浏览器验收 | 运行中的 Admin API + 官网 | 市场表未迁移时返回 200 空市场，页面展示品牌空态，不再出现“创作市场暂时无法读取” |

发布边界测试会解析真实请求体，并断言不存在 `source_id`、`source_kind`、`document_content` 或本地来源值。

Core Engine 全集成测试当前会被仓库已有的 `tests/api_tests.rs` 编译问题阻断：该文件引用了已不存在的 `NewKnowledgeEntry` 和 `insert_knowledge_entry`。新增 Skill 的库级测试与生产编译均已单独通过，该既有问题不在本模块改动范围内。

## 9. 部署顺序

1. 部署 `0024_creation_skills.sql` 创建类目与 Skill 表，再部署 `0025_expand_creation_skill_categories.sql` 写入完整行业目录。
2. 部署 Admin API，验证公开列表、详情和鉴权写接口。
3. 部署官网，开放“创作市场”入口。
4. 发布带有本地迁移 `049_create_creation_skills.sql`、`050_add_creation_skill_lifecycle.sql`、`051_expand_creation_skill_examples.sql`、`052_add_creation_skill_market_source.sql` 的 MemoryBread 客户端与 Sidecar。

按此顺序部署时，新服务端对旧客户端保持兼容；新客户端只有在用户主动公开时才依赖新云端接口。即使官网/Admin API 先部署，公开读接口也会返回空市场而不是数据库错误；迁移完成前写接口会明确返回 503，避免误报成未知保存失败。
