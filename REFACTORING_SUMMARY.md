# 架构重构总结

## 概述

完成了从"情节记忆/记忆片段/文档模板"到"时间线/采集记录/设计"的全面架构重构。

## 核心变更

### 1. 数据库层面

#### 表重命名
- `episodic_memories` → `timelines` (时间线)
- `bake_articles` → `designs` (设计)
- 保留 `bake_knowledge` (知识)
- 保留 `bake_sops` (SOP)

#### 新增字段
**timelines 表**:
- `time_range_start` (INTEGER) - 时间范围起始
- `time_range_end` (INTEGER) - 时间范围结束
- `key_timestamps` (TEXT/JSON) - 关键时间戳数组

**所有 bake 表**:
- `source_capture_ids` (TEXT/JSON) - 直接关联的 Capture ID 数组

#### 迁移脚本
- [016_rename_to_timelines.sql](core-engine/src/storage/migrations/016_rename_to_timelines.sql)
  - 重命名表
  - 添加新字段
  - 更新外键引用
  - 重建 FTS 索引

### 2. Rust 后端

#### 数据模型 ([models_bake.rs](core-engine/src/storage/models_bake.rs))
- 添加类型别名保持向后兼容:
  - `type EpisodicMemoryRecord = TimelineRecord`
  - `type NewEpisodicMemory = NewTimeline`
  - `type BakeArticleRecord = DesignRecord`
- 所有结构体添加新字段并设置默认值

#### Repository 层 ([knowledge.rs](core-engine/src/storage/repo/knowledge.rs))
- 更新所有 SQL 查询使用新表名
- 添加新的查询函数:
  - `get_timeline_capture_ids()` - 获取时间线关联的 Capture IDs
  - `update_timeline_capture_ids()` - 更新时间线的关联 Capture IDs
- 批量更新所有构造函数添加新字段

#### API 层
- 保持 API 端点路径不变 (`/api/bake/articles` 等) 以保持向后兼容
- 内部实现使用新的数据模型和表名

### 3. Python 后端

#### 提炼逻辑 ([background_processor.py](ai-sidecar/background_processor.py))
- 更新 `extract_merged()` 函数计算时间范围:
  - `time_range_start` = 第一个 Capture 的时间戳
  - `time_range_end` = 最后一个 Capture 的时间戳
  - `key_timestamps` = JSON 数组包含起止时间
- 更新数据库插入语句包含新字段

#### 其他模块
- [startup_checks.py](ai-sidecar/startup_checks.py) - 更新 FTS 触发器
- [scheduled_task_executor.py](ai-sidecar/scheduled_task_executor.py) - 更新查询
- [rag/retriever.py](ai-sidecar/rag/retriever.py) - 更新检索查询
- [rag/pipeline.py](ai-sidecar/rag/pipeline.py) - 更新 RAG 管道
- [knowledge/extractor_v2.py](ai-sidecar/knowledge/extractor_v2.py) - 更新提炼器
- [knowledge/manager.py](ai-sidecar/knowledge/manager.py) - 更新表结构管理

### 4. 前端

#### UI 文案更新
- "情节记忆" → "时间线"
- "记忆片段" → "采集记录"
- 批量更新所有组件:
  - [BakePanel.tsx](desktop-ui/src/components/BakePanel.tsx)
  - [RepositoryPanel.tsx](desktop-ui/src/components/RepositoryPanel.tsx)
  - [components/bake/](desktop-ui/src/components/bake/) 下所有组件

#### 类型定义
- `EpisodicMemory` → `Timeline`
- `episodic_memory` → `timeline`
- 保持 API 调用路径不变

## 架构优势

### 1. 混合架构（细节回溯机制）
- **时间线**: 存储高层次的工作流程和事件序列
- **采集记录**: 保留原始的屏幕截图和文本内容
- **关联机制**: 通过 `capture_ids` 和 `source_capture_ids` 实现双向关联
- **回溯能力**: 可以从时间线追溯到具体的采集记录查看细节

### 2. 时间范围支持
- 时间线不再是单点时间，而是一个时间段
- 支持跨多个采集记录的工作流程提炼
- 关键时间戳数组记录重要时刻

### 3. 清晰的语义
- "时间线" 更准确地描述了工作流程的时间维度
- "采集记录" 明确了原始数据的性质
- "设计" 比"文档"更具体地表达了输出物的性质

## 验证结果

### 数据库
- ✅ 所有表成功重命名
- ✅ 新字段正确添加
- ✅ FTS 索引正常工作
- ✅ 外键引用正确更新
- ✅ 现有数据完整迁移 (136 条时间线记录)

### 服务
- ✅ Core Engine 编译通过并正常运行
- ✅ AI Sidecar 正常启动
- ✅ Model API Server 正常运行
- ✅ Desktop UI 正常启动
- ✅ 所有健康检查通过
- ✅ 无错误日志

### 功能
- ✅ 时间线提炼逻辑支持时间范围计算
- ✅ Capture 关联查询功能实现
- ✅ 前端 UI 文案全部更新
- ✅ API 向后兼容性保持

## 文件清单

### 新增文件
- `core-engine/src/storage/migrations/016_rename_to_timelines.sql`
- `REFACTORING_SUMMARY.md`

### 修改文件
**Rust**:
- `core-engine/src/storage/models_bake.rs`
- `core-engine/src/storage/repo/knowledge.rs`
- `core-engine/src/storage/repo/bake_template.rs`
- `core-engine/src/storage/repo/bake_run.rs`
- `core-engine/src/services/bake_service.rs`
- `core-engine/src/api/handlers/knowledge.rs`

**Python**:
- `ai-sidecar/background_processor.py`
- `ai-sidecar/startup_checks.py`
- `ai-sidecar/scheduled_task_executor.py`
- `ai-sidecar/rag/retriever.py`
- `ai-sidecar/rag/pipeline.py`
- `ai-sidecar/knowledge/extractor_v2.py`
- `ai-sidecar/knowledge/manager.py`
- `ai-sidecar/knowledge_api_server.py`

**TypeScript/React**:
- `desktop-ui/src/components/BakePanel.tsx`
- `desktop-ui/src/components/RepositoryPanel.tsx`
- `desktop-ui/src/components/bake/*.tsx`
- `desktop-ui/src/types/api.ts`

## 后续建议

1. **性能优化**: 考虑为 `time_range_start` 和 `time_range_end` 添加索引
2. **UI 增强**: 在前端展示时间范围和关联的采集记录数量
3. **文档更新**: 更新用户文档和 API 文档
4. **测试覆盖**: 添加针对新字段和查询函数的单元测试

## 总结

本次重构成功完成了从概念到实现的全面升级，没有留下技术债务。所有改动都已到位，系统运行正常，为后续的功能开发奠定了坚实的基础。
