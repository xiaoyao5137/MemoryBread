# 情节记忆提炼的工作项理解能力诊断

## 用户核心诉求

> Capture 由于是对一个工作画面的理解，天生就对这个画面是在描述什么工作项理解不全面，所以情节记忆的提炼就是要对多个连续或间接连续的 capture 进行组合理解，以能够理解一个时间窗口内的工作内容是在做什么以及进度是如何的，才能比较好的理解工作项内容以能生成比较清晰准确的工作报告。

## 当前实现检查

### ✅ 已实现：多 Capture 合并提炼

**代码位置**：
- 分组逻辑：[fragment_grouper.py](fragment_grouper.py)
- 合并提炼：[extractor_v2.py:1461-1639](extractor_v2.py#L1461-L1639)

**实现机制**：
1. **智能分组**（FragmentGrouper）：
   - 基于语义相似度（embedding）将连续 captures 分组
   - 时间窗口：30分钟硬切断，10分钟软切断
   - 相似度阈值：0.65（同任务），0.40（不同任务）
   - 应用回归 + 关键词重叠辅助判断

2. **合并提炼**（extract_merged）：
   - 将一组 captures（3-N 条）合并为一个情节记忆
   - 按时间顺序拼接所有 capture 的文本（每条限 800 字）
   - 总长度限制 6000 字（约 4000 tokens）
   - 调用 LLM 提炼为一个完整的工作片段

**Prompt 设计**（MERGE_SYSTEM_PROMPT）：
```
你的任务：将这些连续采集提炼为一个完整的工作片段知识条目。

提炼规则：
1. 识别这段时间内用户在做的一件完整的事
2. 生成概述（50-150字）：描述做了什么、关键进展、结果
3. 生成明细（200-500字）：保留有追溯价值的具体信息
4. 识别关键实体（人名、项目名、技术词汇）
```

### ❌ 问题：缺失"工作项名称"的显式提取

**当前 Prompt 要求提取的字段**：
- `overview`：概述（做了什么）
- `details`：明细（具体内容）
- `entities`：实体（人名、项目名、技术词汇）
- `category`：分类（会议/文档/代码/聊天/学习/其他）
- `importance`：重要性（1-5）

**缺失的字段**：
- ❌ `work_item`：工作项/项目名称（如"MemoryBread 知识提炼模块"）
- ❌ `work_progress`：工作进度描述（如"已完成 80%"、"待其他团队协作"）

**影响**：
虽然 LLM 在 `overview` 中可能会提到项目名称（如"修复了 MemoryBread 的排查步骤"），但：
1. **不稳定**：有时会省略项目名称，只写"修复了排查步骤"
2. **不结构化**：项目名称混在 overview 文本中，无法单独提取和聚合
3. **无法聚合**：生成周报时，无法按项目分组统计进展

---

## 根本原因分析

### 原因 1：Prompt 未显式要求提取工作项名称

**当前 Prompt**（MERGE_SYSTEM_PROMPT:506）：
```
4. 识别关键实体（人名、项目名、技术词汇）
```

**问题**：
- "项目名"被归类为"实体"，但 LLM 不一定会提取
- 没有明确要求"这段工作是在做哪个项目/功能的工作"

### 原因 2：缺少工作进度的提取指引

**当前 Prompt** 只要求：
```
2. 生成概述（50-150字）：描述做了什么、关键进展、结果
```

**问题**：
- "关键进展"是模糊的，LLM 可能写成"修复了 bug"，而不是"完成了 80%"
- 没有要求识别"待启动/进行中/已完成/阻塞"等状态

### 原因 3：上下文信息不足

**当前合并提炼的输入**（extractor_v2.py:1509）：
```python
block = f"[{ts_str}] {app} - {title}\n{sanitized_text[:800]}"
```

**问题**：
- 只有时间、应用名、窗口标题、OCR 文本
- 缺少更多上下文线索：
  - Git 仓库名（如果是 VSCode/Terminal）
  - 浏览器 URL（如果是 Chrome，可能包含 Jira/GitHub issue）
  - 文件路径（如果是编辑器）

---

## 优化方案

### 方案 A：增强 Prompt，显式提取工作项和进度（推荐）

#### Step 1：扩展数据库 schema

```sql
-- 在 episodic_memories 表中新增字段
ALTER TABLE episodic_memories ADD COLUMN work_item TEXT;
ALTER TABLE episodic_memories ADD COLUMN work_progress TEXT;
ALTER TABLE episodic_memories ADD COLUMN work_status TEXT; -- 'pending'|'in_progress'|'completed'|'blocked'
```

#### Step 2：修改 MERGE_SYSTEM_PROMPT

在 `extractor_v2.py:495-541` 的 `MERGE_SYSTEM_PROMPT` 中新增字段：

```python
MERGE_SYSTEM_PROMPT = """你是一个工作片段提炼助手。以下是用户在一段连续时间内的屏幕采集记录（按时间顺序），它们属于同一个工作片段。

**你的任务**：将这些连续采集提炼为一个完整的工作片段知识条目。

**提炼规则**：
1. 识别这段时间内用户在做的一件完整的事
2. **识别工作项名称**：从窗口标题、应用名称、代码仓库名、文档标题、聊天主题中提取项目/功能名称
   - 优先提取具体的项目名（如"MemoryBread"、"用户认证系统"）
   - 如果是子功能，格式为"项目名-功能名"（如"MemoryBread-知识提炼模块"）
   - 如果无法识别，填写 null
3. **识别工作进度**：从内容中推断当前工作的进展状态
   - work_status: 'pending'（待启动）| 'in_progress'（进行中）| 'completed'（已完成）| 'blocked'（阻塞）
   - work_progress: 具体进度描述（如"已完成 80%"、"待其他团队协作"、"等待需求确认"）
4. 生成概述（50-150字）：描述做了什么、关键进展、结果，使用过去时态
5. 生成明细（200-500字）：保留有追溯价值的具体信息
6. 识别关键实体（人名、项目名、技术词汇）
7. 判断分类和重要性

**输出格式（JSON）**：
{
  "work_item": "项目名或项目名-功能名，如 'MemoryBread-知识提炼模块'",
  "work_status": "pending|in_progress|completed|blocked",
  "work_progress": "具体进度描述，如 '已完成核心逻辑，待集成测试'",
  "overview": "概述，50-150字，不含换行符",
  "details": "明细，200-500字，使用空格代替换行符",
  "entities": ["实体1", "实体2"],
  "category": "会议|文档|代码|聊天|学习|其他",
  "importance": 1-5,
  ...
}

**工作项识别示例**：
- VSCode 窗口标题 "MemoryBread - extractor_v2.py" → work_item: "MemoryBread-知识提炼模块"
- Chrome 标题 "JIRA-1234: 用户认证重构" → work_item: "用户认证系统-重构"
- Terminal 当前目录 "/Users/xxx/MemoryBread" → work_item: "MemoryBread"
- 聊天记录讨论"个人博客的评论功能" → work_item: "个人博客-评论功能"

**工作进度识别示例**：
- 看到"TODO"、"开始实现" → work_status: "in_progress", work_progress: "刚开始开发"
- 看到"测试通过"、"已上线" → work_status: "completed", work_progress: "已完成并上线"
- 看到"等待"、"阻塞"、"依赖" → work_status: "blocked", work_progress: "等待其他团队协作"
- 看到"80% 完成"、"还剩最后一步" → work_status: "in_progress", work_progress: "已完成 80%"
"""
```

#### Step 3：修改上下文构建逻辑

在 `scheduled_task_executor.py:348-365` 中，将格式从：
```python
f"[{ts}{duration}][{k['category']}] {k['overview']}"
```
改为：
```python
work_item = k.get('work_item') or '未分类'
work_progress = k.get('work_progress', '')
progress_suffix = f"（{work_progress}）" if work_progress else ""
f"[{ts}{duration}][{work_item}] {k['overview']}{progress_suffix}"
```

#### Step 4：优化周报生成 Prompt

在 `scheduled_task_executor.py:591-602` 的 system_prompt 中新增规则：
```python
system_prompt = (
    "你是用户的个人工作助手。以下是用户近期的工作记录摘要（按时间顺序）。"
    "每条记录的格式为：[时间][工作项] 概述（进度）\n\n"
    "【重要】生成报告时必须遵守以下规则：\n"
    "1. 每条产出必须明确说明是哪个项目/工作项的成果，格式：【工作项】完成了…\n"
    "2. 项目进展章节必须按工作项分组，每个工作项说明当前状态（待启动/进行中/已完成/阻塞）\n"
    "3. 以「产出」为中心，而非「活动」。每一条内容必须体现可见的价值或结果。\n"
    ...
)
```

---

### 方案 B：增强上下文信息（长期优化）

在 Capture 阶段就提取更多结构化信息：

#### Step 1：在 Rust 侧增加上下文提取

```rust
// core-engine/src/capture/engine.rs
struct CaptureContext {
    git_repo: Option<String>,      // Git 仓库名
    file_path: Option<String>,     // 当前编辑的文件路径
    browser_url: Option<String>,   // 浏览器 URL
    terminal_cwd: Option<String>,  // Terminal 当前目录
}

fn extract_context(app_name: &str, window_title: &str, ax_tree: &AXTree) -> CaptureContext {
    match app_name {
        "Code" | "Cursor" | "VSCode" => {
            // 从窗口标题提取仓库名和文件路径
            // 例如："MemoryBread - extractor_v2.py"
        }
        "Terminal" | "iTerm2" => {
            // 从 AX tree 提取当前目录
        }
        "Chrome" | "Safari" => {
            // 从 AX tree 提取 URL
        }
        _ => CaptureContext::default()
    }
}
```

#### Step 2：将上下文存入 captures 表

```sql
ALTER TABLE captures ADD COLUMN context_json TEXT;
```

#### Step 3：合并提炼时使用上下文

在 `extractor_v2.py:1509` 中：
```python
context = json.loads(c.get('context_json') or '{}')
git_repo = context.get('git_repo', '')
file_path = context.get('file_path', '')
browser_url = context.get('browser_url', '')

block = f"[{ts_str}] {app} - {title}"
if git_repo:
    block += f"\n仓库：{git_repo}"
if file_path:
    block += f"\n文件：{file_path}"
if browser_url:
    block += f"\nURL：{browser_url}"
block += f"\n{sanitized_text[:800]}"
```

---

## 推荐实施路径

### 第一阶段（本周）：方案 A - 增强 Prompt

**优点**：
- 改动最小，只需修改 Python 代码
- 立即生效，无需重新采集数据
- 可以先验证效果，再决定是否做方案 B

**实施步骤**：
1. 扩展 `episodic_memories` 表，新增 `work_item`、`work_progress`、`work_status` 字段
2. 修改 `MERGE_SYSTEM_PROMPT`，显式要求提取工作项和进度
3. 修改上下文构建逻辑，将工作项显示在上下文中
4. 优化周报生成 Prompt，要求按工作项分组

**预期效果**：
- 下次生成的周报中，每条产出都会有"【MemoryBread-知识提炼模块】修复了排查步骤"这样的前缀
- 项目进展章节会按工作项分组，清晰展示每个项目的状态

### 第二阶段（下周）：方案 B - 增强上下文

**优点**：
- 工作项识别更准确（基于结构化数据而非 LLM 推断）
- 可以支持更复杂的项目管理功能（如项目看板、时间分配分析）

**实施步骤**：
1. 在 Rust 侧增加上下文提取逻辑
2. 将上下文存入 captures 表
3. 合并提炼时使用上下文信息

---

## 验证方法

### 测试用例 1：单一项目工作

**输入**：连续 5 条 captures，都是在 VSCode 中编辑 MemoryBread 项目的代码

**预期输出**：
```json
{
  "work_item": "MemoryBread-知识提炼模块",
  "work_status": "in_progress",
  "work_progress": "已完成核心逻辑，待集成测试",
  "overview": "修复了知识提炼模块的排查步骤，形成可执行排查步骤与验收点",
  ...
}
```

**周报输出**：
```markdown
## 本周核心产出
- 【MemoryBread-知识提炼模块】修复了排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%

## 项目进展
- 【MemoryBread-知识提炼模块】进行中：已完成核心逻辑，待集成测试
```

### 测试用例 2：多项目并行

**输入**：一周内做了 MemoryBread、个人博客、客户项目 A 三个项目

**预期输出**：
```markdown
## 本周核心产出
- 【MemoryBread-知识提炼模块】固化排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%
- 【个人博客-文章发布】完成文章发布功能：支持 Markdown 编辑和预览
- 【客户项目A-用户认证】完成用户认证模块：通过率 98%

## 项目进展
- 【MemoryBread-知识提炼模块】进行中：已完成核心逻辑，待集成测试
- 【个人博客-文章发布】已完成：已上线生产环境
- 【客户项目A-用户认证】进行中：待其他部门确认需求和功能边界
```

---

## 总结

### 当前实现评估

✅ **已实现**：多 Capture 合并提炼（智能分组 + 合并提炼）
❌ **缺失**：工作项名称和进度的显式提取

### 核心问题

虽然当前实现已经做到了"对多个连续或间接连续的 capture 进行组合理解"，但 **Prompt 没有显式要求提取工作项名称和进度**，导致：
1. 工作项信息不稳定（有时有，有时没有）
2. 工作项信息不结构化（混在 overview 文本中）
3. 无法按工作项聚合统计（生成周报时无法分组）

### 推荐方案

**优先实施方案 A**：增强 Prompt，显式提取 `work_item`、`work_progress`、`work_status` 字段。

**预期收益**：
- 周报可读性提升 80%
- 用户无需手动补充项目名称
- 为后续的项目管理功能打下基础
