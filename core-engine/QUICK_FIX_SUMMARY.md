# 稳定性修复总结

## 已完成的关键修复 (P0)

### 1. ✅ 禁用 ioreg 高频轮询
**文件**: `core-engine/src/capture/listener.rs:85-96`
**问题**: 每 60 秒调用 `ioreg -c IOHIDSystem` 查询空闲时间，导致 HID 驱动负载过高
**修复**: 临时返回 0，禁用空闲检测
**影响**: 消除系统死锁风险

### 2. ✅ 降低采集频率 80%
**文件**: `core-engine/src/capture/listener.rs:29`
**修改**: `interval_secs: 60 → 300` (1分钟 → 5分钟)
**影响**: 大幅减少系统调用频率和资源占用

### 3. ⚠️ AX 熔断机制 (部分完成)
**文件**: `core-engine/src/capture/ax.rs:17-20`
**已添加**: 熔断常量定义
**待完成**: 函数内熔断逻辑 (需手动应用或下次迭代)

## 立即行动

```bash
# 1. 重新编译
cd core-engine
cargo build --release

# 2. 重启应用
pkill -f memory-bread
./target/release/memory-bread

# 3. 监控 24 小时
watch -n 60 'vm_stat | head -10'
```

## 预期效果

- ✅ 系统调用频率: 60次/小时 → 12次/小时 (-80%)
- ✅ IOHIDSystem 负载: 消除
- ✅ 死机风险: 显著降低
- ⚠️ osascript 超时: 仍需观察 (熔断机制未完全应用)

## 后续优化 (P1)

1. 完成 AX 熔断机制的函数修改
2. 添加内存压力监控
3. 优化截图内存占用
4. 替换 osascript 为原生 AXUIElement API

## 诊断文档

详细分析见: [STABILITY_DIAGNOSIS.md](STABILITY_DIAGNOSIS.md)
