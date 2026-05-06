#!/usr/bin/env python3
"""测试日报生成 - 检索部分"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'ai-sidecar'))

import time
from rag.retriever import KnowledgeFts5Retriever

def _day_start_ms(offset_days: int) -> int:
    now = time.localtime()
    midnight = time.mktime((
        now.tm_year,
        now.tm_mon,
        now.tm_mday,
        0,
        0,
        0,
        now.tm_wday,
        now.tm_yday,
        now.tm_isdst,
    ))
    return int((midnight + offset_days * 24 * 60 * 60) * 1000)

# 初始化检索器
db_path = os.path.expanduser("~/.memory-bread/memory-bread.db")
knowledge_retriever = KnowledgeFts5Retriever(db_path)

# 测试日报查询
user_query = "生成今日工作日记"
print(f"\n{'='*80}")
print(f"测试查询: {user_query}")
print(f"{'='*80}\n")

# 直接调用 retriever
today_start = _day_start_ms(0)
now_ms = int(time.time() * 1000)

print(f"时间范围: {time.strftime('%Y-%m-%d %H:%M', time.localtime(today_start/1000))} ~ {time.strftime('%Y-%m-%d %H:%M', time.localtime(now_ms/1000))}")

results = knowledge_retriever.search(
    query="",
    top_k=20,
    created_start_ts=today_start,
    created_end_ts=now_ms,
    query_mode="summary",
)

print(f"\n检索结果: {len(results)} 条\n")
for i, r in enumerate(results[:10], 1):
    print(f"{i}. {r.text[:200]}...")
    print()
