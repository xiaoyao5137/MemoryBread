"""
知识提炼模块 V2 - 强制使用 LLM，支持去重和出现次数统计
"""

import ast
import json
import logging
import re
import time
import urllib.request
from typing import Optional, Dict, Any, List
from datetime import datetime
import numpy as np

logger = logging.getLogger(__name__)

# RAG 查询优先锁：model_api_server 在 RAG 调用期间持有此文件锁。
# 知识提炼在调 LLM 前非阻塞 acquire；拿不到则跳过本轮，让 RAG 优先完成。
_RAG_LOCK_FILE = "/tmp/memory-bread-rag.lock"


def _rag_is_active() -> bool:
    """非阻塞检测 RAG 查询是否正在占用 Ollama。True 表示忙，提炼应跳过本轮。"""
    import fcntl
    try:
        fd = open(_RAG_LOCK_FILE, "w")
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        fcntl.flock(fd, fcntl.LOCK_UN)
        fd.close()
        return False  # 成功拿到锁 → RAG 不在跑
    except (IOError, OSError):
        return True   # 拿不到锁 → RAG 正在占用 Ollama


def _try_parse_json_like_object(text: str) -> Optional[Dict[str, Any]]:
    if not text:
        return None

    candidate = text.strip()
    if not candidate:
        return None

    normalized = (
        candidate
        .replace("“", '"')
        .replace("”", '"')
        .replace("‘", "'")
        .replace("’", "'")
    )

    variants = [candidate]
    if normalized != candidate:
        variants.append(normalized)

    for variant in variants:
        for parser in (json.loads, ast.literal_eval):
            try:
                value = parser(variant)
            except (json.JSONDecodeError, SyntaxError, ValueError):
                continue
            if isinstance(value, dict):
                return value

    return None


def _extract_json_object(raw: Any) -> Optional[Dict[str, Any]]:
    """尽量从 LLM 输出中提取第一个合法 JSON 对象。"""
    if raw is None:
        return None

    text = str(raw).strip()
    if not text:
        return None

    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    parsed = _try_parse_json_like_object(text)
    if parsed is not None:
        return parsed

    start = text.find('{')
    if start == -1:
        return None

    depth = 0
    in_string = False
    escape = False
    for idx in range(start, len(text)):
        ch = text[idx]
        if in_string:
            if escape:
                escape = False
            elif ch == '\\':
                escape = True
            elif ch == '"':
                in_string = False
            continue

        if ch == '"':
            in_string = True
        elif ch == '{':
            depth += 1
        elif ch == '}':
            depth -= 1
            if depth == 0:
                candidate = text[start:idx + 1]
                return _try_parse_json_like_object(candidate)

    return None


def _stringify_response_fragment(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        for key in ("content", "response", "text", "message", "thinking"):
            fragment = _stringify_response_fragment(value.get(key))
            if fragment.strip():
                return fragment
        try:
            return json.dumps(value, ensure_ascii=False)
        except TypeError:
            return str(value)
    if isinstance(value, list):
        parts = [_stringify_response_fragment(item) for item in value]
        return "\n".join(part for part in parts if part.strip())
    return str(value)


def _extract_attr(value: Any, name: str) -> Any:
    if value is None:
        return None
    if isinstance(value, dict):
        return value.get(name)
    return getattr(value, name, None)


def _extract_ollama_response_text(response: Dict[str, Any]) -> str:
    candidates = [
        _extract_attr(response, "message"),
        _extract_attr(response, "response"),
        _extract_attr(response, "content"),
        _extract_attr(response, "output"),
    ]
    for item in candidates:
        content = _extract_attr(item, "content")
        text = _stringify_response_fragment(content).strip()
        if text:
            return text

        direct_text = _extract_attr(item, "text")
        text = _stringify_response_fragment(direct_text).strip()
        if text:
            return text

        text = _stringify_response_fragment(item).strip()
        if text:
            return text
    return ""


def _preview_text(value: Any, limit: int = 500) -> str:
    text = _stringify_response_fragment(value).strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + " ...(已截断)"


UI_NOISE_LINE_PATTERNS = (
    re.compile(r'^(file|edit|selection|view|go|run|terminal|window|help)(\s+\w+){0,10}$', re.IGNORECASE),
    re.compile(r'^(welcome|explorer|extensions?)$', re.IGNORECASE),
    re.compile(r'^[\d\s]{4,}$'),
    re.compile(r'^[=+\-_*~•·。，、…<>|/\\]{3,}$'),
)

UI_NOISE_KEYWORDS = {
    'file', 'edit', 'selection', 'view', 'go', 'run', 'terminal', 'window', 'help',
    'welcome', 'explorer', 'bash tool output', 'taskoutput tool output',
}

WORK_ACTION_KEYWORDS = (
    '修复', '排查', '实现', '更新', '重启', '验证', '提炼', '分析', '编写',
    '调试', '优化', '新增', '删除', '合并', 'review', '检查', '对齐',
)


def _normalize_inline_text(text: str) -> str:
    return re.sub(r'\s+', ' ', str(text or '').replace('\r', ' ').replace('\n', ' ')).strip()


def _sanitize_capture_text(raw_text: str) -> str:
    lines = str(raw_text or '').replace('\r', '\n').split('\n')
    cleaned: List[str] = []
    prev = ''
    for line in lines:
        normalized = _normalize_inline_text(line)
        if not normalized:
            continue
        lowered = normalized.lower()
        if any(pattern.match(normalized) for pattern in UI_NOISE_LINE_PATTERNS):
            continue
        if lowered in UI_NOISE_KEYWORDS:
            continue
        if normalized == prev:
            continue
        cleaned.append(normalized)
        prev = normalized

    if cleaned:
        return '\n'.join(cleaned)
    return _normalize_inline_text(raw_text)


def _overview_quality_reason(overview: str, source_text: str) -> Optional[str]:
    compact = _normalize_inline_text(overview)
    if not compact or len(compact) < 16:
        return 'overview_too_short'

    if '\n' in str(overview or ''):
        return 'overview_contains_newline'

    lowered = compact.lower()
    ui_hits = sum(1 for keyword in UI_NOISE_KEYWORDS if keyword in lowered)
    has_action = any(keyword in compact for keyword in WORK_ACTION_KEYWORDS)
    if ui_hits >= 2 and not has_action:
        return 'ui_noise_dominant'

    words = re.findall(r'[a-zA-Z]+|\d+', lowered)
    if words:
        noisy_terms = sum(
            1
            for word in words
            if word.isdigit() or word in UI_NOISE_KEYWORDS
        )
        if len(words) >= 10 and (noisy_terms / len(words)) >= 0.32 and not has_action:
            return 'ui_noise_ratio_high'

    source_compact = _normalize_inline_text(source_text)
    if source_compact and compact in source_compact and not has_action:
        return 'overview_is_raw_copy'

    return None


def _overview_to_summary(overview: str, max_len: int = 42) -> str:
    compact = _normalize_inline_text(overview)
    if not compact:
        return "工作片段"
    sentence = re.split(r'[。！？!?]', compact, maxsplit=1)[0].strip() or compact
    if len(sentence) <= max_len:
        return sentence
    return sentence[:max_len].rstrip() + "…"


MERGE_SYSTEM_PROMPT ="""你是一个工作片段提炼助手。以下是用户在一段连续时间内的屏幕采集记录（按时间顺序），它们属于同一个工作片段。

**你的任务**：将这些连续采集提炼为一个完整的工作片段知识条目。

**提炼规则**：
1. 识别这段时间内用户在做的一件完整的事
2. **从工作内容中提炼工作项**：综合分析所有帧的内容，识别用户在做哪个项目/功能的工作
   - 从代码注释、函数名、文件路径、Git commit、文档标题、聊天主题等内容中提炼
   - 格式："项目名-功能模块"（如"MemoryBread-知识提炼优化"）或"项目名"（如"个人博客"）
   - 如果内容明确提到具体任务（如"修复 bug #123"），可以更具体（如"MemoryBread-修复排查步骤 bug"）
   - 如果无法从内容中识别，填写 null
3. **识别工作进度和状态**：从内容中推断当前工作的进展
   - work_status: "pending"（待启动）| "in_progress"（进行中）| "completed"（已完成）| "blocked"（阻塞）
   - work_progress: 具体进度描述（如"已完成核心逻辑"、"待其他团队协作"、"等待需求确认"）
4. 生成概述（50-150字）：描述做了什么、关键进展、结果，使用过去时态
5. 生成明细（200-500字）：
   - 保留有追溯价值的具体信息（代码逻辑、会议决策、学到的知识点）
   - 过滤掉 UI 操作、重复内容、无意义的切换记录
   - 不要堆砌原始文本，要提炼和归纳
6. 识别关键实体（人名、项目名、技术词汇）
7. 判断分类和重要性

**输出格式（JSON）**：
{
  "work_item": "项目名或项目名-功能模块，如 'MemoryBread-知识提炼优化'，无法识别时填 null",
  "work_status": "pending|in_progress|completed|blocked",
  "work_progress": "具体进度描述，如 '已完成核心逻辑，待集成测试'",
  "overview": "概述，50-150字，不含换行符",
  "details": "明细，200-500字，使用空格代替换行符",
  "entities": ["实体1", "实体2"],
  "category": "会议|文档|代码|聊天|学习|其他",
  "importance": 1-5,
  "history_view": true,
  "content_origin": "live_interaction|historical_content|document_reference|other",
  "activity_type": "meeting|coding|reading|chat|ask_ai|reviewing_history|other",
  "event_time_start": 1710000000000,
  "event_time_end": 1710003600000,
  "evidence_strength": "low|medium|high"
}

**注意补充判断**：
- **工作项识别示例**：
  * 代码文件 "extractor_v2.py" + 注释 "优化知识提炼逻辑" → work_item: "MemoryBread-知识提炼优化"
  * Git commit "fix: 修复排查步骤 bug" → work_item: "MemoryBread-修复排查步骤 bug"
  * 聊天记录讨论 "个人博客的评论功能需求" → work_item: "个人博客-评论功能"
  * 文档标题 "用户认证系统重构方案" → work_item: "用户认证系统-重构"
  * 如果只看到 "修复 bug"、"写代码" 等模糊描述，无法识别具体项目，填 null
- **工作进度识别示例**：
  * 看到 "TODO"、"开始实现" → work_status: "in_progress", work_progress: "刚开始开发"
  * 看到 "测试通过"、"已上线" → work_status: "completed", work_progress: "已完成并上线"
  * 看到 "等待"、"阻塞"、"依赖" → work_status: "blocked", work_progress: "等待其他团队协作"
  * 看到 "80% 完成"、"还剩最后一步" → work_status: "in_progress", work_progress: "已完成 80%"
- 如果用户今天在 IM/聊天/AI 工具里回看昨天、前天、更早的消息或历史对话，`history_view=true`
- `observed_at` 不需要输出，由系统记录当前片段结束时间
- `event_time_start/event_time_end` 只在内容明确提到事情发生时间时填写；不明确时返回 null
- 询问 Gemini/Claude/ChatGPT 等 AI 助手，通常可标为 `activity_type=ask_ai`
- 查看历史消息/历史会话，通常可标为 `activity_type=reviewing_history` 且 `content_origin=historical_content`
- 直接实时聊天或会议记录，通常 `content_origin=live_interaction`
- 证据弱、推断成分高时降低 `evidence_strength`

**重要性评分**：
- 5分：关键决策、重要会议纪要、核心代码逻辑
- 4分：项目进展、技术文档、重要沟通
- 3分：日常工作记录、一般文档
- 2分：简单操作记录
- 1分：无关紧要的内容

**注意**：输出必须是有效的 JSON，字符串中的引号要转义，不要包含未转义的换行符。
"""

BAKE_SHARED_PROMPT = """你在执行 bake pipeline 的类别特异提炼。输入是一条来自情节记忆/episodic memory 的候选工作片段。

目标不是泛泛总结，而是判断这条候选是否足以沉淀为某一类稳定资产。所有判断都必须保守：证据不足就 reject，不要为了凑产出而改写成看似合理的结果。

你会收到候选的 summary / overview / details / entities，以及关联 capture 的上下文文本。可以综合这些信息，但必须只基于输入证据，不要臆测。

输出要求：
- 必须返回且只返回 1 个 JSON 对象
- 顶层字段固定且仅允许：accepted, reason, payload
- `accepted` 为 true 时，`payload` 必须符合该类别 schema
- `accepted` 为 false 时，`payload` 必须为 null，并用 `reason` 简要说明为什么不适合该类别
- 不要输出 markdown，不要输出解释性前后缀，不要输出代码块，不要输出思考过程
- 所有字符串保持单行，避免换行和超长段落
- schema 外字段一律不要输出
- 输出前自检：结果必须能被 JSON 解析，且顶层只有 accepted/reason/payload 三个字段"""

BAKE_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "accepted": {"type": "boolean"},
        "reason": {"type": ["string", "null"]},
        "payload": {"type": ["object", "null"]},
    },
    "required": ["accepted", "reason", "payload"],
    "additionalProperties": False,
}


