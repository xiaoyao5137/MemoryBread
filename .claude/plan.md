# 文档提炼去重与合并功能实施计划

## 目标
从时间线提炼到文档时：
1. 基于 `source_url` 判断是否已存在该文档
2. 若存在，调用 LLM 判断新内容是否已包含，并确定合理的插入位置
3. 支持文档-时间线双向跳转（复用当前 capture 跳转机制）
4. 保留完整原始内容（不被 LLM 精简）

## 技术方案

### 1. 数据库层扩展（Rust）

#### 1.1 新增查询函数
- **文件**: `core-engine/src/storage/repo/knowledge.rs`
- **新增**:
  ```rust
  pub fn find_document_by_source_url(&self, url: &str) -> Result<Option<BakeDocumentRecord>, StorageError>
  ```
  - 基于 `fragment_grouper.py::_document_identity()` 的逻辑，提取 URL 的文档标识
  - 查询 `bake_documents` 表中是否已存在该 `source_url` 对应的文档

#### 1.2 扩展文档创建/更新逻辑
- **文件**: `core-engine/src/storage/repo/knowledge.rs`
- **新增**:
  ```rust
  pub fn insert_or_merge_bake_document(&self, doc: &NewBakeDocument, timeline_id: i64) -> Result<i64, StorageError>
  ```
  - 先调用 `find_document_by_source_url` 检查是否存在
  - 若不存在，直接插入新文档
  - 若存在，返回已有文档 ID，由 `bake_service` 调用 sidecar 的 merge 接口

#### 1.3 关联关系存储
- **现状**: `bake_documents` 已有 `source_memory_ids`（JSON 数组）
- **扩展**: 
  - `source_memory_ids` 追加新的 timeline_id
  - `source_capture_ids` 合并新 timeline 的 capture_ids
  - `linked_knowledge_ids` 更新（如果 timeline 本身是 knowledge）

### 2. AI 提炼层（Python）

#### 2.1 去重与合并判断逻辑
- **文件**: `ai-sidecar/knowledge/extractor_v2.py`
- **函数**: `merge_bake_document(existing_document, candidate)` (已存在)
- **扩展**:
  1. 新增 `check_content_overlap` 步骤（在合并前调用 LLM）:
     - **输入**: 已有文档的 `full_content`，新 candidate 的 `capture_context` + `url_aggregated_text`
     - **输出**: JSON `{ "already_covered": true/false, "overlap_sections": [...], "new_parts": [...] }`
  2. 若 `already_covered=true` 且 `new_parts` 为空，返回 `no_change` 标记
  3. 若有新增内容，调用 LLM 判断插入位置:
     - **输入**: 已有文档的章节结构 + 新内容摘要
     - **输出**: JSON `{ "insert_mode": "append|insert_after|prepend", "target_section": "章节标题或索引", "merged_content": "..." }`

#### 2.2 原始内容保留
- **方案**: 在时间线的 `raw_content` 字段存储未经处理的原始拼接文本
- **实现位置**: `fragment_grouper.py::group_captures()`
  - 在生成 timeline 时，新增字段 `raw_content` = 所有 capture 的 `ax_text + ocr_text` 原始拼接（不做去重、不做清理）
- **文档层**: `bake_documents.full_content` 存储 LLM 提炼后的 Markdown，但在合并时参考 `url_aggregated_text`（已包含原始累计内容）

### 3. 业务层协调（Rust）

#### 3.1 bake_service 新流程
- **文件**: `core-engine/src/services/bake_service.rs`
- **修改点**: bake run 的文档提炼流程
  
**原流程**:
```
timeline(candidate) → sidecar.extract_bake_design() → insert_bake_document()
```

**新流程**:
```
1. timeline(candidate) → 提取 capture_url
2. find_document_by_source_url(url)
3. if 不存在:
     sidecar.extract_bake_design() → insert_bake_document()
   else:
     sidecar.merge_bake_document(existing, candidate) → update_bake_document()
```

#### 3.2 合并结果处理
- **返回值**: 
  ```rust
  enum MergeResult {
    NoChange,           // 内容已包含，无需更新
    Merged { updated_fields: ... }
  }
  ```
- **数据库更新**: 
  - 更新 `full_content`, `summary`, `updated_at`
  - 追加 `source_memory_ids`, `source_capture_ids`
  - 更新 `evidence_summary` 记录合并历史

### 4. 前端导航（TypeScript）

#### 4.1 复用现有机制
- **现状**: `BakePanel.tsx::handleOpenLink(url, sourceCaptureId)`
  - 通过 `setCaptureBackTarget` 存储返回点
  - 跳转到 `knowledge` 窗口的 `capture` tab
  - 显示指定的 capture 记录

#### 4.2 扩展到文档→时间线
- **新增**: `onOpenDocumentSourceTimeline(documentId, timelineId)`
  ```ts
  setTimelineBackTarget({
    windowMode: 'bake',
    bakeTab: 'templates',
    selectedTemplateId: documentId,
  })
  setBakeTab('overview')  // 或新增 'memories' tab
  setSelectedMemoryId(timelineId)
  ```

#### 4.3 UI 增强
- **文档详情页**（`BakeTemplatesTab`）:
  - 新增按钮："查看来源时间线"（如果 `source_memory_ids` 非空）
  - 点击后跳转到时间线列表并高亮第一个来源
