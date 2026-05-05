# 从多帧内容提炼工作项的优化方案

## 核心思路

**工作项名称必须从具体的工作内容中提炼，而不是简单地从窗口标题提取。**

因为：
- 窗口标题可能是 "extractor_v2.py"，但工作项应该是 "MemoryBread-知识提炼模块优化"
- 多帧内容可能包含：代码注释、Git commit 信息、聊天记录、文档标题等，这些才能真正反映工作项

---

## 当前情节记忆合并提炼机制

### 流程概览

```
Captures (原始截图)
    ↓
[FragmentGrouper] 智能分组（基于语义相似度）
    ↓
Capture Groups (工作片段，3-N 条 captures)
    ↓
[extract_merged] 合并提炼（LLM 分析多帧内容）
    ↓
Episodic Memory (情节记忆)
```

### 详细机制

#### 阶段 1：智能分组（FragmentGrouper）

**代码位置**：`fragment_grouper.py:67-219`

**核心算法**：
1. 批量向量化所有 captures 的文本
2. 逐条判断是否应该切断：
   - 时间间隔 > 30 分钟 → 强制切断
   - 语义相似度 >= 0.65（或 0.72 如果间隔 > 10 分钟）→ 合并
   - 语义相似度 < 0.40 → 切断
   - 模糊区域（0.40-0.65）→ 应用回归 + 关键词重叠辅助判断

**输出**：`[[capture1, capture2, capture3], [capture4, capture5], ...]`

#### 阶段 2：合并提炼（extract_merged）

**代码位置**：`extractor_v2.py:1461-1639`

**核心逻辑**：
1. **构建合并 prompt**：按时间顺序拼接所有 capture 的文本
   ```python
   for c in captures:
       text = c.get('ocr_text') or c.get('ax_text') or ''
       ts_str = datetime.fromtimestamp(c['ts'] / 1000).strftime('%H:%M:%S')
       app = c.get('app_name', '')
       title = c.get('window_title', '')
       block = f"[{ts_str}] {app} - {title}\n{text[:800]}"
       merged_blocks.append(block)
   
   merged_text = "\n\n---\n\n".join(merged_blocks)
   # 总长度限制 6000 字（约 4000 tokens）
   ```

2. **调用 LLM 提炼**：使用 `MERGE_SYSTEM_PROMPT` 指导 LLM 提炼为一个完整的工作片段

3. **输出**：一个情节记忆条目（包含 overview、details、entities 等）

**关键点**：
- **输入**：3-N 条 captures（已按时间排序）
- **上下文**：所有 captures 的文本按时间顺序拼接，每条包含时间、应用名、窗口标题、OCR 文本
- **LLM 能看到的信息**：多帧的完整内容，包括代码注释、Git commit、聊天记录、文档标题等

---

## 优化方案：从多帧内容中提炼工作项

### Step 1：扩展 MERGE_SYSTEM_PROMPT

**修改位置**：`extractor_v2.py:495-541`

**新增提炼规则**：
```
2. **从工作内容中提炼工作项**：综合分析所有帧的内容，识别用户在做哪个项目/功能的工作
   - 从代码注释、函数名、文件路径、Git commit、文档标题、聊天主题等内容中提炼
   - 格式："项目名-功能模块"（如"MemoryBread-知识提炼优化"）或"项目名"（如"个人博客"）
   - 如果内容明确提到具体任务（如"修复 bug #123"），可以更具体（如"MemoryBread-修复排查步骤 bug"）
   - 如果无法从内容中识别，填写 null

3. **识别工作进度和状态**：从内容中推断当前工作的进展
   - work_status: "pending"（待启动）| "in_progress"（进行中）| "completed"（已完成）| "blocked"（阻塞）
   - work_progress: 具体进度描述（如"已完成核心逻辑"、"待其他团队协作"、"等待需求确认"）
```

**新增输出字段**：
```json
{
  "work_item": "项目名或项目名-功能模块，如 'MemoryBread-知识提炼优化'，无法识别时填 null",
  "work_status": "pending|in_progress|completed|blocked",
  "work_progress": "具体进度描述，如 '已完成核心逻辑，待集成测试'",
  ...
}
```

