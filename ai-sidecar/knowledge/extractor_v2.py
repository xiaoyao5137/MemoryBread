"""
时间线提炼与 bake 提炼模块 V2 - 强制使用 LLM，支持去重和出现次数统计
"""

import ast
import hashlib
import json
import logging
import re
import time
import urllib.request
from pathlib import Path
from typing import Optional, Dict, Any, List, Callable
from datetime import datetime
import numpy as np

logger = logging.getLogger(__name__)

BAKE_NUM_PREDICT = 65536
BAKE_CAPTURE_AX_MAX_CHARS = 16_000
BAKE_CAPTURE_CONTEXT_MAX_CHARS = 20_000
BAKE_DOCUMENT_MERGE_EXISTING_CONTEXT_MAX_CHARS = 24_000
BAKE_DOCUMENT_MERGE_CANDIDATE_CONTEXT_MAX_CHARS = 32_000
BAKE_ERROR_LOG_PATH = Path.home() / ".memory-bread" / "logs" / "bake_extract_errors.log"

# RAG 查询优先锁:model_api_server 在 RAG 调用期间持有此文件锁。
# 时间线提炼在调 LLM 前非阻塞 acquire；拿不到则跳过本轮，让 RAG 优先完成。
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
        .replace(""", '"')
        .replace(""", '"')
        .replace("'", "'")
        .replace("'", "'")
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


def _append_bake_error_log(message: str, **fields: Any) -> None:
    try:
        BAKE_ERROR_LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        event = {
            "ts_ms": int(time.time() * 1000),
            "message": message,
            **fields,
        }
        with BAKE_ERROR_LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(event, ensure_ascii=False, default=str))
            fh.write("\n")
    except Exception as exc:
        logger.warning("写入 bake 提炼错误日志失败: %s", exc)


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

**你的任务**:将这些连续采集提炼为一个完整的工作片段知识条目。

**提炼规则**:
1. 识别这段时间内用户在做的一件完整的事
2. **从工作内容中提炼工作项**:综合分析所有帧的内容，识别用户在做哪个项目/功能的工作
   - 从代码注释、函数名、文件路径、Git commit、文档标题、聊天主题等内容中提炼
   - 格式:"项目名-功能模块"（如"MemoryBread-时间线提炼优化"）或"项目名"（如"个人博客"）
   - 如果内容明确提到具体任务（如"修复 bug #123"），可以更具体（如"MemoryBread-修复排查步骤 bug"）
   - 如果无法从内容中识别，填写 null
3. **识别工作进度和状态**:从内容中推断当前工作的进展
   - work_status: "pending"（待启动）| "in_progress"（进行中）| "completed"（已完成）| "blocked"（阻塞）
   - work_progress: 具体进度描述（如"已完成核心逻辑"、"待其他团队协作"、"等待需求确认"）
4. 生成概述（50-150字）:描述做了什么、关键进展、结果，使用过去时态
5. 生成明细（200-500字）:
   - 保留有追溯价值的具体信息（代码逻辑、会议决策、学到的知识点）
   - 过滤掉 UI 操作、重复内容、无意义的切换记录
   - 不要堆砌原始文本，要提炼和归纳
6. 识别关键实体（人名、项目名、技术词汇）
7. 判断分类和重要性