- **时间线详情页**（`BakeMemoriesTab`）:
  - 已有"来源采集记录"按钮（跳转到 capture）
  - 对称新增："关联文档"按钮（如果该 timeline 已被提炼为文档）

### 5. LLM Prompt 设计

#### 5.1 去重判断 Prompt
```python
DEDUPE_CHECK_PROMPT = """你在检查一份新的 capture 内容是否已包含在现有文档中。

**已有文档** (full_content 片段，最多 5000 字):
{existing_content}

**新 capture 内容**:
{candidate_text}

**任务**:
1. 判断新内容是否已经被已有文档完全覆盖（即新内容是已有文档的某个片段或同义复述）
2. 如果有新增信息，列出具体的新增部分

**输出 JSON**:
{
  "already_covered": true/false,
  "overlap_ratio": 0.0-1.0,
  "new_parts": ["新增段落1", "新增段落2"],
  "reason": "判断理由"
}
"""
```

#### 5.2 插入位置判断 Prompt
```python
INSERT_POSITION_PROMPT = """你在决定新内容应该插入到已有文档的哪个位置。

**已有文档章节结构**:
{section_structure}

**新增内容摘要**:
{new_content_summary}

**任务**: 决定最合理的插入位置

**输出 JSON**:
{
  "insert_mode": "append|insert_after|prepend|replace_section",
  "target_section_index": 2,
  "target_section_title": "章节标题",
  "reason": "为什么插入到这里",
  "merged_full_content": "完整合并后的 Markdown 正文"
}
"""
```

## 实施步骤

### Phase 1: 数据库 & 存储层
1. ✅ 检查 `bake_documents.source_url` 字段（已存在）
2. 在 `knowledge.rs` 新增 `find_document_by_source_url`
3. 在 `knowledge.rs` 新增 `insert_or_merge_bake_document`
4. 单元测试

### Phase 2: AI 层去重逻辑
1. 在 `extractor_v2.py` 新增 `check_content_overlap` 方法
2. 扩展 `merge_bake_document` 增加去重判断
3. 新增插入位置判断逻辑
4. 测试 prompt 效果

### Phase 3: 业务层整合
1. 修改 `bake_service.rs` 的文档提炼流程
2. 新增 sidecar HTTP 接口调用 `merge_bake_document`
3. 处理合并结果并更新数据库
4. 集成测试

### Phase 4: 前端导航
1. 在 `BakeTemplatesTab` 新增"查看来源时间线"按钮
2. 在 `BakeMemoriesTab` 新增"关联文档"按钮（如果已提炼）
3. 扩展 `handleOpenLink` 支持双向跳转
4. 更新状态管理逻辑

### Phase 5: 原始内容保留
1. 在 `fragment_grouper.py` 生成 timeline 时新增 `raw_content` 字段
2. 在 `timelines` 表新增 `raw_content` 列（migration）
3. 确保 LLM 提炼时不精简该字段

## 关键技术点

### URL 文档标识提取
- 复用 `fragment_grouper.py::_document_identity(url)` 逻辑
- 在 Rust 侧实现相同逻辑或通过 HTTP 调用 Python 服务

### 去重判断阈值
- `overlap_ratio >= 0.85` 且 `new_parts` 为空 → 完全覆盖，不更新
- `overlap_ratio >= 0.50` → 部分覆盖，需要合并
- `overlap_ratio < 0.50` → 新内容为主，判断插入位置

### 失败降级
- LLM 去重判断失败 → 默认追加到文档末尾
- 插入位置判断失败 → 追加到末尾
- 合并后的 `full_content` 验证失败（如格式错误）→ 保留原文档，记录日志

## 风险与注意事项

1. **URL 匹配准确性**: 
   - 同一文档的不同 URL 可能无法识别（如带参数、锚点）
   - 需要通过 `_document_identity` 的标准化逻辑缓解

2. **LLM 调用成本**:
   - 每次提炼都需额外 2 次 LLM 调用（去重 + 插入位置）
   - 可通过缓存优化：如果 `url_aggregated_text` 无变化，跳过去重

3. **合并后内容质量**:
   - LLM 可能产生格式不一致的 Markdown
   - 需要在 `merge_bake_document` 后验证输出格式

4. **原始内容膨胀**:
   - `raw_content` 字段会随时间累积大量数据
   - 建议设置长度上限（如 50K 字符）或定期归档

## 测试用例

### 用例 1: 首次提炼
- **输入**: 新 timeline（来自一份 Google Doc）
- **预期**: 创建新文档，`source_url` 记录

### 用例 2: 完全重复
- **输入**: 用户再次浏览同一文档的相同部分
- **预期**: `check_content_overlap` 返回 `already_covered=true`，不更新文档

### 用例 3: 部分新增
- **输入**: 用户查看文档的新章节
- **预期**: LLM 判断插入位置，合并到已有文档

### 用例 4: 导航测试
- **输入**: 从文档点击"查看来源时间线"
- **预期**: 跳转到时间线详情，可返回文档

### 用例 5: 原始内容保留
- **输入**: capture 包含大量噪声文本
- **预期**: `raw_content` 保留原始文本，`full_content` 仅包含提炼后的 Markdown
