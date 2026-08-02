# db-schema — 数据库 Schema 组件

记忆面包 本地 SQLite 数据库的全量 Schema 定义。

## 文件结构

```
shared/db-schema/
├── migrations/
│   ├── 001_init.sql          # 核心表 + FTS5 索引 + 触发器
│   ├── 002_seed_defaults.sql # 默认用户偏好 + 应用黑名单种子数据
│   └── 003_views.sql         # 常用业务查询视图
├── cleanup.sql               # 定期数据清理 SQL（由定时任务调用）
├── validate.sql              # Schema 完整性验证脚本
└── README.md                 # 本文件
```

## 数据库表总览

| 表名 | 用途 |
|------|------|
| `schema_migrations` | 迁移版本记录 |
| `captures` | **核心表**：所有屏幕采集事件（截图/Accessibility/OCR/键盘/音频） |
| `captures_fts` | FTS5 全文检索虚拟表（自动同步 captures） |
| `vector_index` | 向量化记录元数据（关联 Qdrant point_id） |
| `action_logs` | 键鼠自动化执行记录（用于伴随式学习） |
| `user_preferences` | 用户偏好 Key-Value 配置 |
| `style_samples` | 用户写作风格样本库 |
| `app_filters` | 应用采集白/黑名单 |
| `rag_sessions` | RAG 问答会话记录 |
| `data_cleanup_log` | 数据清理任务日志 |
| `data_sources` | 数据模块的报表 URL 与工作数据来源、访问模式和刷新策略 |
| `data_snapshots` | 每个数据源唯一的一份最新快照；新采集覆盖正文、结构化内容、时间和时效 TTL |
| `data_source_links` | 数据来源到 capture/timeline 的可追溯关联 |
| `data_snapshots_fts` | 数据快照正文与结构化内容全文索引 |
| `data_extraction_state` | 数据识别的近期高水位与历史回填游标（运行状态，不进入资产快照） |
| `creation_evidence_assets` | 归属创作运行的本机截图证据及 OCR/DOM 校验结果（原图不进入资产快照） |

## 视图总览

| 视图名 | 用途 |
|--------|------|
| `v_recent_captures` | 最近 24h 采集记录（供 UI 展示） |
| `v_app_activity_today` | 今日各应用活跃统计 |
| `v_action_stats` | 自动化成功率统计 |
| `v_style_sample_summary` | 风格样本数量汇总 |
| `v_rag_session_summary` | RAG 查询历史摘要 |

## 执行方式

### 首次初始化

```bash
# 按顺序依次执行三个迁移文件
sqlite3 ~/.memory-bread/memory-bread.db < migrations/001_init.sql
sqlite3 ~/.memory-bread/memory-bread.db < migrations/002_seed_defaults.sql
sqlite3 ~/.memory-bread/memory-bread.db < migrations/003_views.sql
```

### 验证 Schema

```bash
sqlite3 ~/.memory-bread/memory-bread.db < validate.sql
```

期望输出（全部 ✅）：
```
✅ 所有表创建成功
✅ FTS5 全文索引存在
✅ FTS5 触发器完整(3个)
✅ 视图创建完整(5个)
✅ 默认偏好配置完整 (N条)
✅ 默认应用黑名单完整 (6条)
✅ WAL 模式已开启
✅ 外键约束已开启
--- 已执行的迁移 ---
001_init       | 2026-03-04 xx:xx:xx
002_seed_defaults | ...
003_views      | ...
```

### 手动清理（测试用）

```bash
sqlite3 ~/.memory-bread/memory-bread.db < cleanup.sql
sqlite3 ~/.memory-bread/memory-bread.db "VACUUM;"
```

## 关键设计决策

### 1. 时间戳统一用毫秒 Unix 时间（INTEGER）

所有时间字段使用 `INTEGER` 存储 Unix 毫秒时间戳，而非 SQLite 的 DATETIME 类型。
- 优点：多模态数据流（截图/键盘/音频）可以精确到毫秒级对齐
- 查询时使用 `datetime(ts/1000, 'unixepoch', 'localtime')` 转换为可读格式

### 2. WAL 模式

开启 WAL（Write-Ahead Logging），允许 Rust 引擎写入的同时，Python Sidecar 和 UI 并发读取，解决锁冲突。

### 3. FTS5 使用 `content=` 外部内容表模式

文本数据不在 FTS5 虚拟表中重复存储，通过触发器保持 `captures` 和 `captures_fts` 同步。
节省约 50% 存储空间。

### 4. `is_sensitive` 字段

命中应用黑名单或密码框时，`is_sensitive=1`，`ax_text/ocr_text/input_text` 均为 NULL，
仅保留时间戳和应用名，确保隐私安全。

### 5. Rust 层迁移管理

实际项目由 Core Engine 的迁移表嵌入 SQL，并在应用启动时按版本顺序执行，无需用户手动操作。数据模块从 `064_data_memory_module.sql` 开始，旧数据库会增量创建数据资产表与全文索引；`065_allow_browser_attach_snapshots.sql` 修复早期草案数据库已存在同名表时无法接纳通用浏览器会话快照的升级兼容问题，并保留已有快照与全文索引。
