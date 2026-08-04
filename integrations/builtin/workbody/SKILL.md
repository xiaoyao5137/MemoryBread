---
name: workbody
description: Build a minimal local Markdown context pack from relevant MemoryBread memories for deliberate use in a Workbody task.
---

# Workbody 上下文包

## 能力

根据用户输入的任务线索，在本机记忆库中选择最多 3–20 条相关记录，生成可检查、可复制、可下载的 Markdown 上下文包。由于 Workbody 没有在本客户端中配置稳定的本地写入契约，本 Skill 不伪造“已发送成功”；交付物由用户确认后粘贴或上传到目标任务。

## 输出格式

- 任务线索和生成时间
- 每条命中的标题、类型、时间、摘要与必要正文
- 本地来源 ID，便于回查
- 隐私提醒：只把当前任务必需片段带到外部工具

## 安全

检索和组包均在本机进行。运行日志不保存查询原文或召回正文；生成的上下文包只保存在当前运行结果中，由用户主动复制或下载。
