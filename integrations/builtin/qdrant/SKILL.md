---
name: qdrant
description: Preview and import text-bearing Qdrant point exports from local JSON or JSONL files with stable point identity and payload metadata.
---

# Qdrant 导出导入

## 支持结构

读取本地 JSON/JSONL 导出，不连接远程 Qdrant，不接收 API Key。支持数组、`points`、`result.points` 和逐行 point；正文依次从 `payload.text`、`payload.content`、`payload.document`、`page_content` 等字段识别。

## 映射

- 来源键：point `id`，缺失时使用文件相对路径和记录序号
- 标题：payload 的 `title`/`name`，缺失时使用来源键
- 正文：常见 text/content/document/page_content 字段
- 元数据：保留 payload、collection 提示与原始来源路径，不保留向量数组

## 工作流

先 `preview` 验证可解析记录、缺正文记录与稳定 ID，再 `execute` 增量写入本地记忆库。相同来源键和内容哈希不会重复创建。

## 安全

所有处理在本机完成；日志只记录数量、阶段和错误码，不记录正文、payload 内容或凭据。
