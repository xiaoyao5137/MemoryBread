#!/bin/bash
# 创作页面优化验证脚本

echo "🧪 开始验证修改..."
echo ""

# 1. 检查Python语法
echo "1️⃣  检查Python代码语法..."
if python3 -m py_compile ai-sidecar/creation/service.py 2>/dev/null; then
    echo "   ✓ Python语法正确"
else
    echo "   ✗ Python语法错误"
    exit 1
fi

# 2. 检查TypeScript
echo ""
echo "2️⃣  检查TypeScript代码..."
cd desktop-ui
if npx tsc --noEmit 2>&1 | grep -q "CreationPanel.*error"; then
    echo "   ✗ TypeScript有错误"
    exit 1
else
    echo "   ✓ TypeScript无错误"
fi

# 3. 测试UI启动
echo ""
echo "3️⃣  测试UI服务启动..."
npm run dev > /tmp/verify_ui.log 2>&1 &
UI_PID=$!
sleep 6

if curl -s http://localhost:1420/ > /dev/null 2>&1; then
    echo "   ✓ UI服务正常启动"
    HTTP_OK=true
else
    echo "   ✗ UI服务启动失败"
    HTTP_OK=false
fi

kill $UI_PID 2>/dev/null
cd ..

if [ "$HTTP_OK" = false ]; then
    exit 1
fi

# 4. 验证关键修改点
echo ""
echo "4️⃣  验证关键修改..."

# 检查停用词扩展
if grep -q '"技术", "方案", "建设"' ai-sidecar/creation/service.py; then
    echo "   ✓ 停用词表已扩展"
else
    echo "   ✗ 停用词表未扩展"
    exit 1
fi

# 检查召回逻辑改为CASE计数
if grep -q "CASE WHEN" ai-sidecar/creation/service.py; then
    echo "   ✓ 召回逻辑改为计数模式"
else
    echo "   ✗ 召回逻辑未修改"
    exit 1
fi

# 检查相关性阈值
if grep -q "if score < 0.4:" ai-sidecar/creation/service.py; then
    echo "   ✓ 相关性阈值已提高"
else
    echo "   ✗ 相关性阈值未修改"
    exit 1
fi

# 检查UI状态变量
if grep -q "historyCollapsed" desktop-ui/src/components/CreationPanel.tsx; then
    echo "   ✓ 历史记录面板已添加"
else
    echo "   ✗ 历史记录面板未添加"
    exit 1
fi

if grep -q "referenceCollapsed" desktop-ui/src/components/CreationPanel.tsx; then
    echo "   ✓ 参考资料折叠已实现"
else
    echo "   ✗ 参考资料折叠未实现"
    exit 1
fi

echo ""
echo "✅ 所有验证通过！"
echo ""
echo "📝 修改总结："
echo "   - UI: 左侧配置、右侧记录、参考资料均可折叠"
echo "   - RAG: 扩展停用词、改进召回逻辑、提高相关性阈值"
echo ""
echo "🔍 建议测试："
echo '   1. 输入"生成一份分销团长的技术方案"'
echo "   2. 点击预览参考，查看召回文档是否相关"
echo "   3. 测试左侧配置面板和参考资料的折叠功能"