BAKE_TEMPLATE_MARKERS = (
    "模板",
    "骨架",
    "槽位",
    "填写",
    "结构",
    "段落",
    "框架",
    "提纲",
    "复用",
)

BAKE_KNOWLEDGE_MARKERS = (
    "经验",
    "结论",
    "决策",
    "约束",
    "事实",
    "观察",
    "原则",
    "根因",
    "教训",
    "发现",
    "踩坑",
    "原因",
)

BAKE_SOP_MARKERS = (
    "sop",
    "步骤",
    "step",
    "触发条件",
    "前置条件",
    "检查点",
    "预期结果",
    "排查",
    "流程",
    "操作",
    "执行",
    "验证",
)

BAKE_SCORE_METADATA_KEYS = {
    "match_score",
    "match_level",
    "review_status",
    "score",
    "confidence",
    "status",
    "auto_created",
    "candidate",
    "confirmed",
    "ignored",
}

BAKE_SCORE_METADATA_KEYWORDS = (
    "match_score",
    "match level",
    "match_level",
    "review_status",
    "confidence",
)

BAKE_MISMATCH_MAX_SCORE = 0.49


BAKE_KNOWLEDGE_PROMPT = """类别：knowledge

只提炼“可复用的事实 / 经验 / 决策 / 结论 / 约束 / 观察”。
如果输入只是过程片段、模板语气、零散操作，没有形成稳定知识，就 reject。

accepted=true 时，payload schema：
{
  "summary": "知识标题/摘要，简洁明确",
  "overview": "对该知识的概述，可为空",
  "entities": ["实体1", "实体2"],
  "importance": 1-5,
  "occurrence_count": 1,
  "observed_at": 1710000000000,
  "event_time_start": null,
  "event_time_end": null,
  "history_view": false,
  "content_origin": "live_interaction|historical_content|document_reference|other|null",
  "activity_type": "meeting|coding|reading|chat|ask_ai|reviewing_history|other|null",
  "evidence_strength": "low|medium|high|null",
  "evidence_summary": "一句话说明依据",
  "match_score": 0.0,
  "match_level": "high|medium|low",
  "review_status": "auto_created|candidate"
}

约束：
- `summary` 必须体现沉淀后的知识点，不要直接照抄流水账
- 如果输入重点是模板骨架、槽位设计、段落结构、可替换表达，即使可以总结出一些写作建议，也必须 reject，这类内容应交给 template 类别处理
- `match_score` 使用 0-1 小数
- 证据强、知识明确时才用 `auto_created`，否则用 `candidate`
- 若只是模糊猜测或噪声，直接 reject"""

