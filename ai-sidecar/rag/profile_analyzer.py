"""
用户画像分析模块

功能：
1. 从时间线数据中提取用户工作信息
2. 使用 LLM 推理生成用户画像
3. 智能合并增量画像到存量
"""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path

PROFILE_ANALYSIS_PROMPT = """你是一个专业的用户画像分析师。请基于以下时间线数据，分析用户的工作角色、项目、职责和风格。

# 时间线数据
{timeline_data}

# 分析要求
1. **roles**: 用户的工作角色列表（如：产品经理、独立开发者、数据分析师）
2. **projects**: 用户当前参与的项目列表，每个项目包含 name 和 desc
3. **responsibilities**: 用户的主要职责描述列表
4. **work_style**: 用户的工作风格总结（一句话）
5. **creation_style**: 用户的创作风格总结（一句话）

# 输出格式
请严格按照以下 JSON 格式输出，不要添加任何其他文字：
{{
  "roles": ["角色1", "角色2"],
  "projects": [{{"name": "项目名", "desc": "项目描述"}}],
  "responsibilities": ["职责1", "职责2"],
  "work_style": "工作风格描述",
  "creation_style": "创作风格描述"
}}
"""

MERGE_PROFILE_PROMPT = """你是一个专业的用户画像合并专家。请将新的增量画像智能合并到现有画像中。

# 现有画像
{existing_profile}

# 新增量画像
{new_profile}

# 合并规则
1. **roles**: 合并去重，保留所有出现过的角色
2. **projects**: 更新项目状态，新项目追加，已有项目更新描述
3. **responsibilities**: 合并去重，保留核心职责
4. **work_style**: 综合两者，保持连贯性
5. **creation_style**: 综合两者，保持连贯性

# 输出格式
请严格按照以下 JSON 格式输出合并后的画像，不要添加任何其他文字：
{{
  "roles": ["角色1", "角色2"],
  "projects": [{{"name": "项目名", "desc": "项目描述"}}],
  "responsibilities": ["职责1", "职责2"],
  "work_style": "工作风格描述",
  "creation_style": "创作风格描述"
}}
"""


async def analyze_daily_timeline(
    db_path: str,
    start_date: str,
    end_date: str,
    llm_client,
) -> str:
    """
    分析指定日期范围的时间线数据，生成用户画像

    Args:
        db_path: SQLite 数据库路径
        start_date: 起始日期 (ISO8601)
        end_date: 结束日期 (ISO8601)
        llm_client: LLM 客户端（需实现 chat() 方法）

    Returns:
        用户画像 JSON 字符串
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # 查询时间线数据
    cursor.execute(
        """
        SELECT
            c.captured_at,
            c.app_name,
            c.window_title,
            c.ocr_text,
            c.scene_type,
            c.tags
        FROM captures c
        WHERE date(c.captured_at) BETWEEN ? AND ?
        ORDER BY c.captured_at DESC
        LIMIT 500
        """,
        (start_date, end_date),
    )

    rows = cursor.fetchall()
    conn.close()

    if not rows:
        # 无数据时返回空画像
        return json.dumps({
            "roles": [],
            "projects": [],
            "responsibilities": [],
            "work_style": "暂无数据",
            "creation_style": "暂无数据",
        })

    # 格式化时间线数据
    timeline_items = []
    for row in rows:
        captured_at, app_name, window_title, ocr_text, scene_type, tags = row
        timeline_items.append({
            "time": captured_at,
            "app": app_name or "Unknown",
            "window": window_title or "",
            "content": (ocr_text or "")[:200],  # 截取前200字符
            "scene": scene_type or "unknown",
            "tags": tags or "",
        })

    timeline_data = json.dumps(timeline_items, ensure_ascii=False, indent=2)

    # 调用 LLM 分析
    prompt = PROFILE_ANALYSIS_PROMPT.format(timeline_data=timeline_data)
    response = await llm_client.chat(prompt)

    # 提取 JSON（去除可能的 markdown 代码块）
    response_text = response.strip()
    if response_text.startswith("```"):
        lines = response_text.split("\n")
        response_text = "\n".join(lines[1:-1])

    # 验证 JSON 格式
    try:
        profile_data = json.loads(response_text)
        return json.dumps(profile_data, ensure_ascii=False)
    except json.JSONDecodeError:
        # LLM 输出格式错误，返回默认画像
        return json.dumps({
            "roles": ["未知"],
            "projects": [],
            "responsibilities": [],
            "work_style": "分析失败",
            "creation_style": "分析失败",
        })


async def merge_profile(
    existing_profile: str,
    new_profile: str,
    llm_client,
) -> str:
    """
    将新增量画像合并到现有画像

    Args:
        existing_profile: 现有画像 JSON 字符串
        new_profile: 新增量画像 JSON 字符串
        llm_client: LLM 客户端

    Returns:
        合并后的画像 JSON 字符串
    """
    prompt = MERGE_PROFILE_PROMPT.format(
        existing_profile=existing_profile,
        new_profile=new_profile,
    )

    response = await llm_client.chat(prompt)

    # 提取 JSON
    response_text = response.strip()
    if response_text.startswith("```"):
        lines = response_text.split("\n")
        response_text = "\n".join(lines[1:-1])

    try:
        profile_data = json.loads(response_text)
        return json.dumps(profile_data, ensure_ascii=False)
    except json.JSONDecodeError:
        # 合并失败，返回新画像
        return new_profile
