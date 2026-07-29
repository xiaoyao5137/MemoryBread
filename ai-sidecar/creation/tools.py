"""创作 Tool 的稳定标识、兼容规则和调用意图判断。"""

from __future__ import annotations

from typing import Any, Iterable

INTERNET_SEARCH_TOOL_ID = "internet_search"
MEMORY_SEARCH_TOOL_ID = "memory_search"
PLANTUML_DIAGRAM_TOOL_ID = "plantuml_diagram"
GITHUB_SEARCH_TOOL_ID = "github_search"

REQUIRED_CREATION_TOOL_IDS = (
    INTERNET_SEARCH_TOOL_ID,
    MEMORY_SEARCH_TOOL_ID,
)
OPTIONAL_CREATION_TOOL_IDS = (
    PLANTUML_DIAGRAM_TOOL_ID,
    GITHUB_SEARCH_TOOL_ID,
)
KNOWN_CREATION_TOOL_IDS = (
    *REQUIRED_CREATION_TOOL_IDS,
    *OPTIONAL_CREATION_TOOL_IDS,
)


def normalize_creation_tool_ids(value: Any) -> tuple[str, ...]:
    """强制保留必备 Tool，同时对可选和未来 Tool ID 做稳定去重。"""
    normalized = list(REQUIRED_CREATION_TOOL_IDS)
    candidates: Iterable[Any] = value if isinstance(value, (list, tuple, set)) else ()
    for candidate in candidates:
        tool_id = str(candidate or "").strip()
        if tool_id and tool_id not in normalized:
            normalized.append(tool_id)
    return tuple(normalized)


def should_use_internet_search(text: str, requirement: dict[str, Any]) -> bool:
    if requirement.get("needs_latest"):
        return True
    return _contains_any(
        text,
        (
            "互联网",
            "联网",
            "网上",
            "搜索",
            "检索",
            "最新",
            "近期",
            "新闻",
            "政策",
            "法规",
            "标准",
            "行业调研",
            "市场调研",
            "竞品",
            "趋势",
            "价格",
        ),
    )


def should_use_github_search(text: str) -> bool:
    return _contains_any(
        text,
        (
            "github",
            "开源",
            "代码仓库",
            "仓库",
            "repository",
            "repo",
            "sdk",
            "框架选型",
            "技术选型",
        ),
    )


def should_use_plantuml(text: str, requirement: dict[str, Any]) -> bool:
    if requirement.get("needs_images"):
        return True
    return _contains_any(
        text,
        (
            "plantuml",
            "画图",
            "图示",
            "架构图",
            "流程图",
            "时序图",
            "组件图",
            "关系图",
            "部署图",
            "活动图",
        ),
    )


def build_plantuml_context(text: str) -> dict[str, str]:
    lowered = text.lower()
    if "时序" in text or "sequence" in lowered:
        diagram_type = "sequence"
        starter = "@startuml\nactor 用户\nparticipant 系统\n用户 -> 系统: 发起请求\n系统 --> 用户: 返回结果\n@enduml"
    elif "流程" in text or "活动" in text or "activity" in lowered:
        diagram_type = "activity"
        starter = "@startuml\nstart\n:接收输入;\n:执行处理;\n:输出结果;\nstop\n@enduml"
    elif "部署" in text or "deployment" in lowered:
        diagram_type = "deployment"
        starter = "@startuml\nnode 客户端\nnode 服务端\n客户端 --> 服务端: 请求\n@enduml"
    else:
        diagram_type = "component"
        starter = "@startuml\nleft to right direction\ncomponent 客户端\ncomponent 核心服务\n客户端 --> 核心服务: 调用\n@enduml"
    return {
        "diagram_type": diagram_type,
        "language": "plantuml",
        "starter": starter,
        "instruction": (
            "在正文最适合的位置输出一段 ```plantuml 代码块；"
            "基于正文真实对象替换示例节点，保持图中术语与正文一致，"
            "只绘制已经说明的边界和关系。"
        ),
    }


def _contains_any(text: str, markers: tuple[str, ...]) -> bool:
    normalized = text.lower()
    return any(marker.lower() in normalized for marker in markers)