**输出格式（JSON）**:
{
  "work_item": "项目名或项目名-功能模块，如 'MemoryBread-时间线提炼优化'，无法识别时填 null",
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

**注意补充判断**:
- **工作项识别示例**:
  * 代码文件 "extractor_v2.py" + 注释 "优化时间线提炼逻辑" → work_item: "MemoryBread-时间线提炼优化"
  * Git commit "fix: 修复排查步骤 bug" → work_item: "MemoryBread-修复排查步骤 bug"
  * 聊天记录讨论 "个人博客的评论功能需求" → work_item: "个人博客-评论功能"
  * 文档标题 "用户认证系统重构方案" → work_item: "用户认证系统-重构"
  * 如果只看到 "修复 bug"、"写代码" 等模糊描述，无法识别具体项目，填 null
- **工作进度识别示例**:
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

**重要性评分**:
- 5分:关键决策、重要会议纪要、核心代码逻辑
- 4分:项目进展、技术文档、重要沟通
- 3分:日常工作记录、一般文档
- 2分:简单操作记录
- 1分:无关紧要的内容

**注意**:输出必须是有效的 JSON，字符串中的引号要转义，不要包含未转义的换行符。
"""

BAKE_SHARED_PROMPT = """你在执行 bake pipeline 的类别特异提炼。输入是一条来自情节记忆/episodic memory 的候选工作片段。

目标不是泛泛总结，而是判断这条候选是否足以沉淀为某一类稳定资产。所有判断都必须保守:证据不足就 reject，不要为了凑产出而改写成看似合理的结果。

你会收到候选的 summary / overview / details / entities，以及关联 capture 的上下文文本。可以综合这些信息，但必须只基于输入证据，不要臆测。

**必须 reject 的情形（无论内容看起来多有价值）**:
- 内容来源是界面上渲染的历史操作记录、变更日志、动态消息流（例如"某某于X月X日更新了…"、"某某创建了…"、"某某评论了…"等格式），这类内容描述的是过去某个时间点他人或系统的动作，不是当前用户正在进行的工作
- 判断依据:capture_context 中出现"[人名/角色] 于 [日期] [动词]了 [对象]"句式，且该日期明显早于 capture_ts 对应的时间

输出要求:
- 必须返回且只返回 1 个 JSON 对象
- 顶层字段固定且仅允许:accepted, reason, payload
- `accepted` 为 true 时，`payload` 必须符合该类别 schema
- `accepted` 为 false 时，`payload` 必须为 null，并用 `reason` 简要说明为什么不适合该类别
- 不要输出解释性前后缀，不要输出代码块，不要输出思考过程
- 只有各类别 schema 中明确标注为 Markdown 的字段可以包含 Markdown；必须作为 JSON 字符串输出，换行使用 `\n` 转义
- 其他字符串保持单行，避免换行和超长段落
- schema 外字段一律不要输出
- 输出前自检:结果必须能被 JSON 解析，且顶层只有 accepted/reason/payload 三个字段"""

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

BAKE_BUNDLE_RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "knowledge": BAKE_RESPONSE_SCHEMA,
        "design": BAKE_RESPONSE_SCHEMA,
        "sop": BAKE_RESPONSE_SCHEMA,
    },
    "required": ["knowledge", "design", "sop"],
    "additionalProperties": False,
}

BAKE_MERGE_DOCUMENT_SCHEMA = {
    "type": "object",
    "properties": {
        "no_change": {"type": "boolean"},
        "title": {"type": "string"},
        "summary": {"type": ["string", "null"]},
        "content_patch": {"type": ["string", "null"]},
        # 兼容旧模型/旧测试返回；新提示词只允许模型输出 content_patch，完整正文由
        # sidecar 在本地确定性拼接，避免长文档被模型可见窗口截断后整体覆盖。
        "full_content": {"type": ["string", "null"]},
        "insert_mode": {
            "type": ["string", "null"],
            "enum": [
                "append",
                "insert_after_section",
                "replace_section",
                "no_change",
                None,
            ],
        },
        "target_section_index": {"type": ["integer", "null"]},
        "evidence_summary": {"type": ["string", "null"]},
        "new_info_summary": {"type": ["string", "null"]},
        "match_score": {"type": ["number", "null"]},
        "match_level": {
            "type": ["string", "null"],
            "enum": ["high", "medium", "low", None],
        },
    },
    "required": ["no_change", "title"],
    "additionalProperties": False,
}


BAKE_TEMPLATE_MARKERS = (
    "模板",
    "骨架",
    "槽位",
    "填写",
    "章节标题",
    "文章格式",
    "文章脉络",
    "文字描述风格",
    "常用口语词",
    "ai替代词",
    "替代词",
    "表达风格",
    "写法",
    "文风",
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
    "知识",
    "参考",
    "参照",
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
    "行动动线",
    "行动路线",
    "处理路线",
    "解决问题",
    "指引",
    "操作",
    "执行",
    "验证",
)

BAKE_DESIGN_MARKERS = (
    "设计",
    "方案",
    "模板",
    "骨架",
    "槽位",
    "章节标题",
    "文章格式",
    "文章脉络",
    "文字描述风格",
    "常用口语词",
    "ai替代词",
    "替代词",
    "文档模板",
    "汇报总结",
    "写作参考",
)

BAKE_SCORE_METADATA_KEYS = {
    "match_score",
    "match_level",
    "review_status",
    "score",
    "confidence",
    "status",
    "auto_created",
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


BAKE_KNOWLEDGE_PROMPT = """类别:knowledge

只提炼未来工作中需要回想起来参照使用的有用知识。
当你理解该时间线及对应采集记录描述的信息，是未来工作中会被拿来参考的事实、经验、约束、决策、结论、方法理解，或未来工作中需要参考某个设计方案的知识时，accepted=true。
如果只是噪声或零散操作，没有形成任何可复用的知识点，就 reject。

注意:knowledge / design / sop 三个类别相互独立判断，互不互斥。同一条候选可以同时被多个类别接受（事实部分进 knowledge、文档主体进 design、操作步骤进 sop），不要因为输入"看起来更像 design 或 sop"就推卸 knowledge 的判断——只要里面有可沉淀的稳定知识点，就独立 accept。

accepted=true 时，payload schema:
{
  "summary": "知识标题/摘要，简洁明确",
  "overview": "对该知识的概述，可为空",
  "details": "详细描述，Markdown格式，说明该知识是什么、适用场景、未来如何参照使用、证据依据",
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
  "review_status": "auto_created"
}

约束:
- `summary` 必须体现沉淀后的知识点，不要直接照抄流水账
- `details` 必须是可渲染 Markdown，建议包含 `## 适用场景`、`## 可参考内容`、`## 证据依据`
- 输入即使含有写作模板特征或行动步骤，只要其中存在独立可复用的事实/经验/约束/决策/结论，就在 knowledge 中保留这部分；模板部分会由 design 处理，步骤部分由 sop 处理，不要替对方做拒绝判断
- `match_score` 使用 0-1 小数
- 接受的结果统一使用 `auto_created`
- 若只是模糊猜测或噪声，直接 reject"""

BAKE_DESIGN_PROMPT = """类别:design（用于沉淀「文档」资产）

这里的 design 对应用户产品中的「文档」tab，用来沉淀用户在工作中产出或参考过的「成体系内容资料」，覆盖以下场景:
1. 用户自己写出/正在写的方案、设计稿、汇报、总结、技术文档、运营文档、PRD、项目计划、会议纪要、需求说明等成形内容；
2. 用户认真阅读/反复参照的他人文档、资料、教程、范文，且其内容、结构、风格对未来工作有可借鉴价值；
3. 围绕一个主题成体系组织的产物片段，例如完整的 Prompt 指令集合、视频脚本分镜表、数据 Schema 说明、配置脚本注释、计算公式与参数说明等——只要这些片段是被「当作文档来阅读/编写/反复修改」的（而不是一闪而过的中间产物），都属于 design。

重要：候选输入可能只覆盖了文档的一部分（用户当时只看到了一段），但同一份文档往往会被多次浏览或编辑。如果候选包含 `url_document_context`，那是同一 URL 在过去被多次 capture 拼接出来的累计正文，应优先据此还原文档全貌；`url_document_context` 与当前 `capture_context` 来自同一份文档时不要重复抄录，按文档自身的章节顺序合并即可。

只要候选片段对应的是「一份/一段成体系的文档型内容」（无论是产出还是参考、无论一次还是多次浏览拼出来的），就值得沉淀为 design，accepted=true。
不要求文档必须"章节齐全/结构完整"——这是加分项，会反映在 match_score 的高低，而不是接受/拒绝的门槛。

什么时候 reject:
- 输入只是零散对话/聊天/任务清单/通知消息，没有围绕一份具体文档；
- 输入只是一次性代码改动、操作流水或排查动线，且不涉及任何文档形态的内容；
- 输入只是无意义的浏览噪声、UI 切换、应用界面观察；
- 输入虽然涉及某个产品页面，但页面只是工具操作界面（如登录页、价格页、设置页），不承载任何文档式正文。

注意：「查看文档」本身就是充分理由——只要用户查看的是一份有实质内容的文档（内部文档、教程、规范、申请表单说明等），即使没有主动编辑或操作，也应 accepted=true。history_view=true 且有文档正文可识别时，不要因为缺少"主动产出"而 reject。

如果输入既包含文档内容又包含事实知识或行动步骤，design 类别仍可 accepted=true，只要文档主体存在。事实知识/行动路线会由 knowledge/sop 类别各自再判断，不需要在 design 这里互相挤兑。

accepted=true 时，payload schema:
{
  "name": "文档名称（优先用文档自身的标题/页面 webpage_title；没有则用一句话概括其主题）",
  "category": "方案|设计|汇报|总结|技术文档|运营文档|会议纪要|资料参考|其他",
  "summary": "一句话概括这份文档讲了什么、是用户产出还是参考、未来在什么场景可再用，控制在 80 字以内",
  "full_content": "文档完整正文，Markdown 格式。要求是文档**本身**的内容；如有 url_document_context 应据此尽可能还原全貌，按文档原本的章节顺序整理；列表、代码、Prompt 指令、表格用 Markdown 语法保留；无法识别完整原文时，把 capture/url_document_context 中可见的核心段落如实写入；不要写'结构参考/使用建议/写作风格'这类分析元信息。",
  "details": "可选元信息说明，Markdown 格式。这里只放对文档使用方有帮助的辅助信息：未来什么场景可参考、风格/结构上值得借鉴的点、需要注意的限制。不要重复 full_content 的正文内容；如无可写，留空字符串。",
  "prompt_hint": "未来生成或撰写类似文档时可直接使用的提示词建议；若候选只是阅读型，可写未来检索/复用该文档时的关键词",
  "status": "draft|enabled",
  "tags": ["标签1", "标签2"],
  "applicable_tasks": ["creation"],
  "structure_sections": [{"title":"章节标题","keywords":["关键词"],"notes":"该章节的内容概要"}],
  "style_phrases": ["值得复用的表达/口语词，可为空数组"],
  "replacement_rules": [{"from":"AI腔或不合适表达","to":"更贴近用户风格的替代表达"}],
  "diagram_code": null,
  "evidence_summary": "一句话说明文档证据（看到了什么文档/写了什么内容；如使用了 url_document_context，请说明合并了几次 capture）",
  "match_score": 0.0,
  "match_level": "high|medium|low",
  "review_status": "auto_created"
}

约束:
- `full_content` 是首要产出，必须基于输入证据（包括 url_document_context）如实还原文档原文，禁止生造、禁止用"## 文档概要 / ## 关键内容 / ## 结构参考 / ## 使用建议"这类分析模板替代正文
- `summary` 必须是简洁的一句话；不要把元信息塞进 summary
- `details` 仅用于"使用提示/借鉴点"，不是正文复述；没东西写就用空字符串 ""
- `structure_sections` 至少 1 条；如果文档结构不清，可只放一条整体概要
- `style_phrases`、`replacement_rules` 当作可选，识别不到时使用空数组
- match_score 评估"这份文档对未来工作的可参考价值":
  - 既有清晰章节骨架/可复用风格，又有明确主题: 0.75-0.95（high）
  - 是一份完整文档或重要参考资料但模板特征不强: 0.55-0.75（medium）
  - 内容偏单薄但仍有沉淀价值: 0.35-0.55（low）
- 接受的结果统一使用 `auto_created`；证据不足时直接 reject"""

BAKE_SOP_PROMPT = """类别:sop

只提炼未来遇到相同需求/问题场景时，可以参考给出行动路线建议的操作手册。
当你理解该时间线及对应采集记录描述的信息，是在描述工作中解决一个问题或需求的行动动线、触发条件、处理路线、排查/执行步骤、检查点或验证方式时，accepted=true。
如果完全没有可复用的行动指引（纯事实陈述、纯文档阅读、纯噪声），reject。

注意:knowledge / design / sop 三个类别相互独立判断，互不互斥。同一条候选既可能成为 knowledge（事实结论），也可能成为 design（文档主体），还可能成为 sop（操作步骤）。只要存在可复用的行动路线或排查步骤，就独立 accept，不要因为"输入更像 knowledge 或 design"就推卸判断。

accepted=true 时，payload schema:
{
  "summary": "SOP 标题/摘要",
  "overview": "该 SOP 解决什么问题，可为空",
  "details": "详细描述，Markdown格式，说明适用场景、行动路线、注意事项、验证方式",
  "source_title": "来源标题，可为空",
  "trigger_keywords": ["触发词1", "触发词2"],
  "extracted_problem": "触发场景/问题",
  "steps": ["步骤1", "步骤2", "步骤3"],
  "linked_knowledge_ids": [],
  "confidence": "high|medium|low",
  "evidence_summary": "一句话说明步骤依据",
  "match_score": 0.0,
  "match_level": "high|medium|low",
  "review_status": "auto_created"
}

约束:
- `steps` 至少 3 条，且必须是可执行动作
- `details` 必须是可渲染 Markdown，建议包含 `## 适用场景`、`## 行动路线`、`## 注意事项`、`## 验证方式`
- 没有明确步骤化流程就 reject
- 如果只是经验总结或模板骨架，不要误判成 SOP"""

BAKE_BUNDLE_PROMPT = f"""你在执行一次性 bake bundle 提炼。输入是一条时间线候选工作片段。

你必须在同一次判断中，分别评估 knowledge、design、sop 三类稳定资产。三类互不互斥，
但都必须保守，只基于候选证据；证据不足的类别必须 reject。

必须拒绝把界面中渲染的历史操作记录、变更日志或动态消息流当成当前用户产出。

最终只返回一个 JSON 对象，顶层固定为 knowledge、design、sop。每个子对象固定为：
{{"accepted": true/false, "reason": "原因或 null", "payload": {{...}} 或 null}}

不要输出解释、代码块或思考过程。Markdown 只能出现在类别 schema 明确允许的字符串字段中。

以下是三个类别各自的判断规则和 payload schema：

--- knowledge ---
{BAKE_KNOWLEDGE_PROMPT}

--- design ---
{BAKE_DESIGN_PROMPT}

--- sop ---
{BAKE_SOP_PROMPT}
"""

MERGE_SYSTEM_PROMPT ="""你是一个工作片段提炼助手。以下是用户在一段连续时间内的屏幕采集记录（按时间顺序），它们属于同一个工作片段。

**你的任务**:将这些连续采集提炼为一个完整的工作片段知识条目。

**提炼规则**:
1. 识别这段时间内用户在做的一件完整的事
2. **从工作内容中提炼工作项**:综合分析所有帧的内容，识别用户在做哪个项目/功能的工作
   - 从代码注释、函数名、文件路径、Git commit、文档标题、聊天主题等内容中提炼
   - 格式:"项目名-功能模块"（如"MemoryBread-时间线提炼优化"）或"项目名"（如"个人博客"）
   - 如果内容明确提到具体任务（如"修复 bug #123"），可以更具体（如"MemoryBread-修复排查步骤 bug"）
   - 如果无法从内容中识别，填写 null
3. **识别工作进度和状态**:从内容中推断当前工作的进展
   - work_status: "pending"（待启动）| "in_progress"（进行中）| "completed"（已完成）| "blocked"（阻塞）
   - work_progress: 具体进度描述（如"已完成核心逻辑"、"待其他团队协作"、"等待需求确认"）
4. 生成概述（50-150字）:描述做了什么、关键进展、结果，使用过去时态
5. 生成明细（200-500字）:
   - 保留有追溯价值的具体信息（代码逻辑、会议决策、学到的知识点）
   - 过滤掉 UI 操作、重复内容、无意义的切换记录
   - 不要堆砌原始文本，要提炼和归纳
6. 识别关键实体（人名、项目名、技术词汇）
7. 判断分类和重要性

**输出格式（JSON）**:
{
  "work_item": "项目名或项目名-功能模块，如 'MemoryBread-时间线提炼优化'，无法识别时填 null",
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

**注意补充判断**:
- **工作项识别示例**:
  * 代码文件 "extractor_v2.py" + 注释 "优化时间线提炼逻辑" → work_item: "MemoryBread-时间线提炼优化"
  * Git commit "fix: 修复排查步骤 bug" → work_item: "MemoryBread-修复排查步骤 bug"
  * 聊天记录讨论 "个人博客的评论功能需求" → work_item: "个人博客-评论功能"
  * 文档标题 "用户认证系统重构方案" → work_item: "用户认证系统-重构"
  * 如果只看到 "修复 bug"、"写代码" 等模糊描述，无法识别具体项目，填 null
- **工作进度识别示例**:
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

**重要性评分**:
- 5分:关键决策、重要会议纪要、核心代码逻辑
- 4分:项目进展、技术文档、重要沟通
- 3分:日常工作记录、一般文档
- 2分:简单操作记录
- 1分:无关紧要的内容

**注意**:输出必须是有效的 JSON，字符串中的引号要转义，不要包含未转义的换行符。
"""

SYSTEM_PROMPT = """你是一个专业的工作记录提炼助手。你的任务是从 OCR 识别的屏幕文本中提取有价值的工作信息。

**提炼规则**:
1. 忽略 UI 元素（按钮、菜单、状态栏等）
2. 提取核心工作内容（会议记录、文档内容、代码片段、聊天记录等）
3. 生成"概述"和"明细"两部分内容:
   - 概述:简洁描述在做什么事情（30-100字），使用过去时态，避免使用"正在"等词
   - 明细:详细记录具体内容细节，保留关键信息以便后期追溯（200-500字）
4. 识别关键实体（人名、项目名、时间、地点）
5. 如果内容无价值（纯 UI、重复内容），返回 "SKIP"

**输出格式**（JSON）:
{
  "overview": "概述文本，描述做了什么事情，不要包含换行符",
  "details": "明细文本，使用空格代替换行符",
  "entities": ["实体1", "实体2"],
  "category": "会议|文档|代码|聊天|其他",
  "importance": 1-5
}

**重要性评分标准**:
- 5分:关键决策、重要会议纪要、核心代码逻辑
- 4分:项目进展、技术文档、重要沟通
- 3分:日常工作记录、一般文档
- 2分:简单操作记录
- 1分:无关紧要的内容

**明细内容要求**:
- 保留足够的上下文信息
- 记录关键对话内容和参与人
- 保留代码片段和技术细节
- 记录决策过程和理由
- 便于后期回忆和追溯
- 所有文本必须在一行内，不要使用换行符

**注意**:输出必须是有效的 JSON 格式，字符串中的引号要转义，不要包含未转义的换行符。
"""


class KnowledgeExtractorV2:
    """时间线提炼器 V2 - 强制使用 LLM"""

    def __init__(self, model: str | None = None, embedding_model=None, user_identity: str = ""):
        """
        初始化时间线提炼器

        Args:
            model: Ollama 模型名称
            embedding_model: 向量模型（用于去重）
            user_identity: 用户身份关键词，多个用逗号分隔（如 "张三,zhangsan"）
        """
        import requests
        self.ollama_base_url = "http://127.0.0.1:11434"
        # 使用全局统一的 Ollama 模型名，如果未传入则自动获取
        if model is None:
            from model_registry_global import get_active_ollama_model
            model = get_active_ollama_model()
        self.model = model
        # Ollama 推理 HTTP 超时：4B 模型在 M 系 Mac 上对 ~10k token prompt 的 P50 ≈ 135s、
        # P95 ≈ 342s，原先 90s 的设置导致 ~66% 请求被错杀。1200s 给冷启动 + 大 prompt 留余量。
        # 必须 ≤ core-engine BAKE_SIDECAR_TIMEOUT_SECS（当前 1200s），否则会先在 core 那层断开。
        self.timeout = 1200

        # 测试 Ollama 是否可用
        try:
            r = requests.get(f"{self.ollama_base_url}/api/tags", timeout=5)
            r.raise_for_status()
            logger.info(f"✅ Ollama 服务连接成功，模型: {model}")
        except Exception as e:
            raise RuntimeError(f"Ollama 服务不可用: {e}")

        self.embedding_model = embedding_model
        if embedding_model:
            logger.info("✅ 向量模型已加载，将启用知识去重")

        self.user_identity = user_identity.strip()
        if self.user_identity:
            logger.info(f"✅ 用户身份已配置: {self.user_identity}")

    def _ollama_chat(self, messages, format=None, options=None):
        """使用可中断流调用 Ollama；在线 P0 到达时立即关闭后台响应。"""
        import requests
        from inference_queue import (
            current_task_preempt_requested,
            raise_if_preempted,
            register_current_preempt_callback,
        )

        raise_if_preempted()
        payload = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "think": False,  # 禁用 thinking 模式，确保 content 有内容
            # keep_alive=10m：与 RAG 查询保持一致，避免 Ollama 在查询和提炼之间频繁 swap
            "keep_alive": "10m",
        }
        if format:
            payload["format"] = format
        if options:
            payload["options"] = options

        try:
            with requests.post(
                f"{self.ollama_base_url}/api/chat",
                json=payload,
                timeout=self.timeout,
                stream=True,
            ) as response:
                unregister = register_current_preempt_callback(response.close)
                try:
                    response.raise_for_status()
                    final: Dict[str, Any] = {}
                    content_parts: list[str] = []
                    thinking_parts: list[str] = []
                    for raw_line in response.iter_lines():
                        raise_if_preempted()
                        if not raw_line:
                            continue
                        chunk = json.loads(raw_line.decode("utf-8", errors="replace"))
                        final.update(chunk)
                        message = chunk.get("message") or {}
                        if message.get("content"):
                            content_parts.append(str(message["content"]))
                        if message.get("thinking"):
                            thinking_parts.append(str(message["thinking"]))
                    final["message"] = {
                        **(final.get("message") or {}),
                        "content": "".join(content_parts),
                        "thinking": "".join(thinking_parts),
                    }
                finally:
                    unregister()
            raise_if_preempted()
            return final
        except Exception:
            if current_task_preempt_requested():
                raise_if_preempted()
            raise

    def _build_merge_system_prompt(self) -> str:
        """构建带用户身份的 MERGE_SYSTEM_PROMPT"""
        identity_clause = ""
        if self.user_identity:
            names = [n.strip() for n in self.user_identity.split(",") if n.strip()]
            names_str = "、".join(f'"{n}"' for n in names)
            identity_clause = (
                f"\n\n**用户身份信息**:屏幕的使用者是 {names_str}。"
                "在提炼时，请注意:\n"
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

        prompt = f"""**应用名称**:{app_name}
**窗口标题**:{window_title}
**时间戳**:{timestamp}
**OCR 文本**:
{ocr_text}

请提炼上述内容。要求:必须总结工作动作与结果，禁止照抄菜单词/窗口壳层词或原始 OCR 长串。"""

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

            # 2. 获取所有现有知识条目（仅取最近 500 条，且限制在 24 小时内）
            merge_window_ms = 24 * 60 * 60 * 1000  # 24 小时
            time_filter = ""
            if end_time is not None:
                earliest_time = end_time - merge_window_ms
                time_filter = f" AND end_time >= {earliest_time}"
                logger.debug(f"合并窗口: 24小时内 (end_time={end_time}, earliest={earliest_time})")

            cursor = db_conn.execute(
                f"SELECT id, overview, entities, start_time, end_time FROM timelines WHERE overview IS NOT NULL{time_filter} ORDER BY created_at DESC LIMIT 500"
            )
            existing_entries = cursor.fetchall()

            if not existing_entries:
                logger.debug("未找到候选合并记录（24小时内无记录）")
                return None

            logger.debug(f"候选合并记录: {len(existing_entries)} 条（24小时内）")

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

            # 5. 实体重叠增强:同名实体出现在两条知识中，相似度+0.05
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

            # 6. 连续片段保护:时间重叠或紧邻的同一事件，直接排除合并
            continuity_gap_ms = 15 * 60 * 1000
            if start_time is not None and end_time is not None:
                for i, (existing_start, existing_end) in enumerate(zip(existing_start_times, existing_end_times)):
                    if existing_start is None or existing_end is None:
                        continue
                    overlaps = start_time <= existing_end and end_time >= existing_start
                    near_continuation = 0 <= start_time - existing_end <= continuity_gap_ms
                    if overlaps or near_continuation:
                        similarities[i] = 0  # 直接排除
                        logger.debug(
                            "跳过连续片段 (ID=%s, overlap=%s, gap_ms=%s)",
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
            self._truncate_text(candidate.get('capture_ax_text'), BAKE_CAPTURE_AX_MAX_CHARS),
            self._truncate_text(candidate.get('capture_ocr_text'), 1000),
            self._truncate_text(candidate.get('capture_input_text'), 500),
            self._truncate_text(candidate.get('capture_audio_text'), 500),
        ]
        capture_text = "\n\n".join(part for part in capture_parts if part)
        if len(capture_text) > BAKE_CAPTURE_CONTEXT_MAX_CHARS:
            capture_text = (
                capture_text[:BAKE_CAPTURE_CONTEXT_MAX_CHARS].rstrip()
                + "\n...(已截断)"
            )

        url_aggregated_text = candidate.get('url_aggregated_text') or ''
        url_aggregated_count = candidate.get('url_aggregated_capture_count') or 0
        capture_url = candidate.get('capture_url') or ''
        webpage_title = candidate.get('capture_webpage_title') or ''
        url_block = ''
        if url_aggregated_text:
            url_block = (
                f"\n\nurl_document_context: 同一 url 在过去被多次浏览/编辑，按时间顺序拼接的可见正文如下"
                f"（共合并 {url_aggregated_count} 次 capture，可视为这份文档的累计可见内容）：\n"
                f"url: {capture_url}\n"
                f"webpage_title: {webpage_title}\n"
                f"---\n{url_aggregated_text}"
            )

        return (
            f"source_timeline_id: {candidate.get('source_timeline_id')}\n"
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
            f"capture_url: {capture_url}\n"
            f"capture_webpage_title: {webpage_title}\n"
            f"entities: {self._truncate_text(entities_text, 160)}\n\n"
            f"capture_context:\n{capture_text}"
            f"{url_block}"
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
        design_hits = self._count_marker_hits(candidate_text + "\n" + payload_text, BAKE_DESIGN_MARKERS)
        candidate_template_hits = self._count_marker_hits(candidate_text, BAKE_TEMPLATE_MARKERS)
        candidate_sop_hits = self._count_marker_hits(candidate_text, BAKE_SOP_MARKERS)
        candidate_design_hits = self._count_marker_hits(candidate_text, BAKE_DESIGN_MARKERS)

        if artifact_type == 'knowledge':
            if self._should_reject_template_like_knowledge(candidate, payload):
                return 'template_like_content'
            if self._should_reject_sop_like_knowledge(candidate, payload):
                return 'sop_like_content'
            return None

        if artifact_type == 'design':
            if sop_hits >= 5 and design_hits == 0 and candidate_design_hits == 0:
                return 'sop_like_content'
            return None

        if artifact_type == 'sop':
            if design_hits >= 3 and candidate_design_hits >= 2 and candidate_sop_hits <= 1:
                return 'design_like_content'
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
        adjusted['review_status'] = 'auto_created'
        evidence = str(adjusted.get('evidence_summary') or '').strip()
        adjusted['evidence_summary'] = f"{evidence} | mismatch_guard={reason}" if evidence else f"mismatch_guard={reason}"
        return adjusted

    def _call_bake_llm(
        self,
        caller_id: str,
        system_prompt: str,
        user_prompt: str,
        response_schema: Dict[str, Any] = BAKE_RESPONSE_SCHEMA,
    ) -> tuple[Optional[Dict[str, Any]], Dict[str, Any]]:
        from monitor.llm_tracker import LLMCallTracker, estimate_tokens

        started_at = time.time()
        logger.info("bake llm start caller=%s", caller_id)
        with LLMCallTracker(
            caller="bake",
            model_name=self.model,
            caller_id=caller_id,
        ) as tracker:
            response = self._ollama_chat(
                messages=[
                    {"role": "system", "content": system_prompt},
                    {"role": "user", "content": user_prompt},
                ],
                format=response_schema,
                options={"temperature": 0.0, "num_predict": BAKE_NUM_PREDICT},
            )
            raw_content = _extract_ollama_response_text(response)
            tracker.set_response(response)
            tracker.set_trace(
                raw_preview=_preview_text(raw_content, 4000),
                response_preview=_preview_text(response, 4000),
                done_reason=response.get("done_reason"),
            )
            if tracker._prompt_tokens == 0:
                tracker.set_tokens(
                    prompt=estimate_tokens(system_prompt + user_prompt),
                    completion=estimate_tokens(raw_content),
                )

        elapsed_ms = int((time.time() - started_at) * 1000)
        done_reason = response.get("done_reason")
        if done_reason == "length":
            _append_bake_error_log(
                "bake LLM output exceeded num_predict",
                caller_id=caller_id,
                model=self.model,
                num_predict=BAKE_NUM_PREDICT,
                prompt_chars=len(system_prompt) + len(user_prompt),
                raw_len=len(raw_content),
                prompt_tokens=(response.get("usage") or {}).get("prompt_tokens") or response.get("prompt_eval_count"),
                completion_tokens=(response.get("usage") or {}).get("completion_tokens") or response.get("eval_count"),
                elapsed_ms=elapsed_ms,
                done_reason=done_reason,
                raw_head=_preview_text(raw_content, 2000),
                raw_tail=raw_content[-2000:] if raw_content else "",
                response_preview=_preview_text(response, 4000),
            )
            logger.error(
                "bake LLM output exceeded num_predict caller=%s num_predict=%s raw_len=%s",
                caller_id,
                BAKE_NUM_PREDICT,
                len(raw_content),
            )
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
            'done_reason': response.get('done_reason'),
            'empty_content': not bool(raw_content.strip()),
            'elapsed_ms': elapsed_ms,
        }

    def _extract_bake_artifact(self, candidate: Dict[str, Any], artifact_type: str, artifact_prompt: str) -> tuple[Dict[str, Any], Dict[str, Any]]:
        candidate_text = self._build_bake_candidate_text(candidate)
        system_prompt = BAKE_SHARED_PROMPT + "\n\n" + artifact_prompt
        user_prompt = f"候选输入如下:\n\n{candidate_text}"
        caller_id = f"{artifact_type}:{candidate.get('source_timeline_id')}"
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
            reason = 'empty_content' if meta.get('empty_content') else (
                'truncated_json' if meta.get('done_reason') == 'length' else 'invalid_json'
            )
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

    def _normalize_bake_artifact_result(
        self,
        candidate: Dict[str, Any],
        artifact_type: str,
        parsed: Optional[Dict[str, Any]],
        meta: Dict[str, Any],
        *,
        caller_id: str,
    ) -> tuple[Dict[str, Any], Dict[str, Any]]:
        """校验一次 bundle 调用中的单个类别结果，并复用原有 mismatch guard。"""
        elapsed_ms = int(meta.get('elapsed_ms') or 0)
        usage = meta.get('usage')
        model = meta.get('model') or self.model

        if not isinstance(parsed, dict):
            return {
                'accepted': False,
                'reason': meta.get('parse_failure_reason') or 'missing_bundle_artifact',
                'payload': None,
            }, {
                'usage': usage,
                'model': model,
                'degraded': True,
                'elapsed_ms': elapsed_ms,
            }

        accepted = bool(parsed.get('accepted', False))
        reason = parsed.get('reason')
        payload = parsed.get('payload')
        if accepted and payload is None:
            return {
                'accepted': False,
                'reason': 'accepted_without_payload',
                'payload': None,
            }, {
                'usage': usage,
                'model': model,
                'degraded': True,
                'elapsed_ms': elapsed_ms,
            }
        if accepted and not isinstance(payload, dict):
            return {
                'accepted': False,
                'reason': 'malformed_payload',
                'payload': None,
            }, {
                'usage': usage,
                'model': model,
                'degraded': True,
                'elapsed_ms': elapsed_ms,
            }

        if accepted:
            mismatch_reason = self._resolve_bake_artifact_mismatch_reason(
                artifact_type,
                candidate,
                payload,
            )
            if mismatch_reason and artifact_type == 'knowledge':
                return {
                    'accepted': False,
                    'reason': mismatch_reason,
                    'payload': None,
                }, {
                    'usage': usage,
                    'model': model,
                    'degraded': False,
                    'elapsed_ms': elapsed_ms,
                }
            if mismatch_reason:
                payload = self._downgrade_mismatch_payload(payload, mismatch_reason)
                reason = reason or mismatch_reason

        logger.info(
            "bake bundle artifact normalized type=%s caller=%s accepted=%s reason=%s",
            artifact_type,
            caller_id,
            accepted,
            reason,
        )
        if not accepted:
            return {
                'accepted': False,
                'reason': reason or 'rejected',
                'payload': None,
            }, {
                'usage': usage,
                'model': model,
                'degraded': False,
                'elapsed_ms': elapsed_ms,
            }

        return {
            'accepted': True,
            'reason': reason,
            'payload': payload,
        }, {
            'usage': usage,
            'model': model,
            'degraded': False,
            'elapsed_ms': elapsed_ms,
        }

    def extract_bake_knowledge(self, candidate: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self._extract_bake_artifact(candidate, 'knowledge', BAKE_KNOWLEDGE_PROMPT)

    def extract_bake_design(self, candidate: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self._extract_bake_artifact(candidate, 'design', BAKE_DESIGN_PROMPT)

    def extract_bake_sop(self, candidate: Dict[str, Any]) -> tuple[Dict[str, Any], Dict[str, Any]]:
        return self._extract_bake_artifact(candidate, 'sop', BAKE_SOP_PROMPT)

    def merge_bake_document(self, existing_document: Dict[str, Any], candidate: Dict[str, Any]) -> Dict[str, Any]:
        """将新的 candidate capture 内容合并到已有文档，返回更新后的字段。

        三层过滤 + 懒惰合并策略：
        1. 字面去重：content_hash 完全相同 → 直接丢弃（0次LLM）
        2. 文本相似度：embedding cosine > 0.92 → 直接追加（0次LLM）
        3. LLM判断：仅在前两层无法确定时调用（1次LLM，合并去重+插入判断为一体）
        """
        existing_title = existing_document.get('title') or ''
        existing_content = existing_document.get('full_content') or ''
        existing_hash = existing_document.get('content_hash') or ''
        candidate_text = self._build_bake_candidate_text(candidate)

        # Layer 1: 字面去重（完全相同的 content_hash）
        candidate_hash = hashlib.sha256(candidate_text.encode('utf-8')).hexdigest()
        if existing_hash and candidate_hash == existing_hash:
            logger.info("L1去重：content_hash完全匹配 source_timeline_id=%s", candidate.get('source_timeline_id'))
            return {'no_change': True, 'title': existing_title}

        # Layer 2: 快速文本相似度（embedding cosine，复用已有向量化能力）
        try:
            existing_short = existing_content[:2000]
            candidate_short = candidate_text[:2000]

            if len(existing_short) > 100 and len(candidate_short) > 100:
                from sklearn.metrics.pairwise import cosine_similarity
                import numpy as np

                # 使用当前已加载的 embedding model
                existing_vec = self.embed_model.encode([existing_short])[0] if hasattr(self, 'embed_model') else None
                candidate_vec = self.embed_model.encode([candidate_short])[0] if hasattr(self, 'embed_model') else None

                if existing_vec is not None and candidate_vec is not None:
                    similarity = cosine_similarity([existing_vec], [candidate_vec])[0][0]
                    if similarity > 0.92:
                        # 高相似度：简单追加新timeline_id，不修改内容
                        logger.info("L2去重：embedding相似度%.2f source_timeline_id=%s", similarity, candidate.get('source_timeline_id'))
                        return {'no_change': True, 'title': existing_title}
        except Exception as e:
            logger.warning("L2去重失败，降级到L3 LLM判断: %s", e)

        # Layer 3: LLM判断（一次调用同时完成去重+合并+插入位置判断）
        return self._merge_with_llm_once(existing_document, candidate, candidate_text)

    def _merge_with_llm_once(self, existing_document: Dict[str, Any], candidate: Dict[str, Any], candidate_text: str) -> Dict[str, Any]:
        """让 LLM 只返回增量补丁，再在本地拼接，保证已有正文不会丢失。"""
        existing_title = existing_document.get('title') or ''
        existing_content = existing_document.get('full_content') or ''
        existing_summary = existing_document.get('summary') or ''
        sections_json = existing_document.get('sections_json', '[]')

        try:
            sections = json.loads(sections_json) if isinstance(sections_json, str) else sections_json
        except Exception:
            sections = []

        section_structure = "\n".join(
            f"{i+1}. {s.get('title', '未命名章节')}: {s.get('notes', '')[:60]}"
            for i, s in enumerate(sections)
        ) if sections else "（文档无章节结构）"

        system_prompt = """你在执行 bake 文档增量合并。

**输入**：已有文档 + 新 capture 内容

**任务**：
1. 判断新内容是否已被文档完全覆盖（即新内容是已有内容的子集或同义复述）
2. 如果有新信息，只输出已有文档中尚不存在的 Markdown 增量片段
3. 不要复述已有正文，不要输出合并后的完整文档；程序会在本地保留旧正文并追加增量

**输出 JSON**：
{
  "no_change": true/false,  // true=新内容已完全覆盖，无需更新
  "title": "文档标题",
  "summary": "一句话摘要",
  "content_patch": "仅包含新增信息的 Markdown 片段（仅当no_change=false时必填）",
  "insert_mode": "append|no_change",
  "target_section_index": null,
  "evidence_summary": "本次更新说明",
  "new_info_summary": "新增信息点（一句话）",
  "match_score": 0.0-1.0,
  "match_level": "high|medium|low"
}

**规则**：
- no_change=true 时 content_patch 必须为 null
- no_change=false 时 content_patch 只能包含新增且有据可查的内容
- 即使新内容是在修正旧章节，也用带明确小标题的补充说明表达，不要复制或改写旧正文
- 严禁输出 full_content；旧正文不在模型侧重写
- 严禁重复：相同信息只保留一次
"""
        existing_context = self._head_tail_context(
            existing_content,
            BAKE_DOCUMENT_MERGE_EXISTING_CONTEXT_MAX_CHARS,
        )
        candidate_context = self._head_tail_context(
            candidate_text,
            BAKE_DOCUMENT_MERGE_CANDIDATE_CONTEXT_MAX_CHARS,
        )
        user_prompt = (
            f"已有文档:\ntitle: {existing_title}\nsummary: {existing_summary}\n"
            f"章节结构:\n{section_structure}\n\n"
            f"existing_content_context（只用于查重，原文由程序完整保留）:\n{existing_context}\n\n"
            f"new_capture_context:\n{candidate_context}"
        )

        parsed, _ = self._call_bake_llm(
            f"merge_doc:{candidate.get('source_timeline_id')}",
            system_prompt,
            user_prompt,
            response_schema=BAKE_MERGE_DOCUMENT_SCHEMA,
        )

        if not parsed or not isinstance(parsed, dict):
            return {'title': existing_title, 'no_change': True}

        if bool(parsed.get('no_change')):
            parsed.pop('content_patch', None)
            parsed.pop('full_content', None)
            parsed['title'] = parsed.get('title') or existing_title
            return parsed

        content_patch = str(parsed.pop('content_patch', '') or '').strip()
        if content_patch:
            merged_content = self._append_document_patch(existing_content, content_patch)
            if merged_content == existing_content:
                parsed['no_change'] = True
                parsed['insert_mode'] = 'no_change'
                parsed.pop('full_content', None)
            else:
                parsed['no_change'] = False
                parsed['insert_mode'] = 'append'
                parsed['full_content'] = merged_content
            parsed['title'] = parsed.get('title') or existing_title
            return parsed

        # 向后兼容旧模型偶发返回 full_content，但只有它逐字包含全部旧正文时才接受。
        # 任何“重写后变短”的结果都视为 no_change，防止再次发生 171 号文档式截断。
        legacy_full_content = str(parsed.get('full_content') or '').strip()
        if legacy_full_content and self._content_preserves_existing(
            existing_content,
            legacy_full_content,
        ):
            parsed['full_content'] = legacy_full_content
            parsed['title'] = parsed.get('title') or existing_title
            return parsed

        if legacy_full_content:
            logger.warning(
                "拒绝会丢失旧正文的文档合并结果 source_timeline_id=%s existing_len=%s merged_len=%s",
                candidate.get('source_timeline_id'),
                len(existing_content),
                len(legacy_full_content),
            )
        return {'title': existing_title, 'no_change': True}

    @staticmethod
    def _head_tail_context(value: Any, limit: int) -> str:
        """长文本保留首尾用于模型查重；该窗口从不参与最终正文覆盖。"""
        text = str(value or '').strip()
        if len(text) <= limit:
            return text
        marker = "\n\n...(中间内容仅在查重上下文中省略，存储原文保持完整)...\n\n"
        available = max(0, limit - len(marker))
        head_chars = available * 2 // 3
        tail_chars = available - head_chars
        return text[:head_chars].rstrip() + marker + text[-tail_chars:].lstrip()

    @staticmethod
    def _content_preserves_existing(existing_content: str, merged_content: str) -> bool:
        existing = str(existing_content or '').strip()
        merged = str(merged_content or '').strip()
        return not existing or existing in merged

    @classmethod
    def _append_document_patch(cls, existing_content: str, content_patch: str) -> str:
        existing = str(existing_content or '').strip()
        patch = str(content_patch or '').strip()
        if not patch or patch in existing:
            return existing
        # 模型若无视“只返回增量”的要求、返回了包含完整旧正文的扩展版，也只在
        # 能逐字证明旧正文未丢失时接受，避免把整篇文档重复追加一遍。
        if cls._content_preserves_existing(existing, patch):
            return patch
        if not existing:
            return patch
        return f"{existing}\n\n{patch}"

    def extract_bake_bundle(
        self,
        candidate: Dict[str, Any],
        preempt_check: Optional[Callable[[], bool]] = None,
    ) -> Dict[str, Any]:
        """用一次 LLM 调用同时提炼 knowledge/document/SOP。"""
        bundle_started_at = time.time()
        source_timeline_id = candidate.get('source_timeline_id')
        logger.info("bake bundle start source_timeline_id=%s", source_timeline_id)

        # 检查抢占信号
        if preempt_check and preempt_check():
            logger.info("bake bundle 收到抢占信号，中断提炼 source_timeline_id=%s", source_timeline_id)
            return {
                'knowledge': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'design': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'sop': {'accepted': False, 'reason': 'preempted', 'payload': None},
                'usage': None,
                'model': self.model,
                'degraded': True,
                'stage_elapsed_ms': {},
                'total_elapsed_ms': int((time.time() - bundle_started_at) * 1000),
            }

        candidate_text = self._build_bake_candidate_text(candidate)
        user_prompt = f"候选输入如下:\n\n{candidate_text}"
        caller_id = f"bundle:{source_timeline_id}"
        try:
            parsed, meta = self._call_bake_llm(
                caller_id,
                BAKE_BUNDLE_PROMPT,
                user_prompt,
                response_schema=BAKE_BUNDLE_RESPONSE_SCHEMA,
            )
        except Exception as exc:
            elapsed_ms = int((time.time() - bundle_started_at) * 1000)
            logger.error(
                "bake bundle 提炼失败 caller=%s elapsed_ms=%s error=%s",
                caller_id,
                elapsed_ms,
                exc,
            )
            rejected = {
                'accepted': False,
                'reason': f'llm_error: {exc}',
                'payload': None,
            }
            return {
                'knowledge': rejected,
                'design': dict(rejected),
                'sop': dict(rejected),
                'usage': None,
                'model': self.model,
                'degraded': True,
                'stage_elapsed_ms': {'bundle': elapsed_ms},
                'total_elapsed_ms': elapsed_ms,
            }

        parse_failure_reason = None
        if not isinstance(parsed, dict):
            parse_failure_reason = 'empty_content' if meta.get('empty_content') else (
                'truncated_json' if meta.get('done_reason') == 'length' else 'invalid_json'
            )
            meta = {**meta, 'parse_failure_reason': parse_failure_reason}
            parsed = {}

        results: Dict[str, Dict[str, Any]] = {}
        result_meta: Dict[str, Dict[str, Any]] = {}
        for artifact_type in ('knowledge', 'design', 'sop'):
            artifact, artifact_meta = self._normalize_bake_artifact_result(
                candidate,
                artifact_type,
                parsed.get(artifact_type),
                meta,
                caller_id=caller_id,
            )
            results[artifact_type] = artifact
            result_meta[artifact_type] = artifact_meta

        degraded = bool(parse_failure_reason) or any(
            bool(item.get('degraded')) for item in result_meta.values()
        )
        total_elapsed_ms = int((time.time() - bundle_started_at) * 1000)
        per_stage_ms = {'bundle': int(meta.get('elapsed_ms') or total_elapsed_ms)}
        logger.info(
            "bake bundle done source_timeline_id=%s total_elapsed_ms=%s stage_elapsed_ms=%s degraded=%s accepted={knowledge:%s,design:%s,sop:%s}",
            source_timeline_id,
            total_elapsed_ms,
            per_stage_ms,
            degraded,
            results['knowledge'].get('accepted'),
            results['design'].get('accepted'),
            results['sop'].get('accepted'),
        )

        return {
            'knowledge': results['knowledge'],
            'design': results['design'],
            'sop': results['sop'],
            'usage': meta.get('usage'),
            'model': meta.get('model') or self.model,
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
            # RAG 优先:若 RAG 查询正在占用 Ollama，跳过本轮提炼
            if _rag_is_active():
                logger.info("RAG 查询正在进行，本轮提炼跳过")
                return None
            from monitor.llm_tracker import LLMCallTracker, estimate_tokens
            with LLMCallTracker(
                caller="knowledge",
                model_name=self.model,
                caller_id=str(capture_data.get('id')),
            ) as tracker:
                response = self._ollama_chat(
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
                    # 合并知识:更新明细内容，追加新的细节
                    cursor = db_conn.execute(
                        "SELECT details FROM timelines WHERE id = ?",
                        (similar_id,)
                    )
                    existing_details = cursor.fetchone()[0] or ""

                    # 合并明细:保留原有内容，追加新内容
                    merged_details = existing_details
                    if details and details not in existing_details:
                        merged_details += f"\n\n--- 补充 ({datetime.now().strftime('%Y-%m-%d %H:%M')}) ---\n{details}"

                    # 更新现有记录
                    db_conn.execute(
                        """UPDATE timelines
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
            logger.error(f"时间线提炼失败: {e}")
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
                # 为单个 capture 也生成 key_timestamps
                result['key_timestamps'] = json.dumps([{
                    'capture_ids': [captures[0]['id']],
                    'start_ts': captures[0]['ts'],
                    'end_ts': captures[0]['ts'],
                    'summary': result.get('summary', '')
                }])
            return result

        try:
            logger.info("extract_merged 启动: captures=%s", len(captures))
            # 1. 构建合并 prompt:按时间顺序拼接所有 capture 的文本
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
            # RAG 优先:若 RAG 查询正在占用 Ollama，跳过本轮提炼
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
                # 强化 JSON 输出约束:在 user prompt 中再次强调
                enhanced_user_prompt = f"{user_prompt}\n\n**重要**:你必须且只能输出一个有效的 JSON 对象，不要输出任何其他内容、解释或 markdown 代码块。"
                response = self._ollama_chat(
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
                return None

            overview = _normalize_inline_text(result.get('overview', ''))
            if not overview or overview == 'SKIP':
                logger.warning("合并提炼未返回有效 overview，跳过本片段（不兜底）: result=%s", result)
                return None

            quality_reason = _overview_quality_reason(overview, merged_text)
            if quality_reason:
                logger.warning("合并提炼 overview 质量不足，跳过本片段（不兜底）: reason=%s overview=%s", quality_reason, overview)
                return None

            # 4. 计算片段元数据
            start_time = captures[0]['ts']
            end_time = captures[-1]['ts']
            duration_minutes = int((end_time - start_time) / 60000)

            # 主要应用:出现次数最多的 app_name
            from collections import Counter
            app_counter = Counter(
                c.get('app_name') for c in captures if c.get('app_name')
            )
            frag_app_name = app_counter.most_common(1)[0][0] if app_counter else None

            # 主要窗口:最后一条的 win_title（最能代表当前状态）
            frag_win_title = next(
                (c.get('window_title') for c in reversed(captures) if c.get('window_title')),
                None
            )

            summary = _overview_to_summary(overview)

            # 生成语义分段
            segments = self._generate_segments(captures)

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
                'key_timestamps': json.dumps(segments),
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

    def _generate_segments(self, captures: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """生成语义分段，使用AI提炼每个分段的总结"""
        try:
            segments_map = {}
            for cap in captures:
                key = f"{cap.get('app_name')}|{cap.get('window_title', '')}"
                if key not in segments_map:
                    segments_map[key] = {
                        'capture_ids': [],
                        'start_ts': cap['ts'],
                        'end_ts': cap['ts'],
                        'app_name': cap.get('app_name', ''),
                        'window_title': cap.get('window_title', ''),
                        'texts': []
                    }
                seg = segments_map[key]
                seg['capture_ids'].append(cap['id'])
                seg['end_ts'] = cap['ts']
                text = (cap.get('ocr_text') or cap.get('ax_text') or '').strip()
                if text:
                    seg['texts'].append(text)

            logger.info(f"生成语义分段: {len(captures)} captures → {len(segments_map)} segments")
            segments = []
            for idx, seg in enumerate(segments_map.values()):
                merged_text = '\n\n'.join(seg['texts'])
                if merged_text:
                    segment_capture = {
                        'id': seg['capture_ids'][0],
                        'app_name': seg['app_name'],
                        'window_title': seg['window_title'],
                        'timestamp': datetime.fromtimestamp(seg['end_ts'] / 1000).isoformat(),
                        'ocr_text': merged_text[:2000],  # 限制长度避免过长
                    }
                    logger.info(f"分段 {idx+1}/{len(segments_map)}: 调用 AI 提炼 ({len(seg['capture_ids'])} captures)")
                    extracted = self.extract_sync(segment_capture)
                    summary = extracted.get('summary', '') if extracted else ''
                    logger.info(f"分段 {idx+1} AI 总结: {summary[:80]}...")
                else:
                    summary = ''

                if not summary:
                    summary = f"{seg['app_name']}活动"

                segments.append({
                    'capture_ids': seg['capture_ids'],
                    'start_ts': seg['start_ts'],
                    'end_ts': seg['end_ts'],
                    'summary': summary
                })
            logger.info(f"语义分段生成完成: {len(segments)} segments")
            return segments
        except Exception as e:
            logger.error(f"生成语义分段失败: {e}", exc_info=True)
            return []
