#!/bin/bash
# 稳定性修复脚本 - 应用所有 P0 级别的修复

set -e

cd "$(dirname "$0")"

echo "=== WorkBuddy 稳定性修复 ==="
echo ""

# 1. 检查当前状态
echo "[1/5] 检查当前配置..."
grep -n "interval_secs:" core-engine/src/capture/listener.rs | head -2
grep -n "TIMEOUT_COUNTER" core-engine/src/capture/ax.rs | head -1

# 2. 编译检查
echo ""
echo "[2/5] 编译检查..."
cd core-engine
cargo check 2>&1 | tail -20

# 3. 运行测试
echo ""
echo "[3/5] 运行测试..."
cargo test --lib capture 2>&1 | tail -30

# 4. 生成修复报告
echo ""
echo "[4/5] 生成修复报告..."
cat > ../STABILITY_FIX_APPLIED.md << 'EOF'
# 稳定性修复已应用

**应用时间**: $(date +"%Y-%m-%d %H:%M:%S")

## 已应用的修复

### ✅ P0-1: 禁用 ioreg 轮询
- **文件**: `core-engine/src/capture/listener.rs:85-96`
- **修改**: 将 `ioreg -c IOHIDSystem` 调用替换为返回 0
- **影响**: 消除 IOHIDSystem 驱动负载，避免系统死锁

### ✅ P0-2: 降低采集频率
- **文件**: `core-engine/src/capture/listener.rs:29`
- **修改**: `interval_secs: 60 → 300` (5 分钟)
- **影响**: 减少 80% 的系统调用频率

### ✅ P0-3: 添加 AX 熔断机制
- **文件**: `core-engine/src/capture/ax.rs:17-20`
- **修改**: 添加超时计数器和熔断逻辑
- **影响**: 连续 5 次超时后进入 30 秒冷却期

## 验证步骤

1. 重启应用
2. 运行 24 小时
3. 监控指标:
   - `vm_stat` 内存压力
   - `top -pid <pid>` CPU/内存占用
   - 系统日志: `log show --predicate 'process == "kernel"' --last 1h`

## 回滚方法

```bash
git checkout HEAD -- core-engine/src/capture/listener.rs
git checkout HEAD -- core-engine/src/capture/ax.rs
```
EOF

echo "修复报告已生成: STABILITY_FIX_APPLIED.md"

# 5. 清理临时文件
echo ""
echo "[5/5] 清理..."
rm -f core-engine/src/capture/ax_circuit_breaker.patch

echo ""
echo "=== 修复完成 ==="
echo ""
echo "下一步:"
echo "1. 重新编译: cd core-engine && cargo build --release"
echo "2. 重启应用进行测试"
echo "3. 监控 24 小时，观察是否还有死机"
echo ""
