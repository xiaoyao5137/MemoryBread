# 工作项提炼功能验证指南

## 已完成的修改

### 1. 情节记忆提炼（extractor_v2.py）
- ✅ 扩展 `MERGE_SYSTEM_PROMPT`，新增工作项和进度提炼规则
- ✅ 新增输出字段：`work_item`、`work_status`、`work_progress`
- ✅ 在 `extract_merged` 中处理新字段

### 2. 数据库 schema（017_add_work_item_fields.sql）
- ✅ 为 `episodic_memories` 表添加 3 个新字段
- ✅ 创建索引支持按工作项查询

### 3. 周报生成（scheduled_task_executor.py）
- ✅ 上下文格式改为：`[时间][工作项] 概述（进度）`
- ✅ system_prompt 要求按工作项分组展示进展

### 4. Bake 兼容（extractor_v2.py）
- ✅ 在 `_build_bake_candidate_text` 中添加工作项字段

---

## 验证步骤

### Step 1：重启服务，应用数据库迁移

```bash
./start.sh restart
```

**预期结果**：
- Rust 侧自动执行 `017_add_work_item_fields.sql` 迁移
- 日志中显示 "Applied migration 017_add_work_item_fields"

### Step 2：验证数据库 schema

```bash
sqlite3 <数据库路径> "PRAGMA table_info(episodic_memories);" | grep work_
```

**预期结果**：
```
work_item|TEXT
work_status|TEXT
work_progress|TEXT
```

### Step 3：等待新的情节记忆生成

**操作**：
1. 进行一些工作（如编写代码、查看文档、聊天讨论）
2. 等待 10-30 分钟，让系统自动提炼情节记忆

**验证**：
```bash
sqlite3 <数据库路径> "SELECT id, work_item, work_status, work_progress, overview FROM episodic_memories ORDER BY id DESC LIMIT 5;"
```

**预期结果**：
- 新生成的情节记忆中，`work_item` 字段有值（如 "MemoryBread-知识提炼优化"）
- `work_status` 为 "in_progress"、"completed" 等
- `work_progress` 有具体描述（如 "已完成核心逻辑"）

### Step 4：验证周报生成

**操作**：
1. 在 UI 中触发周报生成（或等待定时任务）
2. 查看生成的周报内容

**预期结果**：
```markdown
## 本周核心产出
- 【MemoryBread-知识提炼优化】完成了从多帧内容中提炼工作项的功能，提高周报可读性
- 【个人博客-评论功能】实现了评论发布和审核功能

## 项目进展
- 【MemoryBread-知识提炼优化】已完成：已完成核心逻辑并提交 PR
- 【个人博客-评论功能】进行中：已完成 80%，待前端集成
```

### Step 5：验证 Bake 兼容性

**操作**：
1. 等待 Bake 任务自动运行（或手动触发）
2. 查看生成的 SOP/Template/Knowledge

**预期结果**：
- 生成的 SOP 标题包含工作项名称（如 "MemoryBread-模型下载超时排查 SOP"）
- Bake 的输入上下文中包含 `work_item`、`work_status`、`work_progress` 字段

---

## 故障排查

### 问题 1：数据库迁移未执行

**症状**：查询 `episodic_memories` 表时，没有 `work_item` 字段

**解决**：
```bash
# 手动执行迁移
sqlite3 <数据库路径> < core-engine/src/storage/migrations/017_add_work_item_fields.sql
```

### 问题 2：新字段始终为空

**症状**：情节记忆中 `work_item` 字段为 NULL

**可能原因**：
1. LLM 无法从内容中识别工作项（内容太模糊）
2. LLM 输出的 JSON 中没有 `work_item` 字段

**排查**：
```bash
# 查看 LLM 调用日志
tail -f <日志路径> | grep "extract_merged"
```

### 问题 3：周报中工作项显示为分类

**症状**：周报中显示 `[代码]` 而不是 `[MemoryBread-知识提炼优化]`

**原因**：`work_item` 字段为空，fallback 到 `category`

**解决**：这是正常的 fallback 行为，说明 LLM 无法从内容中识别工作项

---

## 预期效果对比

### 优化前
```markdown
## 本周核心产出
- 固化排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%
- 明确启动策略：将模型下载超时导致链路阻塞的排障经验固化为 SOP

## 项目进展
- 待启动：待其他团队协作完成相关设计与开发工作
- 待启动：待其他部门确认需求和功能边界
```

**问题**：看不出是哪个项目的工作

### 优化后
```markdown
## 本周核心产出
- 【MemoryBread-排查步骤优化】固化排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%
- 【MemoryBread-启动策略优化】明确启动策略：将模型下载超时导致链路阻塞的排障经验固化为 SOP

## 项目进展
- 【MemoryBread-排查步骤优化】已完成：已形成 SOP 并验证有效
- 【MemoryBread-启动策略优化】进行中：待其他团队协作完成相关设计与开发工作
```

**改进**：每条产出和进展都明确说明了工作项

---

## 后续优化方向

### 1. 工作项标准化
- 建立工作项命名规范（如统一使用 "项目名-功能模块" 格式）
- 支持工作项别名（如 "MB" → "MemoryBread"）

### 2. 工作项关联
- 支持按工作项查询所有相关的情节记忆
- 生成工作项时间线（某个工作项从开始到完成的全过程）

### 3. 进度追踪
- 自动计算工作项完成度（基于多条情节记忆的进度描述）
- 识别长期阻塞的工作项并提醒

### 4. 上下文增强（长期）
- 在 Capture 阶段提取 Git 仓库名、浏览器 URL 等结构化信息
- 将这些信息传递给情节记忆提炼，提高工作项识别准确率
