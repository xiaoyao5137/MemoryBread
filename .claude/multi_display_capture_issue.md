# 多屏环境下的采集不一致问题

## 问题描述

**现象**：capture_id=958 的数据不一致

- **win_title**: "当前生成的本周工作记录，里面介绍的产出和进展这些… — MemoryBread"（副屏 VSCode）
- **ocr_text**: "记忆面包 File Edit View..."（主屏 Gmail + 记忆面包界面）
- **ax_text**: 空

**用户环境**：双屏（主屏 + 副屏）

---

## 根因分析

### 1. 截图采集逻辑

**代码位置**：`core-engine/src/capture/screenshot.rs:153-156`

```rust
// 采集主显示器（第一个）
let rgba_image = monitors[0]
    .capture_image()
    .map_err(|e| CaptureError::ScreenshotFailed(e.to_string()))?;
```

**行为**：只采集 `monitors[0]`（主显示器）

### 2. 窗口标题获取逻辑

**代码位置**：`core-engine/src/capture/ax.rs:430-437`

```applescript
tell application "System Events"
    set front_process to first application process whose frontmost is true
    set win_title to name of front window of front_process
end tell
```

**行为**：获取**前台应用**的窗口标题（可能在任意屏幕）

### 3. Accessibility 文本提取

**代码位置**：`core-engine/src/capture/ax.rs:470-479`

**行为**：尝试从前台应用提取文本（VSCode 可能无法访问）

---

## 为什么会不一致？

### 场景重现

1. **主屏**：显示 Gmail + 记忆面包界面
2. **副屏**：显示 VSCode，正在编辑 "当前生成的本周工作记录..."
3. **前台应用**：VSCode（用户最后点击的窗口）

### 采集结果

| 数据源 | 采集目标 | 实际内容 |
|--------|---------|---------|
| screenshot | 主屏（monitors[0]） | Gmail + 记忆面包界面 |
| win_title | 前台应用窗口 | VSCode 标题 |
| ax_text | 前台应用文本 | 空（VSCode 无法访问） |
| ocr_text | 主屏截图 OCR | Gmail + 记忆面包界面文字 |

**结果**：标题和内容不匹配！

---

## 影响范围

### 1. 情节记忆提炼不准确

LLM 看到的输入：
```
窗口标题：当前生成的本周工作记录... — MemoryBread
OCR 文本：记忆面包 File Edit View Gmail 收件箱...
```

**混淆**：LLM 可能认为用户在 MemoryBread 中查看 Gmail

### 2. work_item 提取错误

- 标题暗示：正在编辑工作记录（MemoryBread 项目）
- 内容显示：正在查看 Gmail 邮件
- **提取结果**：可能混合两者，或者提取错误

### 3. 用户体验问题

- 周报中出现不相关的内容
- Bake 生成的 SOP 包含错误的上下文
- 查询时检索到不相关的记忆

---

## 解决方案

### 方案 1：采集所有屏幕（推荐）

**优点**：
- 完整记录用户的工作上下文
- 标题和内容一定匹配（因为都采集了）
- 支持多屏工作流

**缺点**：
- 存储空间增加（多屏截图更大）
- OCR 处理时间增加
- 隐私风险增加（采集更多内容）

**实现**：
```rust
// 采集所有显示器
for (i, monitor) in monitors.iter().enumerate() {
    let rgba_image = monitor.capture_image()?;
    // 保存为 screenshots/{ts_ms}_display_{i}.jpg
}
```

### 方案 2：采集前台应用所在屏幕

**优点**：
- 标题和内容一定匹配
- 存储空间不增加
- 更符合用户意图（采集正在使用的屏幕）

**缺点**：
- 需要检测前台应用所在屏幕（技术复杂）
- 可能遗漏主屏的重要信息

**实现**：
```rust
// 1. 获取前台应用的窗口位置
// 2. 判断窗口在哪个屏幕
// 3. 采集该屏幕
```