BAKE_TEMPLATE_PROMPT = """类别：template

只提炼“可复用表达结构 / 模板骨架 / 段落框架 / 可替换槽位”。
普通总结、知识点、步骤说明都不能算模板。必须真的存在重复复用价值的结构化表达形态，否则 reject。

accepted=true 时，payload schema：
{
  "name": "模板名称",
  "category": "weekly_report|meeting_note|analysis|plan|generic",
  "status": "active",
  "tags": ["标签1", "标签2"],
  "applicable_tasks": ["适用场景1"],
  "linked_knowledge_ids": [],
  "structure_sections": [
    {"title": "段落标题", "keywords": ["关键词"], "notes": "如何填写，可为空"}
  ],
  "style_phrases": ["常用表达"],
  "replacement_rules": [
    {"from": "原表达", "to": "建议表达"}
  ],
  "prompt_hint": "如何使用该模板，可为空",
  "diagram_code": null,
  "image_assets": [],
  "evidence_summary": "一句话说明模板证据",
  "match_score": 0.0,
  "match_level": "high|medium|low",
  "review_status": "auto_created|candidate"
}

约束：
- 必须至少给出 2 个 `structure_sections`
- 必须体现“槽位/骨架/结构”而不是单次内容
- 如果只是某次会议/某段总结，不是模板，直接 reject
- 模板证据较弱时使用 `candidate`"""

BAKE_SOP_PROMPT = """类别：sop

只提炼“可执行步骤、触发条件、排查/处理流程、前置条件、检查点”。
如果输入没有清晰步骤化结构，或者只是描述结果/知识点，不是 SOP，直接 reject。

accepted=true 时，payload schema：
{
  "summary": "SOP 标题/摘要",
  "overview": "该 SOP 解决什么问题，可为空",
  "source_title": "来源标题，可为空",
  "trigger_keywords": ["触发词1", "触发词2"],
  "extracted_problem": "触发场景/问题",
  "steps": ["步骤1", "步骤2", "步骤3"],
  "linked_knowledge_ids": [],
  "confidence": "high|medium|low",
  "evidence_summary": "一句话说明步骤依据",
  "match_score": 0.0,
  "match_level": "high|medium|low",
  "review_status": "auto_created|candidate"
}

约束：
- `steps` 至少 3 条，且必须是可执行动作
- 没有明确步骤化流程就 reject
- 如果只是经验总结或模板骨架，不要误判成 SOP"""

MERGE_SYSTEM_PROMPT ="""你是一个工作片段提炼助手。以下是用户在一段连续时间内的屏幕采集记录（按时间顺序），它们属于同一个工作片段。

**你的任务**：将这些连续采集提炼为一个完整的工作片段知识条目。

**提炼规则**：
1. 识别这段时间内用户在做的一件完整的事
2. **从工作内容中提炼工作项**：综合分析所有帧的内容，识别用户在做哪个项目/功能的工作
   - 从代码注释、函数名、文件路径、Git commit、文档标题、聊天主题等内容中提炼
   - 格式："项目名-功能模块"（如"MemoryBread-知识提炼优化"）或"项目名"（如"个人博客"）
   - 如果内容明确提到具体任务（如"修复 bug #123"），可以更具体（如"MemoryBread-修复排查步骤 bug"）
   - 如果无法从内容中识别，填写 null
3. **识别工作进度和状态**：从内容中推断当前工作的进展
   - work_status: "pending"（待启动）| "in_progress"（进行中）| "completed"（已完成）| "blocked"（阻塞）
   - work_progress: 具体进度描述（如"已完成核心逻辑"、"待其他团队协作"、"等待需求确认"）
4. 生成概述（50-150字）：描述做了什么、关键进展、结果，使用过去时态
5. 生成明细（200-500字）：
   - 保留有追溯价值的具体信息（代码逻辑、会议决策、学到的知识点）
   - 过滤掉 UI 操作、重复内容、无意义的切换记录
   - 不要堆砌原始文本，要提炼和归纳
6. 识别关键实体（人名、项目名、技术词汇）
7. 判断分类和重要性

**输出格式（JSON）**：
{
  "work_item": "项目名或项目名-功能模块，如 'MemoryBread-知识提炼优化'，无法识别时填 null",
  "work_status": "pending|in_progress|completed|blocked",
  "work_progress": "具体进度描述，如 '已完成核心逻辑，待集成测试'",
  "overview": "概述，50-150字，不含换行符",
  "details": "明细，200-500字，使用空格代替换行符",
  "entities": ["实体1", "实体2"],
  "category": "会议|文档|代码|聊天|学习|其他",
  "importance": 1-5,
  "history_view": true,
  "content_origin": "live_interaction|historical_content|document_reference|other",
  "activity_type": "meeting|coding|reading|chat|ask_ai|reviewing_history|other",
  "event_time_start": 1710000000000,
  "event_time_end": 1710003600000,
  "evidence_strength": "low|medium|high"
}

**注意补充判断**：
- **工作项识别示例**：
  * 代码文件 "extractor_v2.py" + 注释 "优化知识提炼逻辑" → work_item: "MemoryBread-知识提炼优化"
  * Git commit "fix: 修复排查步骤 bug" → work_item: "MemoryBread-修复排查步骤 bug"
  * 聊天记录讨论 "个人博客的评论功能需求" → work_item: "个人博客-评论功能"
  * 文档标题 "用户认证系统重构方案" → work_item: "用户认证系统-重构"
  * 如果只看到 "修复 bug"、"写代码" 等模糊描述，无法识别具体项目，填 null
- **工作进度识别示例**：
  * 看到 "TODO"、"开始实现" → work_status: "in_progress", work_progress: "刚开始开发"
  * 看到 "测试通过"、"已上线" → work_status: "completed", work_progress: "已完成并上线"
  * 看到 "等待"、"阻塞"、"依赖" → work_status: "blocked", work_progress: "等待其他团队协作"
  * 看到 "80% 完成"、"还剩最后一步" → work_status: "in_progress", work_progress: "已完成 80%"
- 如果用户今天在 IM/聊天/AI 工具里回看昨天、前天、更早的消息或历史对话，`history_view=true`
- `observed_at` 不需要输出，由系统记录当前片段结束时间
- `event_time_start/event_time_end` 只在内容明确提到事情发生时间时填写；不明确时返回 null
- 询问 Gemini/Claude/ChatGPT 等 AI 助手，通常可标为 `activity_type=ask_ai`
- 查看历史消息/历史会话，通常可标为 `activity_type=reviewing_history` 且 `content_origin=historical_content`
- 直接实时聊天或会议记录，通常 `content_origin=live_interaction`
- 证据弱、推断成分高时降低 `evidence_strength`

**重要性评分**：
- 5分：关键决策、重要会议纪要、核心代码逻辑
- 4分：项目进展、技术文档、重要沟通
- 3分：日常工作记录、一般文档
- 2分：简单操作记录
- 1分：无关紧要的内容

**注意**：输出必须是有效的 JSON，字符串中的引号要转义，不要包含未转义的换行符。
"""

SYSTEM_PROMPT = """你是一个专业的工作记录提炼助手。你的任务是从 OCR 识别的屏幕文本中提取有价值的工作信息。

**提炼规则**：
1. 忽略 UI 元素（按钮、菜单、状态栏等）
2. 提取核心工作内容（会议记录、文档内容、代码片段、聊天记录等）
3. 生成"概述"和"明细"两部分内容：
   - 概述：简洁描述在做什么事情（30-100字），使用过去时态，避免使用"正在"等词
   - 明细：详细记录具体内容细节，保留关键信息以便后期追溯（200-500字）
4. 识别关键实体（人名、项目名、时间、地点）
5. 如果内容无价值（纯 UI、重复内容），返回 "SKIP"

**输出格式**（JSON）：
{
  "overview": "概述文本，描述做了什么事情，不要包含换行符",
  "details": "明细文本，使用空格代替换行符",
  "entities": ["实体1", "实体2"],
  "category": "会议|文档|代码|聊天|其他",
  "importance": 1-5
}

**重要性评分标准**：
- 5分：关键决策、重要会议纪要、核心代码逻辑
- 4分：项目进展、技术文档、重要沟通
- 3分：日常工作记录、一般文档
- 2分：简单操作记录
- 1分：无关紧要的内容

**明细内容要求**：
- 保留足够的上下文信息
- 记录关键对话内容和参与人
- 保留代码片段和技术细节
- 记录决策过程和理由
- 便于后期回忆和追溯
- 所有文本必须在一行内，不要使用换行符

**注意**：输出必须是有效的 JSON 格式，字符串中的引号要转义，不要包含未转义的换行符。
"""


