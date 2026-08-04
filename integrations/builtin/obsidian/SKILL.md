---
name: obsidian
description: Preview and incrementally import an Obsidian Markdown vault into the local MemoryBread knowledge store while preserving paths, tags, frontmatter, and wiki-link relationships.
---

# Obsidian 本地导入

## 能力边界

本 Skill 只读取用户在文件选择器中明确选择的 Vault 文件。正文和元数据通过 `127.0.0.1` 交给本机 Core Engine，不连接 Obsidian 云服务，也不把 Vault 内容写入执行日志。

## 输入

- UTF-8 Markdown：`*.md`、`*.markdown`
- 相对路径：用于保留 Vault 目录关系和增量身份
- 采集记录标题使用 Markdown 文件名（不含扩展名），不读取正文标题
- 可选附件仅统计，不进入知识正文
- 自动忽略 `.obsidian/`、隐藏目录和不受支持的二进制文件

## 执行工作流

1. `preview`：扫描文件，解析 YAML frontmatter、行内标签、`[[Wiki Link]]` 与 `![[Embed]]`，返回条目和关系统计，不写数据库。
2. `execute`：以“Skill + 相对路径”为稳定来源键，以 SHA-256 为内容版本写入本机。
3. 正文和标题均未变化时记为 `unchanged`；正文或标题变化只更新对应条目。
4. 每篇笔记生成一条可检索 Capture 和一条已验证 Timeline，来源标记为 `integration_import:obsidian`。

## 输出

- `created`、`updated`、`unchanged`、`skipped` 数量
- 标签、双链、嵌入和目录统计
- 可审计运行状态与脱敏日志

## 验收

同一 Vault 连续导入两次时，第二次不得重复创建；修改一篇笔记后，只允许该来源键更新一次。
