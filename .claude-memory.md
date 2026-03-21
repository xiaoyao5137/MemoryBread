# WorkBuddy 项目记忆

## 项目概述
- 名称：WorkBuddy（工作搭子）
- 类型：macOS 本地 AI 工作助手
- 架构：Tauri + React/TypeScript 前端 + Rust core-engine + Python ai-sidecar

## 技术栈
- **desktop-ui**：React + TypeScript + Zustand，端口无（Tauri 内嵌）
- **core-engine**：Rust + axum + tokio + rusqlite，端口 7070
- **ai-sidecar**：Python + Flask + Ollama + psutil，端口 7071
- **向量库**：Qdrant（语义搜索）
- **全文搜索**：SQLite FTS5
- **状态管理**：Zustand（desktop-ui/src/store/useAppStore.ts）

## 关键文件路径
- `desktop-ui/src/App.tsx` — 根组件，首次启动引导逻辑
- `desktop-ui/src/store/useAppStore.ts` — 全局状态
- `desktop-ui/src/types/index.ts` — 共享类型定义
- `desktop-ui/src/components/OnboardingWizard.tsx` — 首次启动引导（3步）
- `desktop-ui/src/components/ModelManager.tsx` — 模型管理（3 Tab）
- `desktop-ui/src/components/FloatingBuddy.tsx` — 悬浮导航按钮
- `core-engine/src/api/handlers/` — Rust API 处理器
- `ai-sidecar/model_registry.py` — 模型目录 + 硬件选型建议
- `ai-sidecar/model_api_server.py` — 模型管理 API（Flask）
- `ai-sidecar/model_manager.py` — 模型运行时管理
- `ai-sidecar/migrations/` — SQLite 迁移文件（001~006）

## 已实现模块
1. **截图采集**：定时截屏 + OCR + PII 过滤
2. **RAG 问答**：FTS5 + 向量混合检索
3. **知识库**：语义分组合并 capture → knowledge fragment
4. **定时任务**：cron 表达式调度 + RAG+LLM 执行
5. **监控面板**：token 用量、采集流、RAG 会话、系统资源（CPU/内存/磁盘）
6. **模型模块**：本地 Ollama / HuggingFace / 商业 API（OpenAI/Anthropic/通义/豆包/DeepSeek/Kimi）
7. **首次引导**：OnboardingWizard 3步（欢迎+硬件检测 → 选LLM → 选Embedding）

## 架构模式
- core-engine 使用 `storage.with_conn_async()` 访问数据库（非直接 `.lock()`）
- 前端 API 调用：core-engine 用 `apiBaseUrl`（7070），模型/RAG 用 sidecar（7071）
- WindowMode 类型控制面板切换：rag/knowledge/models/settings/debug/tasks/monitor
- 首次引导状态持久化到 localStorage（workbuddy_setup_done / workbuddy_setup_skipped）

## 用户偏好
- 主要沟通语言：中文
- 代码注释：中文（面向中国用户）
- 提交信息：中文描述 + 英文技术术语
- 风格：简洁直接，不啰嗦

## 数据库迁移
- 001~004：基础表（captures, knowledge_entries, preferences, rag_sessions）
- 005：fragment 合并字段 + scheduled_tasks + task_executions
- 006：llm_usage_logs（监控）
- 007：system_resource_logs（系统资源监控）

## 注意事项
- model_api_server.py 运行在 7071，前端 ModelManager 请求 SIDECAR=7071
- knowledge.rs 已修复 SQL 注入（category/limit/offset 全部参数化）
- OnboardingWizard 跳过后可从 FloatingBuddy → models 进入 ModelManager 补充配置
