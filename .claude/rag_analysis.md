# RAG 召回问题分析

## 问题描述
用户需求："生成一份分销团长的技术方案"
实际召回：LangBridge Claw SOP、灵机商品成片agent 等不相关文档

## 根本原因

### 1. 关键词提取过于宽泛（`_extract_keywords` 第599-609行）
```python
tokens = re.findall(r"[一-鿿A-Za-z0-9][一-鿿A-Za-z0-9_-]{1,}", text)
```
- 正则提取**所有**2字以上的中英文词，没有语义理解
- "分销团长技术方案" 会被拆成：["分销", "团长", "技术", "方案"]
- 每个单独的词都很泛化，容易误匹配

### 2. 召回策略过于宽松（`_query_document_rows` 第311-321行）
```python
keyword_clauses = []
for term in like_terms:
    pattern = f"%{term}%"
    keyword_clauses.append(
        "(title LIKE ? OR doc_type LIKE ? OR ... OR prompt_hint LIKE ?)"
    )
    params.extend([pattern] * 6)
if keyword_clauses:
    clauses.append("(" + " OR ".join(keyword_clauses) + ")")  # OR 连接！
```

**致命问题**：多个关键词用 OR 连接
- 只要文档包含 ["分销", "团长", "技术", "方案"] 中**任意一个**词就会被召回
- "LangBridge Claw SOP" 可能因为包含"技术"或"方案"被召回
- "灵机商品成片agent" 可能因为包含"agent"（技术相关）被召回

### 3. 相关性评分过于宽松（`_score_relevance` 第611-624行）
```python
hits = sum(1 for word in keywords if word and word in haystack)
score = (hits / max(len(keywords), 1)) * 0.75 + min(title_hits, 3) * 0.08
```
- 4个关键词只要命中1个，相关性就能达到 0.75 * 0.25 = 0.1875
- 基线太低，默认给 0.45 分（第618行）
- doc_type 匹配额外加 0.15 分，但 doc_type 也是泛化的（如"技术方案"）

## 推荐修复方案

### 短期修复（高优先级）
1. **改用 AND 连接关键词**
   - 要求至少匹配 N/2 个关键词（N为总关键词数）
   - 或使用 BM25/TF-IDF 计算真实相关性

2. **提高相关性阈值**
   - 只保留 relevance_score >= 0.5 的文档
   - 最终 final_weight 阈值从 0 提高到 0.3

3. **改进关键词提取**
   - 使用中文分词（jieba）而非简单正则
   - 过滤高频无意义词（技术、方案、文档等）
   - 保留短语（"分销团长"应作为整体）

### 中期优化（推荐）
1. **引入向量检索**
   - 使用 embedding 模型计算语义相似度
   - 结合向量相似度 (0.6) + 关键词匹配 (0.4)

2. **添加负反馈机制**
   - 记录用户点击"不相关"的文档
   - 动态降低这些文档的权重

3. **文档类型细化**
   - "技术方案"太宽泛，细化为"电商技术方案"、"AI技术方案"等
   - 在召回时强制匹配细分类型

## 代码修复示例

```python
# 修改 _query_document_rows 的关键词逻辑
keyword_clauses = []
for term in like_terms:
    pattern = f"%{term}%"
    keyword_clauses.append(
        "(title LIKE ? OR COALESCE(summary, '') LIKE ? OR COALESCE(full_content, '') LIKE ?)"
    )
    params.extend([pattern] * 3)

# 从 OR 改为 AND，至少匹配一半关键词
if keyword_clauses:
    min_matches = max(1, len(keyword_clauses) // 2)
    clauses.append(f"({' + '.join(keyword_clauses)}) >= {min_matches}")

# 修改 _score_relevance 提高阈值
hits = sum(1 for word in keywords if word and word in haystack)
score = (hits / max(len(keywords), 1))  # 移除 * 0.75
if score < 0.4:  # 相关度过低直接返回0
    return 0.0
```

## 立即行动项
1. ✅ UI层面：参考资料默认折叠，减少干扰
2. ⚠️ 后端修复：修改关键词OR逻辑为AND逻辑
3. ⚠️ 评分调优：提高相关性基线和阈值
4. 📋 长期规划：引入向量检索
