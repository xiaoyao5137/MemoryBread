#!/bin/bash
# 测试内存压力检测

echo "=== 内存压力检测测试 ==="
echo ""

# 获取 vm_stat 输出
vm_stat_output=$(vm_stat)

echo "原始 vm_stat 输出:"
echo "$vm_stat_output" | head -10
echo ""

# 解析关键指标
page_size=$(echo "$vm_stat_output" | grep "page size" | awk '{print $8}')
pages_free=$(echo "$vm_stat_output" | grep "Pages free:" | awk '{print $3}' | tr -d '.')
pages_active=$(echo "$vm_stat_output" | grep "Pages active:" | awk '{print $3}' | tr -d '.')
pages_inactive=$(echo "$vm_stat_output" | grep "Pages inactive:" | awk '{print $3}' | tr -d '.')
pages_wired=$(echo "$vm_stat_output" | grep "Pages wired down:" | awk '{print $4}' | tr -d '.')

echo "解析结果:"
echo "  Page Size: $page_size bytes"
echo "  Pages Free: $pages_free"
echo "  Pages Active: $pages_active"
echo "  Pages Inactive: $pages_inactive"
echo "  Pages Wired: $pages_wired"
echo ""

# 计算使用率
total_pages=$((pages_free + pages_active + pages_inactive + pages_wired))
used_pages=$((pages_active + pages_wired))
usage_percent=$((used_pages * 100 / total_pages))

echo "内存使用率: $usage_percent%"
echo ""

if [ $usage_percent -lt 70 ]; then
    echo "✅ 内存压力: Normal (< 70%) → 采集间隔 60 秒"
elif [ $usage_percent -lt 85 ]; then
    echo "⚠️  内存压力: High (70-85%) → 采集间隔 180 秒"
else
    echo "🔴 内存压力: Critical (> 85%) → 采集间隔 300 秒 + 跳过"
fi