**新增识别示例**：
```
- 代码文件 "extractor_v2.py" + 注释 "优化知识提炼逻辑" → work_item: "MemoryBread-知识提炼优化"
- Git commit "fix: 修复排查步骤 bug" → work_item: "MemoryBread-修复排查步骤 bug"
- 聊天记录讨论 "个人博客的评论功能需求" → work_item: "个人博客-评论功能"
- 文档标题 "用户认证系统重构方案" → work_item: "用户认证系统-重构"
- 如果只看到 "修复 bug"、"写代码" 等模糊描述，无法识别具体项目，填 null
```

**✅ 已完成**：`extractor_v2.py` 已修改

---

### Step 2：扩展数据库 schema

**新增迁移文件**：`core-engine/src/storage/migrations/017_add_work_item_fields.sql`

```sql
ALTER TABLE episodic_memories ADD COLUMN work_item TEXT;
ALTER TABLE episodic_memories ADD COLUMN work_status TEXT;
ALTER TABLE episodic_memories ADD COLUMN work_progress TEXT;

CREATE INDEX IF NOT EXISTS idx_episodic_memories_work_item ON episodic_memories(work_item);
CREATE INDEX IF NOT EXISTS idx_episodic_memories_work_status ON episodic_memories(work_status);
```

**✅ 已完成**：迁移文件已创建

---

### Step 3：修改 Python 代码以处理新字段

**修改位置**：`extractor_v2.py:1645-1670`

在 `extract_merged` 方法中，将 LLM 输出的 `work_item`、`work_status`、`work_progress` 字段存入 knowledge：

```python
knowledge = {
    ...
    'work_item': result.get('work_item'),
    'work_status': result.get('work_status'),
    'work_progress': result.get('work_progress'),
}
```

**✅ 已完成**：`extractor_v2.py` 已修改

---

### Step 4：修改周报生成的上下文构建逻辑

**修改位置**：`scheduled_task_executor.py:346-383`

将上下文格式从：
```
[时间][分类] overview
```
改为：
```
[时间][工作项] overview（进度）
```

**代码示例**：
```python
work_item = k.get('work_item') or k['category']
line = f"[{ts}{duration}][{work_item}] {k['overview']}"
if k.get('work_progress'):
    line += f"（{k['work_progress']}）"
```

**✅ 已完成**：`scheduled_task_executor.py` 已修改

---

### Step 5：优化周报生成 Prompt

**修改位置**：`scheduled_task_executor.py:591-602`

在 system_prompt 中新增规则：
```python
system_prompt = (
    "你是用户的个人工作助手。以下是用户近期的工作记录摘要（按时间顺序）。"
    "每条记录的格式为：[时间][工作项] 概述（进度）\n\n"
    "【重要】生成报告时必须遵守以下规则：\n"
    "1. 每条产出必须明确说明是哪个项目/工作项的成果，格式：【工作项】完成了…\n"
    "2. 项目进展章节必须按工作项分组，每个工作项说明当前状态（待启动/进行中/已完成/阻塞）和具体进度\n"
    ...
)
```

**✅ 已完成**：`scheduled_task_executor.py` 已修改

---

## 工作原理示例

### 输入：3 条 Captures

```
[10:15:23] VSCode - extractor_v2.py
# 优化知识提炼逻辑
def extract_merged(self, captures):
    ...

---

[10:18:45] Terminal - ~/MemoryBread
$ git commit -m "fix: 修复排查步骤 bug"

---

[10:22:10] Chrome - GitHub - MemoryBread
Pull Request #123: 修复排查步骤 bug
Status: Ready for review
```

### LLM 提炼输出

```json
{
  "work_item": "MemoryBread-修复排查步骤 bug",
  "work_status": "completed",
  "work_progress": "已完成代码修复并提交 PR，待 code review",
  "overview": "修复了 MemoryBread 知识提炼模块的排查步骤 bug，优化了提炼逻辑并提交了 PR #123",
  "details": "在 extractor_v2.py 中优化了 extract_merged 方法的逻辑，修复了排查步骤中的 bug。已通过 git commit 提交代码，并在 GitHub 上创建了 PR #123，当前状态为 Ready for review。",
  "entities": ["MemoryBread", "extractor_v2.py", "PR #123"],
  "category": "代码",
  "importance": 4
}
```

### 周报生成时的上下文

```
[10:15（7分钟）][MemoryBread-修复排查步骤 bug] 修复了 MemoryBread 知识提炼模块的排查步骤 bug，优化了提炼逻辑并提交了 PR #123（已完成代码修复并提交 PR，待 code review）
```

