---
name: milvus
description: Preview and import local Milvus or Zilliz entity exports while retaining primary keys, scalar metadata, and source provenance.
---

# Milvus / Zilliz 导出导入

## 支持结构

读取 JSON、JSONL 或 CSV 的 entity 导出。支持顶层数组、`data`、`entities`、`rows`；正文从 `text`、`content`、`document`、`page_content` 等常见字段识别。

## 映射与增量

优先使用 `id`、`pk`、`primary_key` 作为稳定来源键。向量字段不写入知识正文；其余标量字段保存在来源元数据中。执行前可预检，正式执行按 SHA-256 内容哈希增量创建或更新。

## 输出

返回解析、创建、更新、未变化和跳过数量；每次运行保存状态、阶段日志和错误信息。

## 安全

本 Skill 不连接 Milvus/Zilliz 服务，不保存 Token，只处理用户主动选择的本地导出文件。
