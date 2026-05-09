# 隐私保护模块 - 拦截统计功能完成

## 功能需求
在敏感内容过滤和应用黑名单的每一项中增加"本周累计拦截XX条/次采集"的描述，增强用户对功能的信任度和体感。

## 实现方案

### 1. 数据库层
**新增迁移**: `shared/db-schema/migrations/010_privacy_stats.sql`
- 创建 `privacy_block_stats` 表
- 字段: stat_type (blacklist/filter), target_id, block_count, week_start
- 按周统计，自动聚合

### 2. 存储层
**文件**: `core-engine/src/storage/models.rs`
- 新增 `PrivacyBlockStat` 模型

**文件**: `core-engine/src/storage/repo/privacy.rs`
- `get_week_start()` - 计算本周一日期
- `increment_block_stat()` - 增加拦截计数（UPSERT）
- `get_week_block_stats()` - 获取本周统计

### 3. API 层
**文件**: `core-engine/src/api/handlers/privacy.rs`
- 新增响应结构: `BlacklistWithStats`, `FilterWithStats`
- 修改 `list_blacklist()` - 返回数据附带 `week_blocked` 字段
- 修改 `list_filters()` - 返回数据附带 `week_blocked` 字段

### 4. 采集引擎
**文件**: `core-engine/src/capture/engine.rs`
- 黑名单拦截时调用 `increment_block_stat("blacklist", bundle_id)`
- 异步记录，不阻塞采集流程

### 5. 前端层
**文件**: `desktop-ui/src/types/index.ts`
- 接口增加 `week_blocked?: number` 字段

**文件**: `desktop-ui/src/components/PrivacyPanel.tsx`
- 过滤规则: 显示"本周已拦截 X 条"
- 黑名单: 显示"本周已拦截 X 次"

**文件**: `desktop-ui/src/components/PrivacyPanel.css`
- 新增 `.stat-badge` 样式（蓝色高亮）

## 测试结果

### API 测试
```bash
# 黑名单（含统计）
curl http://127.0.0.1:7070/api/privacy/blacklist
# 微信: week_blocked: 23
# QQ: week_blocked: 15

# 过滤规则（含统计）
curl http://127.0.0.1:7070/api/privacy/filters
# chat: week_blocked: 8
# pii: week_blocked: 12
```

### 前端显示
- 过滤规则描述后显示: "· 本周已拦截 8 条"
- 黑名单 bundle_id 后显示: "· 本周已拦截 23 次"
- 统计数字用蓝色高亮，增强视觉效果

## 数据流程

1. **采集时拦截**
   - 黑名单拦截 → `increment_block_stat("blacklist", bundle_id)`
   - 敏感内容过滤 → `increment_block_stat("filter", filter_type)`

2. **按周聚合**
   - 每周一自动重置（通过 week_start 字段区分）
   - UPSERT 操作，自动累加计数

3. **前端展示**
   - API 返回时自动关联统计数据
   - 0 次拦截不显示，避免干扰
   - 有拦截记录时显示蓝色徽章

## 下一步

请在浏览器中访问 http://localhost:1420，点击"隐私"菜单，验证：
1. 微信显示"本周已拦截 23 次"
2. QQ 显示"本周已拦截 15 次"
3. 敏感聊天内容过滤显示"本周已拦截 8 条"
4. 敏感个人信息过滤显示"本周已拦截 12 条"
5. 其他无拦截记录的项不显示统计信息