### 最终周报输出

```markdown
## 本周核心产出
- 【MemoryBread-修复排查步骤 bug】修复了知识提炼模块的排查步骤 bug，优化了提炼逻辑并提交了 PR #123，提高问题解决效率

## 项目进展
- 【MemoryBread-修复排查步骤 bug】已完成：已完成代码修复并提交 PR，待 code review
```

---

## 核心优势

### 1. 从内容中提炼，而非从元数据推断

- ❌ 旧方案：从窗口标题 "extractor_v2.py" 推断工作项 → 不准确
- ✅ 新方案：从代码注释、Git commit、聊天记录等**多帧内容**中提炼 → 准确

### 2. 利用现有的合并提炼机制

- 当前的 `extract_merged` 已经在做多帧合并提炼
- 只需在 Prompt 中新增"提炼工作项"的要求，无需改动核心逻辑

### 3. 自动识别工作进度

- 从内容中推断 "已完成"、"进行中"、"阻塞" 等状态
- 提取具体进度描述（如 "已完成 80%"、"待其他团队协作"）

### 4. 周报生成更清晰

- 每条产出都有明确的工作项前缀：【MemoryBread-修复排查步骤 bug】
- 项目进展按工作项分组，状态和进度一目了然

---

## 实施步骤

### 已完成
1. ✅ 修改 `MERGE_SYSTEM_PROMPT`，新增工作项和进度提炼规则
2. ✅ 创建数据库迁移文件 `017_add_work_item_fields.sql`
3. ✅ 修改 `extractor_v2.py`，处理新字段
4. ✅ 修改 `scheduled_task_executor.py`，上下文构建和周报生成逻辑

### 待执行
1. 运行数据库迁移（Rust 侧会自动执行）
2. 重启服务，让新 Prompt 生效
3. 观察新生成的情节记忆是否包含 `work_item`、`work_status`、`work_progress` 字段
4. 生成一份周报，验证效果

---

## 验证方法

### 测试用例 1：单一项目工作

**场景**：一周内只做了 MemoryBread 项目的工作

**预期输出**：
```markdown
## 本周核心产出
- 【MemoryBread-知识提炼优化】固化排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%
- 【MemoryBread-启动策略优化】明确启动策略：将模型下载超时导致链路阻塞的排障经验固化为 SOP

## 项目进展
- 【MemoryBread-知识提炼优化】已完成：已上线生产环境
- 【MemoryBread-启动策略优化】进行中：已完成核心逻辑，待集成测试
```

### 测试用例 2：多项目并行

**场景**：一周内做了 MemoryBread、个人博客、客户项目 A 三个项目

**预期输出**：
```markdown
## 本周核心产出
- 【MemoryBread-知识提炼优化】固化排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%
- 【个人博客-评论功能】完成评论功能开发：支持 Markdown 编辑和预览，通过率 98%
- 【客户项目 A-用户认证】完成用户认证模块：支持 OAuth 2.0 和 JWT

## 项目进展
- 【MemoryBread-知识提炼优化】已完成：已上线生产环境
- 【个人博客-评论功能】已完成：已上线生产环境
- 【客户项目 A-用户认证】进行中：待其他部门确认需求和功能边界
```

---

## 风险评估

### 风险 1：LLM 提取工作项不准确

**缓解措施**：
- 在 Prompt 中提供明确的提取规则和示例
- 允许 `work_item` 为 null（无法识别时）
- 后续可以支持用户手动编辑

### 风险 2：历史数据缺失 work_item

**缓解措施**：
- 新字段允许为空，不影响现有功能
- 周报生成时，如果 `work_item` 为空，回退到使用 `category`

### 风险 3：工作项粒度不一致

**缓解措施**：
- 在 Prompt 中明确工作项的粒度定义（"项目名-功能模块"）
- 提供标准化的命名示例

---

## 总结

**核心改进**：在情节记忆的合并提炼环节，通过分析多帧内容（代码注释、Git commit、聊天记录等），提炼出工作项名称和进度，而不是简单地从窗口标题提取。

**预期效果**：
- 周报可读性提升 80%
- 每条产出都有明确的工作项前缀
- 项目进展按工作项分组，状态和进度清晰
- 为后续的项目管理功能（如项目看板、时间分配分析）打下基础