def _build_fallback_knowledge(captures: List[Dict[str, Any]], reason: str) -> Optional[Dict[str, Any]]:
    """当 LLM 输出异常时，生成兜底 knowledge，避免队头 capture 永久卡住。"""
    if not captures:
        return None

    text_samples = []
    for capture in captures:
        text = (capture.get('ocr_text') or capture.get('ax_text') or '').strip()
        if text:
            text_samples.append(text.replace('\n', ' ')[:200])

    if not text_samples:
        return None

    start_time = captures[0]['ts']
    end_time = captures[-1]['ts']
    duration_minutes = max(0, int((end_time - start_time) / 60000))

    from collections import Counter
    app_counter = Counter(c.get('app_name') for c in captures if c.get('app_name'))
    frag_app_name = app_counter.most_common(1)[0][0] if app_counter else None
    frag_win_title = next(
        (c.get('window_title') for c in reversed(captures) if c.get('window_title')),
        None,
    )

    details = ' '.join(text_samples[:5])
    if len(details) > 500:
        details = details[:500]

    return {
        'capture_ids': json.dumps([c['id'] for c in captures]),
        'overview': f'低价值工作片段（{reason}）',
        'details': details,
        'entities': json.dumps([], ensure_ascii=False),
        'category': '其他',
        'importance': 1,
        'occurrence_count': 1,
        'start_time': start_time,
        'end_time': end_time,
        'duration_minutes': duration_minutes,
        'frag_app_name': frag_app_name,
        'frag_win_title': frag_win_title,
        'observed_at': end_time,
        'event_time_start': None,
        'event_time_end': None,
        'history_view': False,
        'content_origin': 'other',
        'activity_type': 'other',
        'is_self_generated': False,
        'evidence_strength': 'low',
    }


