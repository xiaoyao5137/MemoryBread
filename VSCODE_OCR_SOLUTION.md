# VSCode OCR 问题与解决方案

## 🔴 问题

### VSCode 的困境
1. **不支持 AX** - 实测 0 个 text area, 0 个 static text
2. **快速检测失败** (50ms) → 降级 OCR
3. **OCR 超时 15 秒** - 比 AX 慢 12 倍
4. **每 60 秒一次** - 每小时 60 次 OCR = 15 分钟 CPU 时间

### OCR vs AX 对比
| 指标 | AX | OCR |
|------|-----|-----|
| 耗时 | 150-200ms | 最多 15 秒 |
| CPU | 低 | 高（图像处理+模型推理）|
| 准确性 | 高 | 中等 |
| 适用场景 | 支持 AX 的应用 | 不支持 AX 的应用 |

## ✅ 解决方案

### 方案 1: 应用级采集频率（推荐）

**思路**: 对不支持 AX 的应用（如 VSCode），降低采集频率

```rust
// 在 listener.rs 中
match app_name {
    "Code" | "Visual Studio Code" => {
        // VSCode 降级 OCR，采集频率降低到 5 分钟
        Duration::from_secs(300)
    }
    _ => {
        // 其他应用正常 60 秒
        Duration::from_secs(60)
    }
}
```

**效果**:
- VSCode: 12 次/小时 → 3 分钟 OCR 时间
- 其他应用: 不受影响

### 方案 2: OCR 结果缓存

**思路**: 如果截图 dhash 相同，复用上次 OCR 结果

```rust
// 缓存结构
struct OcrCache {
    dhash: String,
    text: String,
    timestamp: Instant,
}

// 检查缓存
if let Some(cached) = ocr_cache.get(&dhash) {
    if cached.timestamp.elapsed() < Duration::from_secs(300) {
        return cached.text; // 复用
    }
}
```

**效果**:
- 如果 VSCode 内容不变，跳过 OCR
- 减少 50-80% OCR 调用

### 方案 3: 异步 OCR（不阻塞采集）

**思路**: OCR 在后台执行，不阻塞主采集流程

```rust
// 当前: 同步等待 OCR（15 秒）
let ocr_result = call_ocr().await; // 阻塞

// 改为: 异步 OCR
spawn_ocr_task(screenshot_path); // 不阻塞
// 下次采集时补充 OCR 结果
```

**效果**:
- 采集不被 OCR 阻塞
- 但 OCR 结果会延迟一个周期

## 🎯 推荐组合

**方案 1 + 方案 2**:
1. VSCode 采集频率降低到 5 分钟
2. 添加 OCR 结果缓存（dhash 相同时复用）

**预期效果**:
- VSCode OCR 调用: 60 次/小时 → 6-12 次/小时（降低 80-90%）
- 其他应用: 不受影响
- 实现简单，风险低

## 📝 实现优先级

1. **立即**: 添加 VSCode 专用提取器（返回 None，快速失败）✅
2. **高优先级**: 应用级采集频率（方案 1）
3. **中优先级**: OCR 结果缓存（方案 2）
4. **低优先级**: 异步 OCR（方案 3，改动较大）

## ❓ 需要确认

**VSCode 是否需要频繁采集？**
- 如果用户主要在 VSCode 中编码，5 分钟采集一次是否足够？
- 还是应该完全跳过 VSCode，只采集其他应用？
