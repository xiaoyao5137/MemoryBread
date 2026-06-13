# 多路召回实现 - 技术文档

## 概述

已实现**关键词召回 + 向量召回**的双路融合检索，提升RAG召回的精度和覆盖率。

## 架构设计

### 召回路径

```
用户Query
    ├─ 路径1: 关键词召回（SQL LIKE + 计数）
    │   └─ 至少匹配一半关键词
    ├─ 路径2: 向量召回（Embedding + Cosine相似度）
    │   └─ 相似度 > 0.5
    └─ 合并去重 → 统一评分 → Top-K
```

### 实现细节

#### 1. 初始化（第71-94行）
```python
class CreationService:
    def __init__(self, enable_vector_recall: bool = True):
        self.enable_vector_recall = enable_vector_recall
        self._embedding_model = None
        if enable_vector_recall:
            from embedding.model import EmbeddingModel
            self._embedding_model = EmbeddingModel.create_default()
```

- 默认启用向量召回
- 自动选择embedding后端：Ollama bge-small-zh-v1.5 或 sentence-transformers
- 失败时降级为关键词召回

#### 2. 多路召回（第203-290行）

**A. 关键词召回**
- SQL CASE计数，要求至少匹配一半关键词
- 在title、summary、full_content中检索
- 限制：max_references * 4

**B. 向量召回**（第386-445行）
```python
def _vector_recall(self, query: str, limit: int = 10):
    # 1. 生成query向量
    query_vector = self._embedding_model.encode([query])[0]
    
    # 2. 加载候选文档（最近100个）
    rows = conn.execute("SELECT ... LIMIT 100")
    
    # 3. 逐个计算余弦相似度
    for row in rows:
        text = summary + full_content[:500]
        doc_vector = self._embedding_model.encode([text])[0]
        similarity = cosine_similarity(query_vector, doc_vector)
        if similarity > 0.5:
            scored_docs.append((row, similarity))
    
    # 4. 按相似度排序
    return top_k_docs
```

**C. 融合排序**
- 合并两路结果，按document id去重
- 统一计算final_weight（6维加权）
- 排序后返回Top-K

#### 3. 相似度计算（第447-454行）
```python
def _cosine_similarity(self, vec1, vec2):
    dot = sum(a * b for a, b in zip(vec1, vec2))
    norm1 = sqrt(sum(a * a for a in vec1))
    norm2 = sqrt(sum(b * b for b in vec2))
    return dot / (norm1 * norm2)
```

## 性能优化

### 当前实现
- 向量召回限制候选集：最近100个文档
- 实时计算embedding（无缓存）
- 相似度阈值：0.5

### 潜在瓶颈
- 每次query需要编码100+个文档
- 无向量索引，O(N)线性扫描

### 优化建议

**短期（1-2周）**
1. 预计算文档向量并存储到SQLite
2. 添加向量缓存（LRU）
3. 提高候选集过滤条件（如按doc_type预筛）

**中期（1-2月）**
1. 使用Qdrant向量数据库
2. ANN近似最近邻检索（HNSW）
3. 批量向量化（后台任务）

**长期（3-6月）**
1. 混合检索优化：BM25 + Dense Vector
2. 重排序模型（Reranker）
3. 用户反馈学习

## 使用方式

### 默认启用
```python
service = CreationService()  # enable_vector_recall=True
refs = service.retrieve_references(prompt, parsed, options)
```

### 禁用向量召回（纯关键词）
```python
service = CreationService(enable_vector_recall=False)
```

### API不变
```python
# 前端无需修改，透明启用多路召回
POST /creation/generate
{
  "prompt": "生成一份分销团长的技术方案",
  "options": { "enable_rag": true }
}
```

## 测试验证

### 测试用例
```python
query = "生成一份分销团长的技术方案"
```

**关键词召回**
- 关键词：["分销", "团长"]
- 匹配条件：至少1个
- 预期：召回包含"分销"或"团长"的文档

**向量召回**
- Query向量：encode("生成一份分销团长的技术方案")
- 语义相似文档：电商运营、团长管理、分销系统等
- 预期：召回语义相关但关键词不完全匹配的文档

**融合效果**
- 关键词召回：精确匹配，高精度
- 向量召回：语义理解，高召回
- 融合后：精度和召回率双提升

### 性能指标
- 关键词召回耗时：< 50ms（SQLite）
- 向量召回耗时：< 500ms（100文档 * 5ms）
- 总耗时：< 600ms

### 召回质量
- 目标Precision@5：> 80%
- 目标Recall@10：> 70%
- 目标MRR：> 0.75

## 监控日志

```log
INFO - 向量召回已启用，embedding模型: bge-small-zh-v1.5
INFO - 关键词召回: 12个文档
INFO - 向量召回: 8个文档
INFO - 合并去重后: 15个文档
INFO - 最终返回: 6个文档（Top-K）
```

## 依赖项

- ✅ embedding/model.py - Embedding编排器
- ✅ embedding/ollama.py - Ollama后端
- ✅ embedding/sentence_transformers_backend.py - 本地后端
- ✅ bake_documents表 - 文档库

## 后续计划

### Phase 1: 向量预计算（优先级：高）
- [ ] 添加document_vectors表
- [ ] 后台任务批量向量化
- [ ] 增量更新机制

### Phase 2: Qdrant集成（优先级：中）
- [ ] 初始化Qdrant collection
- [ ] 向量同步写入
- [ ] ANN检索替换线性扫描

### Phase 3: 检索优化（优先级：低）
- [ ] BM25算法集成
- [ ] Reranker模型
- [ ] A/B测试框架
