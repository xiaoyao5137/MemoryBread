# 工作记录生成优化方案：增强工作项理解

## 问题根源

当前生成的周报中，"本周核心产出"和"项目进展"描述不清楚是哪个工作项，导致可读性差。

**根本原因**：整个知识提炼链路（Capture → 情节记忆 → 周报生成）中，**没有提取和传递"工作项/项目名称"信息**。

## 三阶段诊断

### 阶段 1：情节记忆提炼（extractor_v2.py）
**问题**：`SYSTEM_PROMPT` 只要求提取 `overview`、`details`、`category`、`entities`，**没有要求提取工作项名称**。

**影响**：情节记忆中只有"修复了排查步骤"、"明确启动策略"等动作，但不知道是哪个项目的工作。

### 阶段 2：上下文构建（scheduled_task_executor.py）
**问题**：构建上下文时格式为 `[时间][分类] overview`，只有 `category`（如"开发"），没有项目名称。

**影响**：传给 LLM 的上下文缺失工作项信息。

### 阶段 3：LLM 生成周报（scheduled_task_executor.py）
**问题**：虽然 system_prompt 要求"以产出为中心"，但输入上下文本身就缺失工作项信息，LLM 无法推断。

**影响**：生成的周报中无法明确说明是哪个项目的进展。

---

## 优化方案（分阶段实施）

### 方案 A：最小改动方案（推荐优先实施）

**核心思路**：在情节记忆提炼时，从 `entities` 或 `overview` 中提取"工作项名称"，存入新字段 `work_item`。

#### 实施步骤

**Step 1：扩展数据库 schema**
```sql
-- 在 episodic_memories 表中新增字段
ALTER TABLE episodic_memories ADD COLUMN work_item TEXT;
```

**Step 2：修改情节记忆提炼 prompt（extractor_v2.py）**

在 `SYSTEM_PROMPT` 中新增字段要求：
```python
# 在 extractor_v2.py 的 SYSTEM_PROMPT 中添加
"""
- work_item: 工作项/项目名称（如"MemoryBread 知识提炼模块"、"用户认证系统重构"）
  - 优先从窗口标题、应用名称、代码仓库名、文档标题中提取
  - 如果无法识别，填写 null
"""
```

**Step 3：修改上下文构建逻辑（scheduled_task_executor.py）**

在 `_build_context` 方法中，将格式从：
```python
f"[{ts}{duration}][{k['category']}] {k['overview']}"
```
改为：
```python
work_item = k.get('work_item') or '未分类'
f"[{ts}{duration}][{work_item}] {k['overview']}"
```

**Step 4：优化 LLM 生成 prompt**

在 system_prompt 中明确要求：
```python
"5. 每条产出必须明确说明是哪个项目/工作项的成果，格式：【项目名】完成了…"
```

#### 优点
- 改动最小，只需修改 3 个文件
- 不需要重新提炼历史数据
- 对现有流程影响小

#### 缺点
- 依赖 LLM 从 OCR 文本中准确提取工作项名称
- 历史数据的 `work_item` 字段为空

---

### 方案 B：增强方案（长期优化）

**核心思路**：在 Capture 阶段就识别工作项，通过窗口标题、应用名称、Git 仓库等信息自动推断。

#### 实施步骤

**Step 1：在 Capture 阶段增加工作项识别**
```rust
// 在 core-engine/src/capture/engine.rs 中
// 从窗口标题、应用名称、Git 仓库等推断工作项
fn infer_work_item(window_title: &str, app_name: &str) -> Option<String> {
    // 规则示例：
    // - VSCode 窗口标题包含仓库名 → 提取仓库名
    // - Chrome 标题包含 Jira/GitHub issue → 提取 issue 号
    // - Terminal 当前目录 → 提取目录名
}
```

**Step 2：将 work_item 存入 captures 表**
```sql
ALTER TABLE captures ADD COLUMN work_item TEXT;
```

**Step 3：情节记忆提炼时继承 work_item**

在合并多个 captures 时，选择出现频率最高的 work_item。

