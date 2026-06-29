# MemoryBread 服务端网关层 Credit 计量方案

## 目标

MemoryBread 客户端只展示品牌模型，不直接暴露底层开源或商业模型名称。服务端网关负责把品牌模型路由到真实供应商模型，并统一完成鉴权、限流、计量、计费、审计和监控。

## 品牌模型分层

| 品牌模型 | 全称 | 类型 | 默认底层路由 | 计费属性 |
| --- | --- | --- | --- | --- |
| MBEM v1.0 | MemoryBread Extract Model Local 1.0，本地提炼模型 v1 | 采集分析模型 | 本地模型映射表 | 免费或仅本地资源统计 |
| MBCD Std v1.0 | MemoryBread Create Document Standard 1.0，文本创作模型 v1 | 咨询生成模型 | 本地模型映射表 | 免费或低成本套餐内 |
| MBCD Plus v1.0 | MemoryBread Create Document Plus 1.0，文本创作模型 Plus v1 | 咨询生成模型 | 远程商业模型映射表 | 消耗 Credit |
| GPT Image 2 | 生图模型 | 图像生成 | 远程图像模型 | 消耗 Credit |
| Gemini Nano Banana | 生图模型 | 图像生成 | 远程图像模型 | 消耗 Credit |

服务端维护 `brand_model_routes` 映射表，客户端只传 `brand_model_id`，例如 `mbcd-plus-v1`。真实供应商、真实模型名、价格、上下文限制、降级策略都由网关决定。

## 网关职责

1. 鉴权：验证用户、设备、组织、套餐状态。
2. 路由：根据 `brand_model_id`、地域、成本、可用性选择底层模型。
3. 计量：记录输入 token、输出 token、图片张数、分辨率、时长、失败原因。
4. 计费：将用量转换为 Credit 变动，写入不可变账本。
5. 限流：按用户、组织、模型、场景设置 QPS、并发、日额度。
6. 监控：给客户端监控页和运营后台提供用量、费用、失败率、延迟指标。
7. 审计：保留请求元数据，不默认存储用户明文内容；内容采样需用户授权。

## 核心数据表

### brand_model_routes

- `brand_model_id`
- `display_name`
- `model_family`: `extract | create | image | embedding`
- `provider`
- `provider_model`
- `route_version`
- `is_default`
- `is_remote_billable`
- `input_credit_per_1k_tokens`
- `output_credit_per_1k_tokens`
- `image_credit_per_unit`
- `effective_from`
- `effective_to`

### usage_events

- `id`
- `user_id`
- `org_id`
- `device_id`
- `request_id`
- `caller`: `capture | knowledge | rag | creation | image | task`
- `brand_model_id`
- `route_version`
- `provider`
- `provider_model_hash`
- `input_tokens`
- `output_tokens`
- `image_units`
- `latency_ms`
- `status`
- `error_code`
- `created_at`

### credit_ledger

- `id`
- `user_id`
- `org_id`
- `request_id`
- `event_id`
- `change_amount`
- `balance_after`
- `reason`: `charge | refund | grant | subscription_reset | adjustment`
- `metadata_json`
- `created_at`

账本只追加，不原地修改。失败请求可写 `usage_events`，但不扣费；部分失败按策略写负向退款流水。

## Credit 机制

Credit 是 MemoryBread 内部统一计价单位，避免客户端感知不同供应商价格。建议初期规则：

- 本地 MBEM / MBCD Std：默认不扣 Credit，只记录本地调用次数和估算 token。
- 远程文本模型：按 `input_tokens * input_price + output_tokens * output_price` 扣减。
- 生图模型：按模型、尺寸、质量、张数折算 `image_units`。
- RAG 和创作链路：每次子调用都产生独立 `usage_event`，同时用同一个 `request_id` 聚合。
- 余额不足：网关在调用前预估冻结 Credit，完成后按实际用量结算，多退少补。

## API 设计

### 调用入口

`POST /v1/gateway/chat`

请求核心字段：

```json
{
  "request_id": "uuid",
  "brand_model_id": "mbcd-plus-v1",
  "caller": "creation",
  "messages": [],
  "stream": true
}
```

响应流里返回品牌模型名、用量快照和最终账单摘要，不返回真实供应商模型。

### 余额与用量

- `GET /v1/credits/balance`
- `GET /v1/usage/summary?from=&to=`
- `GET /v1/usage/events?caller=&brand_model_id=`
- `GET /v1/models/brand-routes`：只给客户端返回品牌模型可用性和展示信息。

## 监控页面指标

客户端监控页建议新增“Credit 与模型用量”模块：

- 今日 Credit 消耗、周期 Credit 消耗、剩余额度。
- 按品牌模型拆分：调用次数、输入 token、输出 token、图片单位、Credit。
- 按场景拆分：采集分析、知识提炼、RAG 咨询、内容创作、生图、定时任务。
- 失败与退款：失败次数、失败率、自动退款 Credit。
- 远程调用占比：本地调用次数 vs 远程付费调用次数。

服务端运营后台额外展示真实供应商成本、毛利、供应商错误率、路由版本表现。

## 工程落地顺序

1. 在现有客户端先完成品牌 ID 改造，所有调用只传 MemoryBread 品牌模型。
2. 服务端实现 `brand_model_routes` 和只追加 `usage_events`，先做计量不扣费。
3. 接入 `credit_ledger`，实现预冻结、结算、失败退款。
4. 将远程模型 API Key 从客户端迁移到服务端托管，客户端只持用户 token。
5. 增加监控页 Credit 视图和运营后台供应商成本视图。
6. 灰度启用付费远程模型，保留本地模型免费路径。

## 风险与对策

- 底层模型升级导致效果变化：用 `route_version` 固化路由版本，并支持按用户灰度。
- 流式调用中断：先冻结预算，完成后按实际 token 结算；异常时按已产生用量或全额退款策略处理。
- 供应商价格变化：价格表版本化，账单按请求发生时版本计算。
- 用户质疑扣费：每个账单明细可追溯到 `usage_event`，但真实供应商名称默认只在运营后台可见。
- 隐私合规：默认只保存 token 和元数据，不保存 prompt 明文；调试采样需用户显式授权。
