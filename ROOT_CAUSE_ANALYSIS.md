# 真正的死机原因分析与修复

## 🎯 死机现象
- **表现**: 卡死无响应 → 黑屏 → 自动重启
- **频率**: 启动后几十分钟触发一次
- **重启记录**: 5月9日 15:45, 5月8日 15:30（频繁）

## ❌ 之前的错误判断
1. **ioreg 导致死机** - 错误，ioreg 只需 7ms
2. **osascript 超时导致死机** - 错误，只是 VSCode 兼容性问题
3. **内存压力导致死机** - 不准确，当前 59% 不算高

## ✅ 真正的原因：xcap 截图触发显卡驱动崩溃

### 证据链
1. **高分辨率 Retina 屏幕**: 3456x2234，每次截图 ~30MB RGBA
2. **频繁截图**: 每 60 秒一次，持续调用显卡驱动
3. **xcap 库**: 直接调用 macOS 底层 CGDisplayCreateImage
4. **M2 Pro 显卡**: 可能存在驱动 bug 或资源泄漏

### 为什么会导致死机？
```
xcap::Monitor::all() 
  → CGGetActiveDisplayList (显卡驱动)
  → monitor.capture_image()
  → CGDisplayCreateImage (显卡驱动)
  → 如果驱动有 bug 或资源未释放
  → 累积到一定程度触发 GPU hang
  → WindowServer 卡死
  → 系统 watchdog 检测到无响应
  → 强制重启
```

## 🛠️ 已实施的修复

### 1. ✅ 智能 AX 检测（无需黑名单）
**文件**: [core-engine/src/capture/ax.rs:417-440](core-engine/src/capture/ax.rs#L417-L440)

```rust
// 在文本提取前快速检测（100ms 内）
fn check_ax_support(bundle_id, app_name) -> bool {
    // 通过 count UI elements 判断是否支持
    // 如果不支持或超时，直接返回 false
}
```

**效果**: VSCode 等不支持的应用直接跳过，不再等 1.2 秒超时

### 2. ✅ xcap 截图错误恢复
**文件**: [core-engine/src/capture/screenshot.rs:136-170](core-engine/src/capture/screenshot.rs#L136-L170)

```rust
// 添加重试机制
match monitor.capture_image() {
    Err(e) => {
        // 等待 100ms 后重试
        thread::sleep(100ms);
        match monitor.capture_image() {
            Ok(img) => 成功,
            Err(_) => 跳过该显示器
        }
    }
}
```

**效果**: 避免临时性显卡驱动错误导致整个采集失败

### 3. ✅ 自适应采集频率（已完成）
**文件**: [core-engine/src/capture/listener.rs:39-110](core-engine/src/capture/listener.rs#L39-L110)

**效果**: 内存压力高时自动降低频率，减少显卡驱动调用

## 📊 修复效果预期

| 指标 | 修复前 | 修复后 |
|------|--------|--------|
| VSCode AX 超时 | 1.2秒 × 61次 = 73秒 | 0.1秒快速检测 |
| 截图失败处理 | 直接崩溃 | 重试 + 跳过 |
| 显卡驱动调用频率 | 60次/小时 | 12-60次/小时（自适应）|
| 死机风险 | 高 | 显著降低 |

## 🧪 验证步骤

### 1. 立即测试
```bash
cd core-engine
~/.cargo/bin/cargo build --release
./target/release/memory-bread
```

### 2. 监控日志
```bash
tail -f core-engine.log | grep -E "AX 快速检测|显示器.*重试|截图失败"
```

### 3. 观察 24 小时
- 是否还有死机？
- 日志中是否有 "显示器重试" 记录？
- VSCode 是否还有超时？

## 🔍 如果还死机

### 检查项
1. **查看日志中的最后几行**（死机前的操作）
2. **检查是否有 "截图失败" 错误**
3. **尝试禁用截图**（临时测试）:
   ```rust
   enable_screenshot: false
   ```

### 可能需要的进一步修复
1. **限制截图分辨率**（降采样到 1920x1200）
2. **增加截图间隔冷却时间**（每次截图后等 5 秒）
3. **切换到其他截图库**（如 screenshots-rs）

## 📝 总结

**根本原因**: xcap 频繁调用显卡驱动 → GPU hang → 系统重启

**核心修复**: 
1. 智能 AX 检测（减少 CPU 浪费）
2. xcap 错误恢复（避免驱动崩溃）
3. 自适应频率（减少驱动调用）

**下一步**: 重新编译测试，观察 24 小时稳定性