class KnowledgeExtractorV2:
    """知识提炼器 V2 - 强制使用 LLM"""

    def __init__(self, model: str = "qwen2.5:3b", embedding_model=None, user_identity: str = ""):
        """
        初始化知识提炼器

        Args:
            model: Ollama 模型名称
            embedding_model: 向量模型（用于去重）
            user_identity: 用户身份关键词，多个用逗号分隔（如 "张三,zhangsan"）
        """
        try:
            from ollama import Client
            # 每次 LLM 调用最多等 90 秒，避免长时间独占 Ollama 导致 RAG 查询超时
            self.client = Client(timeout=90)
            self.model = model

            # 测试模型是否可用
            try:
                self.client.list()
                logger.info(f"✅ Ollama 客户端初始化成功，模型: {model}")
            except Exception as e:
                raise RuntimeError(f"Ollama 服务不可用: {e}")

        except ImportError:
            raise RuntimeError("Ollama 未安装，请先安装: pip install ollama")

        self.embedding_model = embedding_model
        if embedding_model:
            logger.info("✅ 向量模型已加载，将启用知识去重")

        self.user_identity = user_identity.strip()
        if self.user_identity:
            logger.info(f"✅ 用户身份已配置: {self.user_identity}")

    def _build_merge_system_prompt(self) -> str:
        """构建带用户身份的 MERGE_SYSTEM_PROMPT"""
        identity_clause = ""
        if self.user_identity:
            names = [n.strip() for n in self.user_identity.split(",") if n.strip()]
            names_str = "、".join(f'"{n}"' for n in names)
            identity_clause = (
                f"\n\n**用户身份信息**：屏幕的使用者是 {names_str}。"
                "在提炼时，请注意：\n"
                "- 如果屏幕内容是该用户自己操作、输入、编写的工作，activity_type 应正确标注为对应类型（coding/reading/chat 等）\n"
                "- 如果屏幕内容显示的是其他人（非该用户）的工作、他人的对话记录、别人的代码或文档，overview 中应明确说明「用户在查看他人的…」，importance 降低 1-2 分\n"
                "- 如果无法判断内容主体，按正常流程提炼，不要猜测"
            )
        return MERGE_SYSTEM_PROMPT + identity_clause

    def _build_prompt(self, capture_data: Dict[str, Any]) -> str:
        """构建提炼 prompt"""
        app_name = capture_data.get('app_name', '未知应用')
        window_title = capture_data.get('window_title', '未知窗口')
        timestamp = capture_data.get('timestamp', datetime.now().isoformat())
        raw_text = capture_data.get('ocr_text') or capture_data.get('ax_text') or ''
        ocr_text = _sanitize_capture_text(raw_text)

        # 限制文本长度，避免超过上下文
        if len(ocr_text) > 2000:
            ocr_text = ocr_text[:2000] + "..."

        prompt = f"""**应用名称**：{app_name}
**窗口标题**：{window_title}
**时间戳**：{timestamp}
**OCR 文本**：
{ocr_text}

请提炼上述内容。要求：必须总结工作动作与结果，禁止照抄菜单词/窗口壳层词或原始 OCR 长串。"""

        return prompt

    def _find_similar_knowledge(
        self,
        overview: str,
        db_conn,
        threshold: float = 0.72,
        entities: Optional[List[str]] = None,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
    ) -> Optional[int]:
        """
        查找相似的知识条目

        Args:
            overview: 新的概述
            db_conn: 数据库连接
            threshold: 相似度阈值（0-1），默认 0.72
            entities: 新知识的实体列表，用于增强相似度判断

        Returns:
            相似知识条目的 ID，如果没有则返回 None
        """
        if not self.embedding_model:
            return None

        try:
            # 1. 获取新概述的向量
            new_embedding = self.embedding_model.encode([overview])[0]
            new_vector = np.array(new_embedding.vector)
            new_norm = np.linalg.norm(new_vector)
            if new_norm == 0:
                return None

            # 2. 获取所有现有知识条目（仅取最近 500 条，提高相关性）
            cursor = db_conn.execute(
                "SELECT id, overview, entities, start_time, end_time FROM episodic_memories WHERE overview IS NOT NULL ORDER BY created_at DESC LIMIT 500"
            )
            existing_entries = cursor.fetchall()

            if not existing_entries:
                return None

            # 3. 批量编码现有 overview，避免逐条调用
            existing_ids = [row[0] for row in existing_entries]
            existing_overviews = [row[1] or '' for row in existing_entries]
            existing_entities_raw = [row[2] for row in existing_entries]
            existing_start_times = [row[3] for row in existing_entries]
            existing_end_times = [row[4] for row in existing_entries]

            batch_embeddings = self.embedding_model.encode(existing_overviews)
            existing_vectors = np.array([np.array(e.vector) for e in batch_embeddings])
            existing_norms = np.linalg.norm(existing_vectors, axis=1)

            # 4. 批量计算余弦相似度
            valid_mask = existing_norms > 0
            similarities = np.zeros(len(existing_entries))
            if valid_mask.any():
                similarities[valid_mask] = (
                    existing_vectors[valid_mask] @ new_vector
                ) / (existing_norms[valid_mask] * new_norm)

            # 5. 实体重叠增强：同名实体出现在两条知识中，相似度+0.05
            new_entity_set = set(e.lower() for e in (entities or []) if e)
            for i, raw in enumerate(existing_entities_raw):
                if not new_entity_set or not raw:
                    continue
                try:
                    existing_entity_set = set(e.lower() for e in json.loads(raw) if e)
                    overlap = new_entity_set & existing_entity_set
                    if overlap:
                        similarities[i] += 0.05 * min(len(overlap), 2)
                except Exception:
                    pass

            # 6. 连续片段保护：时间重叠或紧邻的同一事件，不计为新的重复观察
            continuity_gap_ms = 15 * 60 * 1000
            if start_time is not None and end_time is not None:
                for i, (existing_start, existing_end) in enumerate(zip(existing_start_times, existing_end_times)):
                    if existing_start is None or existing_end is None:
                        continue
                    overlaps = start_time <= existing_end and end_time >= existing_start
                    near_continuation = 0 <= start_time - existing_end <= continuity_gap_ms
                    if overlaps or near_continuation:
                        similarities[i] = min(similarities[i], threshold - 0.01)
                        logger.info(
                            "跳过连续片段重复计数候选 (ID=%s, overlap=%s, gap_ms=%s)",
                            existing_ids[i],
                            overlaps,
                            max(0, start_time - existing_end),
                        )

            # 7. 取相似度最高的条目
            best_idx = int(np.argmax(similarities))
            best_sim = float(similarities[best_idx])
            if best_sim >= threshold:
                entry_id = existing_ids[best_idx]
                logger.info(f"发现相似知识条目 (ID={entry_id}, 相似度={best_sim:.2f})")
                return entry_id

            return None

        except Exception as e:
            logger.error(f"查找相似知识失败: {e}")
            return None

    def _truncate_text(self, value: Any, limit: int) -> str:
        text = str(value or '').strip()
        if len(text) <= limit:
            return text
        return text[:limit].rstrip() + " ...(已截断)"

    def _sanitize_bake_details_value(self, value: Any) -> Any:
        if isinstance(value, dict):
            cleaned: Dict[str, Any] = {}
            for raw_key, raw_value in value.items():
                key = str(raw_key or '').strip()
                normalized_key = key.lower().replace('-', '_').replace(' ', '_')
                if normalized_key in BAKE_SCORE_METADATA_KEYS:
                    continue
                if any(keyword in normalized_key for keyword in BAKE_SCORE_METADATA_KEYWORDS):
                    continue
                nested = self._sanitize_bake_details_value(raw_value)
                if nested in (None, '', [], {}):
                    continue
                cleaned[key] = nested
            return cleaned

        if isinstance(value, list):
            cleaned_items = [self._sanitize_bake_details_value(item) for item in value]
            return [item for item in cleaned_items if item not in (None, '', [], {})]

        return value

    def _sanitize_bake_details_text(self, value: Any) -> str:
        if value is None:
            return ''

        if isinstance(value, (dict, list)):
            cleaned = self._sanitize_bake_details_value(value)
            if cleaned in (None, '', [], {}):
                return ''
            return json.dumps(cleaned, ensure_ascii=False)

        raw_text = str(value or '').strip()
        if not raw_text:
            return ''

        parsed = _try_parse_json_like_object(raw_text)
        if isinstance(parsed, dict):
            cleaned = self._sanitize_bake_details_value(parsed)
            if cleaned in (None, '', [], {}):
                return ''
            return json.dumps(cleaned, ensure_ascii=False)

        lines = []
        for line in raw_text.splitlines():
            normalized_line = line.lower()
            if any(keyword in normalized_line for keyword in BAKE_SCORE_METADATA_KEYWORDS):
                continue
            lines.append(line)
        return '\n'.join(lines).strip()

    def _build_bake_semantic_text(self, candidate: Dict[str, Any], payload: Dict[str, Any]) -> tuple[str, str]:
        candidate_text = "\n".join(
            str(candidate.get(field) or '')
            for field in (
                'summary',
                'overview',
                'details',
                'capture_ax_text',
                'capture_ocr_text',
                'capture_input_text',
                'capture_audio_text',
            )
        )
        entities = candidate.get('entities') or []
        if entities:
            candidate_text += "\n" + " ".join(str(item) for item in entities if item)

        payload_text = json.dumps(payload, ensure_ascii=False) if isinstance(payload, dict) else str(payload or '')
        return candidate_text, payload_text

    def _build_bake_candidate_text(self, candidate: Dict[str, Any]) -> str:
        entities = candidate.get('entities') or []
        entities_text = "、".join(str(item) for item in entities if item)
        sanitized_details = self._sanitize_bake_details_text(candidate.get('details'))
        capture_parts = [
            self._truncate_text(candidate.get('capture_ax_text'), 600),
            self._truncate_text(candidate.get('capture_ocr_text'), 600),
            self._truncate_text(candidate.get('capture_input_text'), 300),
            self._truncate_text(candidate.get('capture_audio_text'), 300),
        ]
        capture_text = "\n\n".join(part for part in capture_parts if part)
        if len(capture_text) > 1800:
            capture_text = capture_text[:1800].rstrip() + "\n...(已截断)"

        return (
            f"source_knowledge_id: {candidate.get('source_knowledge_id')}\n"
            f"source_capture_id: {candidate.get('source_capture_id')}\n"
            f"work_item: {candidate.get('work_item') or ''}\n"
            f"work_status: {candidate.get('work_status') or ''}\n"
            f"work_progress: {candidate.get('work_progress') or ''}\n"
            f"summary: {self._truncate_text(candidate.get('summary'), 180)}\n"
            f"overview: {self._truncate_text(candidate.get('overview'), 280)}\n"
            f"details: {self._truncate_text(sanitized_details, 700)}\n"
            f"importance: {candidate.get('importance')}\n"
            f"occurrence_count: {candidate.get('occurrence_count')}\n"
            f"observed_at: {candidate.get('observed_at')}\n"
            f"event_time_start: {candidate.get('event_time_start')}\n"
            f"event_time_end: {candidate.get('event_time_end')}\n"
            f"history_view: {bool(candidate.get('history_view', False))}\n"
            f"content_origin: {candidate.get('content_origin') or ''}\n"
            f"activity_type: {candidate.get('activity_type') or ''}\n"
            f"evidence_strength: {candidate.get('evidence_strength') or ''}\n"
            f"capture_ts: {candidate.get('capture_ts')}\n"
            f"capture_app_name: {self._truncate_text(candidate.get('capture_app_name'), 80)}\n"
            f"capture_win_title: {self._truncate_text(candidate.get('capture_win_title'), 120)}\n"
            f"entities: {self._truncate_text(entities_text, 160)}\n\n"
            f"capture_context:\n{capture_text}"
        )

    def _count_marker_hits(self, text: str, markers: tuple[str, ...]) -> int:
        normalized = str(text or '').lower()
        return sum(1 for marker in markers if marker and marker.lower() in normalized)

    def _should_reject_template_like_knowledge(self, candidate: Dict[str, Any], payload: Dict[str, Any]) -> bool:
        candidate_text, payload_text = self._build_bake_semantic_text(candidate, payload)
        candidate_template_hits = self._count_marker_hits(candidate_text, BAKE_TEMPLATE_MARKERS)
        payload_template_hits = self._count_marker_hits(payload_text, BAKE_TEMPLATE_MARKERS)
        knowledge_hits = self._count_marker_hits(candidate_text + "\n" + payload_text, BAKE_KNOWLEDGE_MARKERS)
        return candidate_template_hits >= 2 and payload_template_hits >= 1 and knowledge_hits == 0

    def _should_reject_sop_like_knowledge(self, candidate: Dict[str, Any], payload: Dict[str, Any]) -> bool:
        candidate_text, payload_text = self._build_bake_semantic_text(candidate, payload)
        candidate_sop_hits = self._count_marker_hits(candidate_text, BAKE_SOP_MARKERS)
        payload_sop_hits = self._count_marker_hits(payload_text, BAKE_SOP_MARKERS)
        knowledge_hits = self._count_marker_hits(candidate_text + "\n" + payload_text, BAKE_KNOWLEDGE_MARKERS)
        return candidate_sop_hits >= 2 and payload_sop_hits >= 1 and knowledge_hits == 0

    def _resolve_bake_artifact_mismatch_reason(self, artifact_type: str, candidate: Dict[str, Any], payload: Dict[str, Any]) -> Optional[str]:
        candidate_text, payload_text = self._build_bake_semantic_text(candidate, payload)

        template_hits = self._count_marker_hits(candidate_text + "\n" + payload_text, BAKE_TEMPLATE_MARKERS)
        sop_hits = self._count_marker_hits(candidate_text + "\n" + payload_text, BAKE_SOP_MARKERS)
        knowledge_hits = self._count_marker_hits(candidate_text + "\n" + payload_text, BAKE_KNOWLEDGE_MARKERS)
        candidate_template_hits = self._count_marker_hits(candidate_text, BAKE_TEMPLATE_MARKERS)
        candidate_sop_hits = self._count_marker_hits(candidate_text, BAKE_SOP_MARKERS)

        if artifact_type == 'knowledge':
            if self._should_reject_template_like_knowledge(candidate, payload):
                return 'template_like_content'
            if self._should_reject_sop_like_knowledge(candidate, payload):
                return 'sop_like_content'
            return None

        if artifact_type == 'template':
            if sop_hits >= 3 and template_hits <= 1:
                return 'sop_like_content'
            if knowledge_hits >= 3 and template_hits <= 1:
                return 'knowledge_like_content'
            return None

        if artifact_type == 'sop':
            if template_hits >= 3 and candidate_template_hits >= 2 and candidate_sop_hits <= 1:
                return 'template_like_content'
            if knowledge_hits >= 3 and sop_hits <= 1:
                return 'knowledge_like_content'
            return None

        return None

    def _downgrade_mismatch_payload(self, payload: Dict[str, Any], reason: str) -> Dict[str, Any]:
        adjusted = dict(payload)
        score = adjusted.get('match_score')
        if isinstance(score, (int, float)):
            adjusted['match_score'] = min(float(score), BAKE_MISMATCH_MAX_SCORE)
        else:
            adjusted['match_score'] = BAKE_MISMATCH_MAX_SCORE
        adjusted['match_level'] = 'low'
        adjusted['review_status'] = 'candidate'
        evidence = str(adjusted.get('evidence_summary') or '').strip()
        adjusted['evidence_summary'] = f"{evidence} | mismatch_guard={reason}" if evidence else f"mismatch_guard={reason}"
        return adjusted

    def _call_bake_llm(self, caller_id: str, system_prompt: str, user_prompt: str) -> tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
        from monitor.llm_tracker import LLMCallTracker, estimate_tokens

        started_at = time.time()
        logger.info("bake llm start caller=%s", caller_id)
        with LLMCallTracker(
            caller="bake",
            model_name=self.model,
            caller_id=caller_id,
        ) as tracker:
            response = self.client.chat(
                model=self.model,
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                think=False,
                format=BAKE_RESPONSE_SCHEMA,
                options={"temperature": 0.0, "num_predict": 1024},
            )
            raw_content = _extract_ollama_response_text(response)
            tracker.set_response(response)
            if tracker._prompt_tokens == 0:
                tracker.set_tokens(
                    prompt=estimate_tokens(system_prompt + user_prompt),
                    completion=estimate_tokens(raw_content),
                )

        elapsed_ms = int((time.time() - started_at) * 1000)
        logger.info(
            "bake llm done caller=%s elapsed_ms=%s raw_len=%s",
            caller_id,
            elapsed_ms,
            len(raw_content),
        )

        parsed = _extract_json_object(raw_content)
        if parsed is None:
            logger.warning(
                "bake llm raw response caller=%s raw=%s response=%s",
                caller_id,
                _preview_text(raw_content, 800),
                _preview_text(response, 800),
            )
        usage = response.get('usage') or {}
        usage_summary = {
            'prompt_tokens': usage.get('prompt_tokens') or response.get('prompt_eval_count') or estimate_tokens(system_prompt + user_prompt),
            'completion_tokens': usage.get('completion_tokens') or response.get('eval_count') or estimate_tokens(raw_content),
        }
        return parsed, {
            'usage': usage_summary,
            'model': response.get('model') or self.model,
            'raw_content': raw_content,
            'raw_preview': _preview_text(raw_content),
            'response_preview': _preview_text(response),
            'empty_content': not bool(raw_content.strip()),
            'elapsed_ms': elapsed_ms,
        }

    def _extract_bake_artifact(self, candidate: Dict[str, Any], artifact_type: str, artifact_prompt: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
        candidate_text = self._build_bake_candidate_text(candidate)
        system_prompt = BAKE_SHARED_PROMPT + "\n\n" + artifact_prompt
        user_prompt = f"候选输入如下：\n\n{candidate_text}"
        caller_id = f"{artifact_type}:{candidate.get('source_knowledge_id')}"
        started_at = time.time()
        logger.info("bake artifact start type=%s caller=%s", artifact_type, caller_id)

        try:
            parsed, meta = self._call_bake_llm(caller_id, system_prompt, user_prompt)
        except Exception as e:
            elapsed_ms = int((time.time() - started_at) * 1000)
            logger.error("bake %s 提炼失败 caller=%s elapsed_ms=%s error=%s", artifact_type, caller_id, elapsed_ms, e)
            return {
                'accepted': False,
                'reason': f'llm_error: {e}',
                'payload': None,
            }, {
                'usage': None,
                'model': self.model,
                'degraded': True,
                'elapsed_ms': elapsed_ms,
            }

        elapsed_ms = int((time.time() - started_at) * 1000)

        if not parsed:
            reason = 'empty_content' if meta.get('empty_content') else 'invalid_json'
            logger.warning(
                "bake %s 提炼响应不可解析 caller=%s reason=%s elapsed_ms=%s raw=%s response=%s",
                artifact_type,
                caller_id,
                reason,
                elapsed_ms,
                meta.get('raw_preview', ''),
                meta.get('response_preview', ''),
            )
            return {
                'accepted': False,
                'reason': reason,
                'payload': None,
            }, {
                'usage': meta['usage'],
                'model': meta['model'],
                'degraded': True,
                'elapsed_ms': elapsed_ms,
            }

        accepted = bool(parsed.get('accepted', False))
        reason = parsed.get('reason')
        payload = parsed.get('payload')
        if accepted and payload is None:
            logger.warning(
                "bake %s accepted without payload caller=%s elapsed_ms=%s",
                artifact_type,
                caller_id,
                elapsed_ms,
            )
            return {
                'accepted': False,
                'reason': 'accepted_without_payload',
                'payload': None,
            }, {
                'usage': meta['usage'],
                'model': meta['model'],
                'degraded': True,
                'elapsed_ms': elapsed_ms,
            }

        if accepted and not isinstance(payload, dict):
            logger.warning(
                "bake %s malformed payload caller=%s elapsed_ms=%s payload_type=%s",
                artifact_type,
                caller_id,
                elapsed_ms,
                type(payload).__name__,
            )
            return {
                'accepted': False,
                'reason': 'malformed_payload',
                'payload': None,
            }, {
                'usage': meta['usage'],
                'model': meta['model'],
                'degraded': True,
                'elapsed_ms': elapsed_ms,
            }

        if accepted:
            mismatch_reason = self._resolve_bake_artifact_mismatch_reason(artifact_type, candidate, payload)
            if mismatch_reason and artifact_type == 'knowledge':
                logger.info(
                    "bake knowledge rejected as mismatch caller=%s elapsed_ms=%s reason=%s",
                    caller_id,
                    elapsed_ms,
                    mismatch_reason,
                )
                return {
                    'accepted': False,
                    'reason': mismatch_reason,
                    'payload': None,
                }, {
                    'usage': meta['usage'],
                    'model': meta['model'],
                    'degraded': False,
                    'elapsed_ms': elapsed_ms,
                }

            if mismatch_reason:
                payload = self._downgrade_mismatch_payload(payload, mismatch_reason)
                reason = reason or mismatch_reason
                logger.info(
                    "bake %s mismatch downgraded caller=%s elapsed_ms=%s reason=%s score=%s level=%s",
                    artifact_type,
                    caller_id,
                    elapsed_ms,
                    mismatch_reason,
                    payload.get('match_score'),
                    payload.get('match_level'),
                )

        logger.info(
            "bake artifact done type=%s caller=%s accepted=%s elapsed_ms=%s reason=%s",
            artifact_type,
            caller_id,
            accepted,
            elapsed_ms,
            reason,
        )

        if not accepted:
            return {
                'accepted': False,
                'reason': reason or 'rejected',
                'payload': None,
            }, {
                'usage': meta['usage'],
                'model': meta['model'],
                'degraded': False,
                'elapsed_ms': elapsed_ms,
            }

        return {
            'accepted': True,
            'reason': reason,
            'payload': payload,
        }, {
            'usage': meta['usage'],
            'model': meta['model'],
            'degraded': False,
            'elapsed_ms': elapsed_ms,
        }

    def extract_bake_knowledge(self, candidate: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self._extract_bake_artifact(candidate, 'knowledge', BAKE_KNOWLEDGE_PROMPT)

    def extract_bake_template(self, candidate: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self._extract_bake_artifact(candidate, 'template', BAKE_TEMPLATE_PROMPT)

    def extract_bake_sop(self, candidate: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self._extract_bake_artifact(candidate, 'sop', BAKE_SOP_PROMPT)

    def extract_bake_bundle(self, candidate: Dict[str, Any], preempt_check=None) -> Dict[str, Any]:
        """提炼 bake bundle（知识/模板/SOP），支持抢占中断。

        Args:
            candidate: 候选知识条目
            preempt_check: 抢占检查函数，返回 True 表示需要中断

        Returns:
            提炼结果字典，如果被抢占则 degraded=True
        """
        bundle_started_at = time.time()
        source_knowledge_id = candidate.get('source_knowledge_id')
        logger.info("bake bundle start source_knowledge_id=%s", source_knowledge_id)

        # 检查抢占信号
        if preempt_check and preempt_check():
            logger.info("bake bundle 收到抢占信号，中断提炼 source_knowledge_id=%s", source_knowledge_id)
            return {
                'knowledge': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'template': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'sop': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'usage': None,
                'model': self.model,
                'degraded': True,
                'stage_elapsed_ms': {},
                'total_elapsed_ms': int((time.time() - bundle_started_at) * 1000),
            }

        knowledge, knowledge_meta = self.extract_bake_knowledge(candidate)

        # 每个阶段后检查抢占
        if preempt_check and preempt_check():
            logger.info("bake bundle 在 knowledge 后收到抢占信号 source_knowledge_id=%s", source_knowledge_id)
            return {
                'knowledge': knowledge,
                'template': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'sop': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'usage': knowledge_meta.get('usage'),
                'model': knowledge_meta.get('model') or self.model,
                'degraded': True,
                'stage_elapsed_ms': {'knowledge': int(knowledge_meta.get('elapsed_ms') or 0)},
                'total_elapsed_ms': int((time.time() - bundle_started_at) * 1000),
            }

        template, template_meta = self.extract_bake_template(candidate)

        if preempt_check and preempt_check():
            logger.info("bake bundle 在 template 后收到抢占信号 source_knowledge_id=%s", source_knowledge_id)
            usage_items = [meta.get('usage') for meta in (knowledge_meta, template_meta) if meta.get('usage')]
            usage = None
            if usage_items:
                usage = {
                    'prompt_tokens': sum(int(item.get('prompt_tokens') or 0) for item in usage_items),
                    'completion_tokens': sum(int(item.get('completion_tokens') or 0) for item in usage_items),
                }
            return {
                'knowledge': knowledge,
                'template': template,
                'sop': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'usage': usage,
                'model': template_meta.get('model') or self.model,
                'degraded': True,
                'stage_elapsed_ms': {
                    'knowledge': int(knowledge_meta.get('elapsed_ms') or 0),
                    'template': int(template_meta.get('elapsed_ms') or 0),
                },
                'total_elapsed_ms': int((time.time() - bundle_started_at) * 1000),
            }

        sop, sop_meta = self.extract_bake_sop(candidate)

        usage_items = [meta.get('usage') for meta in (knowledge_meta, template_meta, sop_meta) if meta.get('usage')]
        usage = None
        if usage_items:
            usage = {
                'prompt_tokens': sum(int(item.get('prompt_tokens') or 0) for item in usage_items),
                'completion_tokens': sum(int(item.get('completion_tokens') or 0) for item in usage_items),
            }

        models = [meta.get('model') for meta in (knowledge_meta, template_meta, sop_meta) if meta.get('model')]
        degraded = any(bool(meta.get('degraded')) for meta in (knowledge_meta, template_meta, sop_meta))
        total_elapsed_ms = int((time.time() - bundle_started_at) * 1000)
        per_stage_ms = {
            'knowledge': int(knowledge_meta.get('elapsed_ms') or 0),
            'template': int(template_meta.get('elapsed_ms') or 0),
            'sop': int(sop_meta.get('elapsed_ms') or 0),
        }
        logger.info(
            "bake bundle done source_knowledge_id=%s total_elapsed_ms=%s stage_elapsed_ms=%s degraded=%s accepted={knowledge:%s,template:%s,sop:%s}",
            source_knowledge_id,
            total_elapsed_ms,
            per_stage_ms,
            degraded,
            knowledge.get('accepted'),
            template.get('accepted'),
            sop.get('accepted'),
        )

        return {
            'knowledge': knowledge,
            'template': template,
            'sop': sop,
            'usage': usage,
            'model': models[0] if models else self.model,
            'degraded': degraded,
            'stage_elapsed_ms': per_stage_ms,
            'total_elapsed_ms': total_elapsed_ms,
        }

    def extract_sync(
        self,
        capture_data: Dict[str, Any],
        db_conn=None
    ) -> Optional[Dict[str, Any]]:
        """
        同步版本的提炼方法

        Args:
            capture_data: 采集数据
            db_conn: 数据库连接（用于去重）

        Returns:
            提炼后的知识，如果无价值或重复则返回 None
        """
        try:
            # 1. 构建 prompt
            prompt = self._build_prompt(capture_data)

            # 2. 调用本地 LLM（带埋点）
            logger.info(f"开始提炼采集记录 {capture_data.get('id')}")
            # RAG 优先：若 RAG 查询正在占用 Ollama，跳过本轮提炼
            if _rag_is_active():
                logger.info("RAG 查询正在进行，本轮提炼跳过")
                return None
            from monitor.llm_tracker import LLMCallTracker, estimate_tokens
            with LLMCallTracker(
                caller="knowledge",
                model_name=self.model,
                caller_id=str(capture_data.get('id')),
            ) as tracker:
                response = self.client.chat(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": SYSTEM_PROMPT},
                        {"role": "user", "content": prompt}
                    ],
                    format="json",
                    options={"temperature": 0.3, "num_predict": 1024},
                )
                content = _extract_ollama_response_text(response)
                tracker.set_response(response)
                if tracker._prompt_tokens == 0:
                    tracker.set_tokens(
                        prompt=estimate_tokens(SYSTEM_PROMPT + prompt),
                        completion=estimate_tokens(content),
                    )

            # 3. 解析结果
            result = _extract_json_object(content)
            if result is None:
                raise json.JSONDecodeError("No valid JSON object found", content, 0)

            # 4. 跳过无价值内容
            overview = _normalize_inline_text(result.get('overview', ''))
            if overview == 'SKIP' or not overview:
                logger.info(f"采集记录 {capture_data.get('id')} 无价值，跳过")
                return None

            source_text = _sanitize_capture_text(capture_data.get('ocr_text') or capture_data.get('ax_text') or '')
            quality_reason = _overview_quality_reason(overview, source_text)
            if quality_reason:
                logger.info("采集记录 %s 提炼质量不足，跳过: %s", capture_data.get('id'), quality_reason)
                return None

            details = result.get('details', '')

            # 5. 去重检查和知识合并
            if db_conn:
                entities = result.get('entities') or []
                similar_id = self._find_similar_knowledge(
                    overview,
                    db_conn,
                    entities=entities,
                    start_time=capture_data.get('ts'),
                    end_time=capture_data.get('ts'),
                )
                if similar_id:
                    # 合并知识：更新明细内容，追加新的细节
                    cursor = db_conn.execute(
                        "SELECT details FROM episodic_memories WHERE id = ?",
                        (similar_id,)
                    )
                    existing_details = cursor.fetchone()[0] or ""

                    # 合并明细：保留原有内容，追加新内容
                    merged_details = existing_details
                    if details and details not in existing_details:
                        merged_details += f"\n\n--- 补充 ({datetime.now().strftime('%Y-%m-%d %H:%M')}) ---\n{details}"

                    # 更新现有记录
                    db_conn.execute(
                        """UPDATE episodic_memories
                           SET occurrence_count = occurrence_count + 1,
                               details = ?,
                               updated_at = CURRENT_TIMESTAMP
                           WHERE id = ?""",
                        (merged_details, similar_id)
                    )
                    db_conn.commit()
                    logger.info(f"知识已合并到现有条目 (ID={similar_id})")
                    return None

            # 6. 返回结构化知识
            summary = _overview_to_summary(overview)
            knowledge = {
                'capture_id': capture_data['id'],
                'summary': summary,
                'overview': overview,
                'details': details,
                'entities': json.dumps(result.get('entities', []), ensure_ascii=False),
                'category': result.get('category', '其他'),
                'importance': result.get('importance', 3),
                'occurrence_count': 1,
                'observed_at': capture_data.get('ts'),
                'event_time_start': result.get('event_time_start'),
                'event_time_end': result.get('event_time_end'),
                'history_view': bool(result.get('history_view', False)),
                'content_origin': result.get('content_origin'),
                'activity_type': result.get('activity_type'),
                'is_self_generated': False,
                'evidence_strength': result.get('evidence_strength'),
            }

            logger.info(f"成功提炼采集记录 {capture_data.get('id')}: {overview[:50]}...")
            return knowledge

        except json.JSONDecodeError as e:
            logger.error(f"JSON 解析失败: {e}, 响应内容: {content[:500]}")
            return None
        except Exception as e:
            logger.error(f"知识提炼失败: {e}")
            return None

    async def extract(
        self,
        capture_data: Dict[str, Any],
        db_conn=None
    ) -> Optional[Dict[str, Any]]:
        """异步版本（调用同步方法）"""
        return self.extract_sync(capture_data, db_conn)

    def extract_merged(
        self,
        captures: List[Dict[str, Any]],
        preempt_check=None,
    ) -> Optional[Dict[str, Any]]:
        """
        将多条 captures 合并提炼为一个工作片段知识条目。

        Args:
            captures: 按时间升序排列的 capture 列表
            preempt_check: 抢占检查函数，返回 True 表示需要中断

        Returns:
            提炼后的知识条目，包含 capture_ids/start_time/end_time/duration_minutes
        """
        if not captures:
            return None

        # 检查抢占信号
        if preempt_check and preempt_check():
            logger.info("extract_merged 收到抢占信号，中断提炼")
            return None

        # 单条直接走原有逻辑
        if len(captures) == 1:
            result = self.extract_sync(captures[0])
            if result:
                result['capture_ids'] = json.dumps([captures[0]['id']])
                result['start_time'] = captures[0]['ts']
                result['end_time'] = captures[0]['ts']
                result['duration_minutes'] = 0
                result['frag_app_name'] = captures[0].get('app_name')
                result['frag_win_title'] = captures[0].get('window_title')
            return result

        try:
            logger.info("extract_merged 启动: captures=%s", len(captures))
            # 1. 构建合并 prompt：按时间顺序拼接所有 capture 的文本
            merged_blocks = []
            for c in captures:
                text = c.get('ocr_text') or c.get('ax_text') or ''
                sanitized_text = _sanitize_capture_text(text)
                if not sanitized_text.strip():
                    continue
                ts_str = datetime.fromtimestamp(c['ts'] / 1000).strftime('%H:%M:%S')
                app = c.get('app_name', '')
                title = c.get('window_title', '')
                # 每块限制 800 字，避免单条噪声过多
                block = f"[{ts_str}] {app} - {title}\n{sanitized_text[:800]}"
                merged_blocks.append(block)

            if not merged_blocks:
                return None

            merged_text = "\n\n---\n\n".join(merged_blocks)
            # 总长度限制 6000 字（约 4000 tokens）
            if len(merged_text) > 6000:
                merged_text = merged_text[:6000] + "\n...(已截断)"

            user_prompt = (
                "以下是一段连续工作片段的采集记录，请提炼。"
                "输出必须是对工作内容的归纳，不允许照抄 UI 菜单词、窗口壳层词或原始 OCR 长串。\n\n"
                f"{merged_text}"
            )

            # 2. 调用 LLM（带埋点）
            logger.info(f"合并提炼 {len(captures)} 条 captures")
            # RAG 优先：若 RAG 查询正在占用 Ollama，跳过本轮提炼
            if _rag_is_active():
                logger.info("RAG 查询正在进行，本轮合并提炼跳过")
                return None
            # 检查抢占信号
            if preempt_check and preempt_check():
                logger.info("extract_merged 在 LLM 调用前收到抢占信号")
                return None
            from monitor.llm_tracker import LLMCallTracker, estimate_tokens
            capture_ids_str = ",".join(str(c['id']) for c in captures[:5])
            with LLMCallTracker(
                caller="knowledge",
                model_name=self.model,
                caller_id=f"merge:{capture_ids_str}",
            ) as tracker:
                _sys_prompt = self._build_merge_system_prompt()
                # 强化 JSON 输出约束：在 user prompt 中再次强调
                enhanced_user_prompt = f"{user_prompt}\n\n**重要**：你必须且只能输出一个有效的 JSON 对象，不要输出任何其他内容、解释或 markdown 代码块。"
                response = self.client.chat(
                    model=self.model,
                    messages=[
                        {"role": "system", "content": _sys_prompt},
                        {"role": "user", "content": enhanced_user_prompt},
                    ],
                    format="json",
                    options={"temperature": 0.3, "num_predict": 1024},
                )
                content = _extract_ollama_response_text(response)
                tracker.set_response(response)
                if tracker._prompt_tokens == 0:
                    tracker.set_tokens(
                        prompt=estimate_tokens(_sys_prompt + enhanced_user_prompt),
                        completion=estimate_tokens(content),
                    )

            # 3. 解析结果
            result = _extract_json_object(content)
            if result is None:
                logger.error(
                    "合并提炼 JSON 解析失败: No valid JSON object found: line 1 column 1 (char 0), "
                    "响应内容: %s",
                    content[:2000] if content else "(empty)"
                )
                return _build_fallback_knowledge(captures, reason='invalid_json')

            overview = _normalize_inline_text(result.get('overview', ''))
            if not overview or overview == 'SKIP':
                logger.warning("合并提炼未返回有效 overview，使用兜底 knowledge: result=%s", result)
                return _build_fallback_knowledge(captures, reason='empty_overview')

            quality_reason = _overview_quality_reason(overview, merged_text)
            if quality_reason:
                logger.warning("合并提炼 overview 质量不足，使用兜底 knowledge: reason=%s overview=%s", quality_reason, overview)
                return _build_fallback_knowledge(captures, reason=quality_reason)

            # 4. 计算片段元数据
            start_time = captures[0]['ts']
            end_time = captures[-1]['ts']
            duration_minutes = int((end_time - start_time) / 60000)

            # 主要应用：出现次数最多的 app_name
            from collections import Counter
            app_counter = Counter(
                c.get('app_name') for c in captures if c.get('app_name')
            )
            frag_app_name = app_counter.most_common(1)[0][0] if app_counter else None

            # 主要窗口：最后一条的 win_title（最能代表当前状态）
            frag_win_title = next(
                (c.get('window_title') for c in reversed(captures) if c.get('window_title')),
                None
            )

            summary = _overview_to_summary(overview)

            knowledge = {
                'capture_ids': json.dumps([c['id'] for c in captures]),
                'summary': summary,
                'overview': overview,
                'details': result.get('details', ''),
                'entities': json.dumps(result.get('entities', []), ensure_ascii=False),
                'category': result.get('category', '其他'),
                'importance': result.get('importance', 3),
                'occurrence_count': 1,
                'start_time': start_time,
                'end_time': end_time,
                'duration_minutes': duration_minutes,
                'frag_app_name': frag_app_name,
                'frag_win_title': frag_win_title,
                'observed_at': end_time,
                'event_time_start': result.get('event_time_start'),
                'event_time_end': result.get('event_time_end'),
                'history_view': bool(result.get('history_view', False)),
                'content_origin': result.get('content_origin'),
                'activity_type': result.get('activity_type'),
                'is_self_generated': False,
                'evidence_strength': result.get('evidence_strength'),
                'work_item': result.get('work_item'),
                'work_status': result.get('work_status'),
                'work_progress': result.get('work_progress'),
            }

            logger.info(
                f"合并提炼完成: {len(captures)} captures → 1 knowledge, "
                f"时长={duration_minutes}分钟, overview={overview[:50]}..."
            )
            return knowledge

        except json.JSONDecodeError as e:
            logger.error(f"合并提炼 JSON 解析失败: {e}, 响应内容: {content[:1000]}")
            return None
        except Exception as e:
            logger.error(f"合并提炼失败: {e}")
            return None
