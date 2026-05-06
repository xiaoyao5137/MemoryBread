#!/usr/bin/env python3
"""测试工作项提炼功能"""

import sys
import os

# 切换到 ai-sidecar 目录
os.chdir('/Users/xianjiaqi/Documents/mygit/MemoryBread/ai-sidecar')
sys.path.insert(0, '/Users/xianjiaqi/Documents/mygit/MemoryBread/ai-sidecar')

from knowledge.extractor_v2 import KnowledgeExtractorV2
import json

# 模拟 3 条 captures
mock_captures = [
    {
        'id': 1001,
        'ts': 1746470000000,  # 2026-05-06 10:00:00
        'app_name': 'Code',
        'window_title': 'extractor_v2.py — MemoryBread',
        'ocr_text': '''
# 优化知识提炼逻辑
def extract_merged(self, captures):
    # 从多帧内容中提炼工作项
    work_item = self._extract_work_item(captures)
    return knowledge
        ''',
        'ax_text': 'extractor_v2.py MemoryBread 优化知识提炼逻辑'
    },
    {
        'id': 1002,
        'ts': 1746470300000,  # 2026-05-06 10:05:00
        'app_name': 'Terminal',
        'window_title': '~/MemoryBread',
        'ocr_text': '''
$ git add ai-sidecar/knowledge/extractor_v2.py
$ git commit -m "feat: 从多帧内容中提炼工作项"
[main e84a8ed] feat: 从多帧内容中提炼工作项
        ''',
        'ax_text': 'git commit feat 从多帧内容中提炼工作项'
    },
    {
        'id': 1003,
        'ts': 1746470600000,  # 2026-05-06 10:10:00
        'app_name': 'Code',
        'window_title': 'verification_guide.md — MemoryBread',
        'ocr_text': '''
# 工作项提炼功能验证指南

## 已完成的修改
- 扩展 MERGE_SYSTEM_PROMPT
- 新增字段：work_item、work_status、work_progress
- 测试通过，功能正常
        ''',
        'ax_text': '工作项提炼功能验证指南 已完成 测试通过'
    }
]

print("=" * 80)
print("测试工作项提炼功能")
print("=" * 80)

# 初始化 extractor
extractor = KnowledgeExtractorV2(model="qwen2.5:3b")

print("\n输入：3 条 captures")
for i, c in enumerate(mock_captures, 1):
    print(f"\n[Capture {i}]")
    print(f"  时间: {c['ts']}")
    print(f"  应用: {c['app_name']} - {c['window_title']}")
    print(f"  内容: {c['ocr_text'][:100]}...")

print("\n" + "=" * 80)
print("调用 extract_merged 提炼...")
print("=" * 80)

try:
    result = extractor.extract_merged(mock_captures)

    if result:
        print("\n✅ 提炼成功！")
        print("\n关键字段：")
        print(f"  work_item: {result.get('work_item')}")
        print(f"  work_status: {result.get('work_status')}")
        print(f"  work_progress: {result.get('work_progress')}")
        print(f"  overview: {result.get('overview')}")
        print(f"  details: {result.get('details')[:200]}...")
        print(f"  category: {result.get('category')}")
        print(f"  importance: {result.get('importance')}")

        print("\n完整结果（JSON）：")
        print(json.dumps({
            'work_item': result.get('work_item'),
            'work_status': result.get('work_status'),
            'work_progress': result.get('work_progress'),
            'overview': result.get('overview'),
            'category': result.get('category'),
            'importance': result.get('importance'),
        }, ensure_ascii=False, indent=2))
    else:
        print("\n❌ 提炼失败：返回 None")

except Exception as e:
    print(f"\n❌ 提炼失败：{e}")
    import traceback
    traceback.print_exc()

print("\n" + "=" * 80)
