---
name: chroma-pgvector
description: Import portable Chroma or pgvector JSON, JSONL, and CSV exports through explicit local field discovery and incremental document identity.
---

# Chroma / pgvector 通用导入

## 支持结构

读取常见 `documents`、`metadatas`、`ids` 并行数组，也支持对象数组、JSONL 和 CSV。正文识别 `document`、`text`、`content`、`page_content` 字段，来源键优先使用 `id`/`uuid`。

## 工作流

1. 解析文件并发现正文、标题、ID 与元数据字段。
2. 预检返回可导入、缺正文和重复来源键数量。
3. 正式执行把确认内容写入本机知识库。
4. 复跑时按来源键和内容哈希完成幂等增量更新。

## 隐私与失败处理

不连接数据库，不要求连接串。解析失败只在本机日志记录文件序号和错误码，不记录数据内容。