### 方案 3：同时记录窗口标题来源

**优点**：
- 不改变采集逻辑
- 提供更多上下文信息
- 帮助 LLM 理解不一致

**缺点**：
- 不解决根本问题
- LLM 仍然可能混淆

**实现**：
```rust
// 在 captures 表中添加字段
win_title_source: "display_1" | "display_2"
screenshot_source: "display_0"
```

### 方案 4：只采集前台应用窗口（不采集整个屏幕）

**优点**：
- 标题和内容完全匹配
- 隐私保护更好（只采集活动窗口）
- 存储空间更小

**缺点**：
- 遗漏周边上下文（其他窗口、桌面）
- 技术实现复杂（需要窗口级截图）

---

## 推荐方案

### 短期（快速修复）：方案 3

在数据库中记录采集来源，帮助 LLM 理解不一致：

```sql
ALTER TABLE captures ADD COLUMN win_title_display TEXT;
ALTER TABLE captures ADD COLUMN screenshot_display TEXT;
```

在提炼时添加提示：
```
注意：窗口标题来自副屏（display_1），截图来自主屏（display_0），
如果内容不匹配，优先使用截图内容。
```

### 长期（根本解决）：方案 1

采集所有屏幕，让用户选择：

1. **默认模式**：只采集主屏（当前行为）
2. **多屏模式**：采集所有屏幕
3. **智能模式**：采集前台应用所在屏幕

配置示例：
```toml
[capture]
screenshot_mode = "all_displays"  # "main_display" | "all_displays" | "active_display"
```

---

## 临时缓解措施

### 1. 在提炼时降低 win_title 的权重

如果 win_title 和 ocr_text 内容差异很大，优先使用 ocr_text：

```python
# 在 extractor_v2.py 中
if similarity(win_title, ocr_text) < 0.3:
    logger.warning(f"窗口标题与 OCR 内容不匹配，可能是多屏环境")
    # 降低 win_title 的权重
```

### 2. 在 MERGE_SYSTEM_PROMPT 中添加说明

```
注意：在多屏环境下，窗口标题可能来自副屏，而截图来自主屏。
如果两者内容不一致，优先使用截图（OCR）内容进行提炼。
```

### 3. 用户配置

允许用户选择主工作屏幕：

```toml
[capture]
primary_work_display = 1  # 0=主屏, 1=副屏
```

---

## 数据验证

### 检测不一致的 captures

```sql
SELECT 
  id,
  app_name,
  substr(win_title, 1, 50) as title,
  substr(ocr_text, 1, 50) as ocr,
  CASE 
    WHEN win_title NOT LIKE '%' || app_name || '%' THEN 'mismatch'
    ELSE 'ok'
  END as status
FROM captures
WHERE ocr_text IS NOT NULL
  AND win_title IS NOT NULL
ORDER BY id DESC
LIMIT 20;
```

### 统计不一致比例

```sql
SELECT 
  COUNT(*) as total,
  SUM(CASE WHEN win_title NOT LIKE '%' || app_name || '%' THEN 1 ELSE 0 END) as mismatch,
  ROUND(100.0 * SUM(CASE WHEN win_title NOT LIKE '%' || app_name || '%' THEN 1 ELSE 0 END) / COUNT(*), 2) as mismatch_rate
FROM captures
WHERE ocr_text IS NOT NULL
  AND win_title IS NOT NULL;
```

---

## 总结

### 问题根因

- **截图采集主屏**（monitors[0]）
- **窗口标题来自前台应用**（可能在副屏）
- **多屏环境下必然不一致**

### 影响

- 情节记忆提炼不准确
- work_item 提取错误
- 用户体验下降

### 建议

1. **短期**：在提炼时添加多屏环境说明，降低 win_title 权重
2. **长期**：支持采集所有屏幕，或采集前台应用所在屏幕
3. **配置**：让用户选择采集模式（主屏 / 所有屏 / 活动屏）
