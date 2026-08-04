---
name: qianwen-office
description: Build a Chinese office-writing context pack from selected local memories for user-reviewed transfer into a Qianwen Office document task.
---

# 千问办公上下文包

## 能力

按文档主题或任务线索检索本机记忆、知识和历史结论，整理为中文办公场景可直接使用的 Markdown 材料包。输出强调事实与来源，不生成不存在的业务结论。

## 执行

1. 用户输入文档主题并选择召回数量。
2. 本地检索按标题命中和更新时间排序。
3. 生成包含“项目背景、已有结论、证据片段、待核验项”的上下文包。
4. 用户查看后复制或下载，再自行交给千问办公。

## 边界

没有目标应用确认回执时，不宣称已经自动写入千问办公；不会读取浏览器 Cookie，也不会保存外部账户信息。
