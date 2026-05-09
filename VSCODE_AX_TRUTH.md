# VSCode AX 支持真相

## 🔍 调查结果

### VSCode **支持** AX！

之前的结论是**错误的**。VSCode 完全支持 macOS Accessibility API。

## 🐛 问题根源

### 为什么之前测试失败？

**VSCode 有多个窗口**，其中一个是 `AXUnknown` 类型（无内容）：

```applescript
-- VSCode 的窗口列表
窗口 1: 标题="", 子角色=AXUnknown        ← 空窗口
窗口 2: 标题="xxx.md", 子角色=AXStandardWindow  ← 主窗口
```

**原代码使用 `front window`**，可能获取到空窗口：

```applescript
-- 错误：可能获取到 AXUnknown 窗口
set front_win to front window of front_process
set all_ui to entire contents of front_win  -- 返回 0 个元素
```

## ✅ 解决方案

### 优先选择标准窗口

```applescript
-- 修复：优先选择 AXStandardWindow
try
    set front_win to first window whose subrole is "AXStandardWindow"
on error
    set front_win to front window  -- 降级到 front window
end try
```

### 实测数据

| 窗口类型 | UI 元素数 | 可提取文本 |
|---------|----------|-----------|
| AXUnknown | 0 | ❌ 无 |
| AXStandardWindow | **1059** | ✅ 有 |

**VSCode 标准窗口有 1059 个 UI 元素，完全支持 AX！**

## 📊 性能对比

### VSCode AX vs OCR

| 方案 | 耗时 | 准确性 | 说明 |
|------|------|--------|------|
| **AX 提取** | 150-250ms | 高 | 直接获取文本 |
| **OCR 识别** | 1.7-1.9秒 | 中 | 图像识别 |

**AX 比 OCR 快 8-10 倍！**

## 🎯 最终方案

### 1. 移除 VSCode 专用提取器

VSCode 不需要特殊处理，使用通用 AX 提取即可。

### 2. 修复窗口选择逻辑

优先选择 `AXStandardWindow`，适用于所有多窗口应用。

### 3. 保留 AX 缓存

缓存仍然有效，避免重复检测。

## 📝 修改内容

### 修改前
```rust
// 错误：认为 VSCode 不支持 AX
TextExtractor::VSCode => extract_vscode_text(), // 返回 None

fn extract_vscode_text() -> Option<String> {
    debug!("VSCode 不支持 AX");
    None
}
```

### 修改后
```rust
// 正确：VSCode 使用通用 AX 提取
// 移除 VSCode 专用提取器

// 修复窗口选择
try
    set front_win to first window whose subrole is "AXStandardWindow"
on error
    set front_win to front window
end try
```

## 🚀 效果

### VSCode 采集性能

| 阶段 | 耗时 | 说明 |
|------|------|------|
| AX 快速检测 | 50ms (首次) / <1ms (缓存) | 检测支持 |
| AX 文本提取 | 150-250ms | 提取成功 |
| **总计** | **200-300ms** | 无需 OCR |

**VSCode 每小时成本：60 × 250ms = 15 秒**（之前以为需要 108 秒 OCR）

### 对比

| 方案 | 每小时成本 | 改善 |
|------|-----------|------|
| 错误方案（OCR） | 108秒 | - |
| **正确方案（AX）** | **15秒** | **快 7 倍** |

## 🎉 结论

1. ✅ **VSCode 完全支持 AX**
2. ✅ **AX 比 OCR 快 8-10 倍**
3. ✅ **修复窗口选择逻辑**
4. ✅ **无需专用提取器**
5. ✅ **保留 AX 缓存优化**

**VSCode 不需要降级 OCR，直接用 AX 即可！**
