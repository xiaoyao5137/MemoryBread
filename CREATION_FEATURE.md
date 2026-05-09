# 创作功能实现文档

## 功能概述
新增"创作"菜单页面，用户输入文字指令后，系统基于"设计"中的优质文档结构和话术作为模板，结合"时间线"和"采集记录"的内容，通过本地推理模型生成 markdown 文档。

## 架构设计

### 1. 数据层 (core-engine/storage)
- **新增方法**: `get_design_templates(limit: Option<usize>)` 
- **位置**: [core-engine/src/storage/repo/knowledge.rs:15-70](core-engine/src/storage/repo/knowledge.rs#L15-L70)
- **功能**: 从 `bake_designs` 表查询优质设计模板，按 match_score 和 usage_count 排序

### 2. AI Sidecar 服务 (ai-sidecar/creation)
- **服务类**: `CreationService` - 封装 Ollama 流式调用逻辑
- **FastAPI 应用**: `app.py` - 提供 `/creation/generate` 端点
- **流式响应**: 使用 SSE (Server-Sent Events) 实时返回生成内容

#### 关键文件
- [ai-sidecar/creation/service.py](ai-sidecar/creation/service.py) - 核心生成逻辑
- [ai-sidecar/creation/app.py](ai-sidecar/creation/app.py) - FastAPI 端点
- [ai-sidecar/start_creation_service.py](ai-sidecar/start_creation_service.py) - 启动脚本

### 3. Core Engine API (core-engine/api)
- **新增端点**: `POST /api/creation/generate`
- **位置**: [core-engine/src/api/handlers/creation.rs](core-engine/src/api/handlers/creation.rs)
- **功能**: 
  1. 查询设计模板
  2. 构建上下文（时间线、采集记录）
  3. 调用 ai-sidecar 服务
  4. 转发 SSE 流到前端

### 4. Frontend (desktop-ui)
- **新增页面**: `CreationPanel.tsx`
- **位置**: [desktop-ui/src/components/CreationPanel.tsx](desktop-ui/src/components/CreationPanel.tsx)
- **功能**:
  - 用户输入创作指令
  - 实时显示流式生成内容
  - 一键复制 markdown 内容

#### UI 集成
- 在 [FloatingBuddy.tsx](desktop-ui/src/components/FloatingBuddy.tsx) 中添加"创作"菜单项
- 在 [App.tsx](desktop-ui/src/App.tsx) 中注册路由
- 在 [types/index.ts](desktop-ui/src/types/index.ts) 中添加 `'creation'` 类型

## 数据流

```
用户输入指令
    ↓
Frontend (CreationPanel)
    ↓ POST /api/creation/generate
Core Engine API
    ↓ 查询 bake_designs
Storage Layer
    ↓ 返回模板
Core Engine API
    ↓ POST /creation/generate
AI Sidecar (FastAPI)
    ↓ 调用 Ollama
Ollama (本地 LLM)
    ↓ SSE 流式响应
AI Sidecar → Core Engine → Frontend
    ↓
用户看到实时生成的文档
```

## 启动步骤

### 1. 启动 Ollama
```bash
# 确保 Ollama 已安装并运行
ollama serve
```

### 2. 启动 AI Sidecar Creation 服务
```bash
cd ai-sidecar
source .venv/bin/activate
python start_creation_service.py
```

### 3. 启动 Core Engine
```bash
cd core-engine
cargo run
```

### 4. 启动 Desktop UI
```bash
cd desktop-ui
npm run tauri dev
```

## 测试验证

### 手动测试
1. 打开应用，点击左侧"创作"菜单
2. 输入创作指令，例如："帮我写一份本周工作总结"
3. 点击"开始创作"按钮
4. 观察流式生成过程
5. 点击"复制"按钮，验证内容已复制到剪贴板

### API 测试
```bash
# 测试 AI Sidecar 端点
curl -X POST http://localhost:8001/creation/generate \
  -H "Content-Type: application/json" \
  -d '{
    "user_prompt": "写一份技术文档",
    "design_templates": [],
    "timeline_context": null,
    "capture_context": null
  }'

# 测试 Core Engine 端点
curl -X POST http://localhost:7070/api/creation/generate \
  -H "Content-Type: application/json" \
  -d '{
    "user_prompt": "写一份技术文档",
    "design_ids": [],
    "timeline_ids": [],
    "capture_ids": []
  }'
```

## 依赖项

### Rust (core-engine/Cargo.toml)
- `async-stream = "0.3"` - 异步流支持
- `futures = "0.3"` - Future 工具
- `reqwest` 添加 `stream` feature

### Python (ai-sidecar)
- `httpx` - 异步 HTTP 客户端
- `fastapi` - Web 框架
- `uvicorn` - ASGI 服务器

## 后续优化方向

1. **上下文增强**: 实现真实的时间线和采集记录查询，而非简化版
2. **模板选择**: 允许用户手动选择特定的设计模板
3. **历史记录**: 保存创作历史，支持重新生成
4. **模型配置**: 支持切换不同的 Ollama 模型
5. **错误重试**: 添加自动重试机制
6. **进度指示**: 显示生成进度百分比
7. **导出功能**: 支持导出为 PDF、Word 等格式

## 注意事项

1. **Ollama 依赖**: 确保 Ollama 已安装并运行，默认模型为 `qwen2.5:14b`
2. **端口冲突**: AI Sidecar 使用 8001 端口，Core Engine 使用 7070 端口
3. **流式响应**: 前端需要正确处理 SSE 流，避免缓冲问题
4. **错误处理**: 当 Ollama 不可用时，前端会显示友好的错误提示