#### 优点
- 工作项识别更准确（基于结构化数据而非 LLM 推断）
- 可以支持更复杂的工作项管理（如关联 Jira、GitHub issue）

#### 缺点
- 改动较大，需要修改 Rust 代码
- 需要维护工作项识别规则

---

### 方案 C：后处理方案（临时应急）

**核心思路**：在生成周报时，通过 LLM 二次处理，为每条产出补充工作项信息。

#### 实施步骤

在 `_llm_generate` 方法中，增加一个后处理步骤：
```python
# 第一次调用：生成初稿
draft = llm_generate(context, user_instruction)

# 第二次调用：补充工作项信息
refined_prompt = f"""
以下是一份工作周报初稿，但每条产出没有明确说明是哪个项目的工作。
请根据上下文中的线索（窗口标题、应用名称、代码仓库等），为每条产出补充【项目名】前缀。

初稿：
{draft}

上下文：
{context}
"""
final_report = llm_generate(refined_prompt)
```

#### 优点
- 无需修改数据库和提炼逻辑
- 可以立即生效

#### 缺点
- 增加 LLM 调用次数（成本和延迟）
- 依赖 LLM 推断，可能不准确

---

## 推荐实施路径

### 第一阶段（本周完成）：方案 A
1. 扩展 `episodic_memories` 表，新增 `work_item` 字段
2. 修改情节记忆提炼 prompt，要求提取工作项名称
3. 修改上下文构建逻辑，将 `work_item` 显示在上下文中
4. 优化周报生成 prompt，要求明确说明工作项

**预期效果**：下次生成的周报中，每条产出都会有"【MemoryBread】修复了排查步骤"这样的前缀。

### 第二阶段（下周规划）：方案 B
1. 在 Capture 阶段增加工作项识别逻辑
2. 将 work_item 存入 captures 表
3. 情节记忆提炼时继承 work_item

**预期效果**：工作项识别更准确，支持更复杂的项目管理场景。

---

## 验证方法

### 测试用例 1：单一项目工作
**输入**：一周内只做了 MemoryBread 项目的工作
**预期输出**：
```markdown
## 本周核心产出
- 【MemoryBread】固化排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%
- 【MemoryBread】明确启动策略：将模型下载超时导致链路阻塞的排障经验固化为 SOP
```

### 测试用例 2：多项目并行
**输入**：一周内做了 MemoryBread、个人博客、客户项目 A 三个项目
**预期输出**：
```markdown
## 本周核心产出
- 【MemoryBread】固化排查步骤：形成可执行排查步骤与验收点，提高问题解决效率 122%
- 【个人博客】完成文章发布功能：支持 Markdown 编辑和预览
- 【客户项目 A】完成用户认证模块：通过率 98%

## 项目进展
- 【MemoryBread】进行中：待其他团队协作完成相关设计与开发工作
- 【个人博客】已完成：已上线生产环境
- 【客户项目 A】进行中：待其他部门确认需求和功能边界
```

---

## 风险评估

### 风险 1：LLM 提取工作项不准确
**缓解措施**：
- 在 prompt 中提供明确的提取规则和示例
- 允许用户手动编辑 work_item 字段
- 记录提取失败的案例，持续优化 prompt

### 风险 2：历史数据缺失 work_item
**缓解措施**：
- 新字段允许为空，不影响现有功能
- 可以编写脚本对历史数据进行批量补充（可选）

### 风险 3：工作项粒度不一致
**缓解措施**：
- 在 prompt 中明确工作项的粒度定义（如"项目级"而非"任务级"）
- 提供标准化的工作项命名规范

---

## 总结

**核心问题**：情节记忆提炼时没有提取工作项名称，导致周报生成时无法明确说明是哪个项目的工作。

**推荐方案**：优先实施方案 A（最小改动），在情节记忆提炼时提取 work_item 字段，并在上下文构建和周报生成时使用。

**预期收益**：
- 周报可读性提升 80%
- 用户无需手动补充项目名称
- 为后续的项目管理功能（如项目看板、时间分配分析）打下基础
