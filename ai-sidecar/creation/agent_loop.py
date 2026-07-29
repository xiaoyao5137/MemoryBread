"""目标驱动的创作 Agent Loop。

创作 Agent 只负责维护目标、环境和下一步计划。子 Agent、Tool、Skill 的每次
执行都会先产生可观察事件，再把结果写回环境，随后重新评估剩余步骤。
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import asdict, dataclass, field
from difflib import SequenceMatcher
from typing import Any, AsyncIterator, Optional
from uuid import uuid4

from .service import CreationOptions, CreationService, ReferenceDocument
from .tools import (
    GITHUB_SEARCH_TOOL_ID,
    INTERNET_SEARCH_TOOL_ID,
    MEMORY_SEARCH_TOOL_ID,
    PLANTUML_DIAGRAM_TOOL_ID,
    build_plantuml_context,
    normalize_creation_tool_ids,
    should_use_github_search,
    should_use_internet_search,
    should_use_plantuml,
)

SCHEMA_VERSION = "creation.agent.v1"
MAX_LOOP_STEPS = 64
MAX_SKILL_STEP_RESOURCES = 4
KNOWN_SECTION_TITLES = (
    "行业调研",
    "市场调研",
    "市场分析",
    "竞品分析",
    "用户调研",
    "需求分析",
    "背景与目标",
    "总体架构",
    "功能设计",
    "交互设计",
    "数据分析",
    "实施计划",
    "风险与验证",
    "验收标准",
    "后续核验与补充清单",
)
APPEND_MARKERS = ("补充", "新增", "增加", "添加", "加上", "完善", "扩展", "补上")
DELETE_MARKERS = ("删除", "删掉", "移除", "去掉")
REPLACE_MARKERS = ("修改", "调整", "改成", "改为", "替换", "重写")
GLOBAL_REWRITE_MARKERS = (
    "全文",
    "整篇",
    "整体重写",
    "全部重写",
    "重新生成",
    "推倒重来",
    "统一改写",
)
SECTION_ORDER_RULES = (
    (10, ("背景", "目标", "现状", "概述", "原则")),
    (20, ("行业", "市场", "竞品", "用户调研", "用户与场景")),
    (30, ("需求", "约束", "数据", "指标", "统计", "分析")),
    (40, ("总体", "架构", "方案", "策略", "设计", "机制", "决策")),
    (50, ("功能", "组件", "模块", "流程", "接口", "数据流")),
    (60, ("实施", "落地", "执行", "路线", "里程碑", "演进")),
    (70, ("运营", "治理", "保障")),
    (80, ("风险", "安全", "合规")),
    (90, ("验证", "验收", "评估")),
    (100, ("参考", "核验", "补充清单", "结语", "总结")),
)


@dataclass(frozen=True)
class BuiltinSkill:
    id: str
    name: str
    summary: str
    triggers: tuple[str, ...]
    structure: tuple[str, ...]
    guidelines: tuple[str, ...]


BUILTIN_SKILLS = (
    BuiltinSkill(
        id="technical-solution-template",
        name="技术方案模板 Skill",
        summary="适用于技术选型、接口、模块设计和实施验证类方案。",
        triggers=("技术方案", "技术设计", "接口", "模块", "研发", "实现"),
        structure=("背景与目标", "需求与约束", "总体方案", "详细设计", "实施计划", "风险与验证"),
        guidelines=("明确系统边界和不做事项", "关键取舍必须说明依据", "每项风险给出验证方式"),
    ),
    BuiltinSkill(
        id="architecture-solution-template",
        name="架构方案模板 Skill",
        summary="适用于系统架构、平台建设、服务边界和演进路线类方案。",
        triggers=("架构", "平台", "系统设计", "服务边界", "高可用", "扩展性"),
        structure=("目标与原则", "现状与约束", "总体架构", "组件与数据流", "关键决策", "演进与验证"),
        guidelines=("用 Mermaid 表达核心关系", "区分逻辑架构与部署架构", "记录备选方案和决策理由"),
    ),
    BuiltinSkill(
        id="product-prd-template",
        name="产品 PRD 方案模板 Skill",
        summary="适用于产品需求、用户流程、功能范围和验收标准类文档。",
        triggers=("PRD", "产品需求", "用户故事", "功能需求", "产品方案"),
        structure=("背景与目标", "用户与场景", "范围与优先级", "功能设计", "交互与状态", "验收与指标"),
        guidelines=("需求必须映射到用户目标", "覆盖加载、空、错误和权限状态", "用可验证条件表达验收标准"),
    ),
)


@dataclass
class GoalState:
    objective: str
    status: str = "active"
    revision: int = 0
    acceptance_criteria: list[str] = field(default_factory=list)
    remaining_steps: list[str] = field(default_factory=list)
    outcome: str = ""


@dataclass(frozen=True)
class EditIntent:
    """面向用户展示且可执行的意图摘要，不包含模型私有思维过程。"""

    mode: str
    operation: str
    target_sections: tuple[str, ...] = ()
    preserve_untouched: bool = True
    summary: str = ""
    reasoning_summary: str = ""


@dataclass
class LoopState:
    session_id: str
    run_id: str
    mode: str
    model_mode: str
    user_message: str
    root_request: str
    current_document: str
    conversation: list[dict[str, str]]
    options: dict[str, Any]
    selected_skills: list[dict[str, Any]]
    goal: GoalState
    environment: dict[str, Any] = field(default_factory=dict)
    plan: list[dict[str, Any]] = field(default_factory=list)
    cursor: int = 0
    sequence: int = 0
    pending_model_step: Optional[dict[str, Any]] = None
    writer_revisions: int = 0

    def serializable(self) -> dict[str, Any]:
        value = asdict(self)
        value["goal"] = asdict(self.goal)
        return value

    @classmethod
    def restore(cls, value: dict[str, Any]) -> "LoopState":
        data = dict(value)
        data.setdefault("root_request", data.get("user_message", ""))
        data["goal"] = GoalState(**data["goal"])
        return cls(**data)


class CreationAgentLoop:
    """创作 Agent 的可暂停、可恢复状态机。"""

    def __init__(self, service: CreationService):
        self.service = service

    async def run(
        self,
        *,
        user_message: str,
        root_request: str | None = None,
        current_document: str,
        conversation: list[dict[str, str]],
        selected_skills: list[dict[str, Any]],
        options: CreationOptions,
        model_mode: str = "local",
        session_id: str | None = None,
        run_id: str | None = None,
        confirmed: bool = False,
        resume_state: dict[str, Any] | None = None,
        model_result: str | None = None,
        creation_model: str | None = None,
        creation_api_key: str | None = None,
        creation_base_url: str | None = None,
    ) -> AsyncIterator[dict[str, Any]]:
        if resume_state:
            state = LoopState.restore(resume_state)
            yield self._event(state, "run.resumed", "创作 Agent 已恢复创作循环")
            if not state.pending_model_step or model_result is None:
                yield self._event(
                    state,
                    "run.failed",
                    "恢复创作循环时缺少待处理的模型结果",
                    status="failed",
                )
                return
            async for event in self._apply_model_result(state, model_result):
                yield event
        else:
            state = self._new_state(
                user_message=user_message,
                root_request=root_request,
                current_document=current_document,
                conversation=conversation,
                selected_skills=selected_skills,
                options=options,
                model_mode=model_mode,
                session_id=session_id,
                run_id=run_id,
            )
            yield self._event(state, "run.started", "创作 Agent 已接管目标")
            yield self._event(
                state,
                "goal.updated",
                "已建立创作目标与验收条件",
                environment_patch={
                    "mode": state.mode,
                    "root_request": state.root_request,
                },
            )
            intent = state.environment["edit_intent"]
            yield self._event(
                state,
                "intent.interpreted",
                str(intent["summary"]),
                status="completed",
                actor=self._actor("agent", "creation_main_agent", "创作 Agent"),
                data={
                    "operation": intent["operation"],
                    "target_sections": intent["target_sections"],
                    "preserve_untouched": intent["preserve_untouched"],
                    "reasoning_summary": intent["reasoning_summary"],
                    "root_request": state.root_request,
                    "current_instruction": state.user_message,
                },
            )
            if self._needs_confirmation(state) and not confirmed:
                state.goal.status = "waiting_user"
                yield self._event(
                    state,
                    "confirmation.required",
                    "需要确认后才能继续",
                    status="waiting",
                    actor=self._actor("agent", "creation_main_agent", "创作 Agent"),
                    data={
                        "question": "当前要求较简略。是否按现有信息继续，由 Agent 补全合理假设？",
                        "confirm_label": "按当前信息继续",
                        "request_id": f"confirm-{uuid4()}",
                    },
                )
                yield self._event(
                    state,
                    "run.paused",
                    "创作循环正在等待用户确认",
                    status="waiting",
                    data={"reason": "user_confirmation"},
                )
                return

        loop_count = 0
        while state.cursor < len(state.plan) and loop_count < MAX_LOOP_STEPS:
            loop_count += 1
            step = state.plan[state.cursor]
            state.cursor += 1
            state.goal.remaining_steps = [item["name"] for item in state.plan[state.cursor:]]
            try:
                async for event in self._execute_step(
                    state,
                    step,
                    creation_model=creation_model,
                    creation_api_key=creation_api_key,
                    creation_base_url=creation_base_url,
                ):
                    yield event
            except Exception:
                if step.get("kind") != "tool":
                    raise
                tool_id = str(step.get("id") or "")
                state.environment.setdefault("tool_results", []).append(
                    {
                        "tool_id": tool_id,
                        "status": "failed",
                        "error_code": "TOOL_EXECUTION_FAILED",
                    }
                )
                self._update_goal(state)
                yield self._event(
                    state,
                    "tool.failed",
                    f"{step.get('name', 'Tool')} 暂时不可用，Agent 将基于已有上下文继续",
                    status="failed",
                    actor=self._actor(
                        "tool",
                        tool_id,
                        str(step.get("name") or "Tool"),
                    ),
                    data={"error_code": "TOOL_EXECUTION_FAILED"},
                )
            if state.pending_model_step:
                yield self._event(
                    state,
                    "run.paused",
                    "等待品牌模型返回当前子 Agent 的结果",
                    status="waiting",
                    data={
                        "reason": "external_model",
                        "continuation": state.serializable(),
                    },
                )
                return

        if loop_count >= MAX_LOOP_STEPS and state.cursor < len(state.plan):
            state.goal.status = "failed"
            state.goal.outcome = "Agent Loop 超过最大步数"
            yield self._event(state, "run.failed", state.goal.outcome, status="failed")
            return

        hard_failures = [
            str(item)
            for item in state.environment.get("quality_hard_failures", [])
        ]
        soft_warnings = [
            str(item)
            for item in state.environment.get("quality_soft_warnings", [])
        ]
        quality_warnings = [*hard_failures, *soft_warnings]
        state.goal.status = "complete"
        state.goal.remaining_steps = []
        state.goal.outcome = (
            "已生成可用文档，并记录待核验项"
            if quality_warnings
            else "已生成满足当前验收条件的文档"
        )
        yield self._event(
            state,
            "goal.updated",
            state.goal.outcome,
            environment_patch={
                "document_ready": True,
                "quality_warnings": quality_warnings,
            },
        )
        yield self._event(
            state,
            "run.completed",
            "本轮创作完成，可以继续对话优化文档",
            status="completed",
            data={
                "document": state.environment.get("document", state.current_document),
                "references": state.environment.get("reference_summaries", []),
                "skills": state.environment.get("applied_skills", []),
                "tools": state.environment.get("tool_results", []),
                "edit_intent": state.environment.get("edit_intent", {}),
                "document_patch": state.environment.get("last_document_patch"),
                "goal": asdict(state.goal),
            },
        )

    def _new_state(
        self,
        *,
        user_message: str,
        root_request: str | None,
        current_document: str,
        conversation: list[dict[str, str]],
        selected_skills: list[dict[str, Any]],
        options: CreationOptions,
        model_mode: str,
        session_id: str | None,
        run_id: str | None,
    ) -> LoopState:
        message = user_message.strip()
        normalized_conversation = self._normalize_conversation(conversation)
        resolved_root_request = self._resolve_root_request(
            root_request,
            normalized_conversation,
            message,
        )
        mode = "revision" if current_document.strip() else "initial"
        intent = self._interpret_edit_intent(
            message,
            current_document=current_document,
            mode=mode,
        )
        objective = (
            (
                f"以原始需求“{resolved_root_request}”为基线，"
                f"按本轮要求优化现有文档（冲突处以本轮为准）：{message}"
            )
            if mode == "revision"
            else f"生成一份可直接使用的文档：{resolved_root_request}"
        )
        goal = GoalState(
            objective=objective,
            acceptance_criteria=[
                f"保留原始需求中未被本轮替换的约束：{resolved_root_request}",
                "完整回应用户本轮要求",
                "事实与参考资料可追溯，不编造具体数据",
                "结构清晰，输出为可继续编辑的 Markdown 文档",
                "保留现有文档中未被要求删除的有效内容",
            ],
        )
        state = LoopState(
            session_id=session_id or f"session-{uuid4()}",
            run_id=run_id or f"run-{uuid4()}",
            mode=mode,
            model_mode=model_mode,
            user_message=message,
            root_request=resolved_root_request,
            current_document=current_document,
            conversation=normalized_conversation,
            options=asdict(options),
            selected_skills=selected_skills[:8],
            goal=goal,
        )
        context_query = (
            f"{resolved_root_request}\n本轮补充：{message}"
            if mode == "revision" and resolved_root_request != message
            else message
        )
        requirement = self.service.analyze_requirement(context_query, options)
        state.environment["requirement"] = requirement
        state.environment["context_query"] = context_query
        edit_intent = asdict(intent)
        edit_intent["target_sections"] = list(intent.target_sections)
        state.environment["edit_intent"] = edit_intent
        if mode == "revision":
            state.environment["revision_base_document"] = current_document
        state.plan = self._build_plan(state)
        state.goal.remaining_steps = [item["name"] for item in state.plan]
        return state

    @staticmethod
    def _resolve_root_request(
        root_request: str | None,
        conversation: list[dict[str, str]],
        user_message: str,
    ) -> str:
        explicit = (root_request or "").strip()
        if explicit:
            return explicit[:12000]
        for item in conversation:
            if item.get("role") == "user" and str(item.get("content") or "").strip():
                return str(item["content"]).strip()[:12000]
        return user_message[:12000]

    def _interpret_edit_intent(
        self,
        user_message: str,
        *,
        current_document: str,
        mode: str,
    ) -> EditIntent:
        if mode == "initial":
            return EditIntent(
                mode=mode,
                operation="create_document",
                preserve_untouched=False,
                summary="理解为新建文档，将按完整需求生成首版内容",
                reasoning_summary="当前没有可编辑的既有文档，因此需要生成首个完整版本。",
            )

        message = user_message.strip()
        existing_titles = self._markdown_section_titles(current_document)
        targets = self._find_target_sections(message, existing_titles)

        if any(marker in message for marker in GLOBAL_REWRITE_MARKERS):
            return EditIntent(
                mode=mode,
                operation="rewrite_document",
                preserve_untouched=False,
                summary="理解为整篇改写，将重新生成完整文档",
                reasoning_summary="本轮指令明确作用于全文，无法安全限定到单一章节。",
            )

        target_text = "、".join(f"“{target}”" for target in targets)
        if targets:
            summary = f"理解为围绕{target_text}联动修订完整文档"
            reasoning = (
                "目标章节仅作为改动线索；创作 Agent 会结合全文判断实际影响范围，"
                "同步更新目录、摘要、编号、交叉引用及其他受影响章节。"
            )
        else:
            summary = "理解为结合本轮要求修订完整文档"
            reasoning = (
                "本轮要求可能影响多个位置；创作 Agent 会在完整上下文中判断变更范围，"
                "并保留未受影响的有效内容。"
            )
        return EditIntent(
            mode=mode,
            operation="revise_document",
            target_sections=tuple(targets),
            preserve_untouched=True,
            summary=summary,
            reasoning_summary=reasoning,
        )

    @staticmethod
    def _markdown_section_titles(document: str) -> list[str]:
        titles: list[str] = []
        for match in re.finditer(r"(?m)^#{2,6}\s+(.+?)\s*$", document):
            title = re.sub(r"\s+#+\s*$", "", match.group(1)).strip()
            if title and title not in titles:
                titles.append(title)
        return titles

    def _find_target_section(
        self,
        message: str,
        existing_titles: list[str],
    ) -> str | None:
        targets = self._find_target_sections(message, existing_titles)
        return targets[0] if targets else None

    def _find_target_sections(
        self,
        message: str,
        existing_titles: list[str],
    ) -> list[str]:
        compact_message = self._normalize_section_name(message)
        candidates = sorted(
            [*KNOWN_SECTION_TITLES, *existing_titles],
            key=len,
            reverse=True,
        )
        targets: list[str] = []
        for title in candidates:
            normalized = self._normalize_section_name(title)
            if normalized and normalized in compact_message:
                matched = self._match_existing_section(title, existing_titles)
                target = matched or title
                if target not in targets:
                    targets.append(target)

        for quoted in re.finditer(r"[《“\"']([^》”\"']{2,40})[》”\"']", message):
            target = quoted.group(1).strip()
            matched = self._match_existing_section(target, existing_titles)
            target = matched or target
            if target not in targets:
                targets.append(target)

        for marker in (*APPEND_MARKERS, *DELETE_MARKERS, *REPLACE_MARKERS):
            if marker not in message:
                continue
            tail = message.split(marker, 1)[1]
            tail = re.sub(r"^(?:一下|下|一下子|关于|对|把|将|文档中|文档里的)*", "", tail)
            tail = re.split(r"[，。；：,;:\n]", tail, maxsplit=1)[0]
            tail = re.sub(r"(?:章节|部分|内容|这一节|这部分).*$", "", tail).strip()
            for item in re.split(r"(?:以及|并且|同时|和|与|及|、)", tail):
                target = item.strip()
                if not 2 <= len(target) <= 24:
                    continue
                matched = self._match_existing_section(target, existing_titles)
                target = matched or target
                if target not in targets:
                    targets.append(target)
        return targets[:8]

    @classmethod
    def _match_existing_section(
        cls,
        target: str,
        existing_titles: list[str],
    ) -> str | None:
        normalized_target = cls._normalize_section_name(target)
        for title in existing_titles:
            normalized_title = cls._normalize_section_name(title)
            if (
                normalized_title == normalized_target
                or normalized_title in normalized_target
                or normalized_target in normalized_title
            ):
                return title
        return None

    @staticmethod
    def _normalize_section_name(value: str) -> str:
        return re.sub(r"[\s：:、，,。.!！?？（）()《》“”\"'`#_-]+", "", value).lower()

    def _build_plan(self, state: LoopState) -> list[dict[str, Any]]:
        requirement = state.environment["requirement"]
        text = str(state.environment.get("context_query") or state.user_message)
        enabled_tools = set(
            normalize_creation_tool_ids(state.options.get("enabled_tools"))
        )
        matched_skills = self._match_skills(state)
        use_internet_search = (
            INTERNET_SEARCH_TOOL_ID in enabled_tools
            and should_use_internet_search(text, requirement)
        )
        plan: list[dict[str, Any]] = [
            {
                "kind": "agent",
                "id": "creation_main_agent",
                "name": "创作 Agent",
                "action": "plan",
            }
        ]
        for skill in matched_skills:
            plan.append(
                {
                    "kind": "skill",
                    "id": str(skill["id"]),
                    "name": str(skill["name"]),
                    "action": "apply_skill",
                    "skill": skill,
                }
            )

        primary_workflow = (
            matched_skills[0].get("execution_steps", [])
            if matched_skills
            else []
        )
        if primary_workflow:
            plan.extend(
                self._plan_skill_workflow(
                    primary_workflow,
                    matched_skills[0],
                    enabled_tools,
                )
            )
        else:
            if MEMORY_SEARCH_TOOL_ID in enabled_tools:
                plan.append(self._tool_plan_step(MEMORY_SEARCH_TOOL_ID))
            if use_internet_search:
                plan.append(self._tool_plan_step(INTERNET_SEARCH_TOOL_ID))
            if (
                GITHUB_SEARCH_TOOL_ID in enabled_tools
                and should_use_github_search(text)
            ):
                plan.append(self._tool_plan_step(GITHUB_SEARCH_TOOL_ID))
            if (
                PLANTUML_DIAGRAM_TOOL_ID in enabled_tools
                and should_use_plantuml(text, requirement)
            ):
                plan.append(self._tool_plan_step(PLANTUML_DIAGRAM_TOOL_ID))

            if any(
                marker in text
                for marker in ("数据", "指标", "分析", "统计", "趋势", "成本", "收益")
            ):
                plan.append(self._agent_plan_step("data_analysis_agent"))
            if use_internet_search:
                plan.append(self._agent_plan_step("industry_research_agent"))
            if any(
                marker in f"{text} {requirement.get('doc_type', '')}"
                for marker in ("方案", "架构", "PRD", "设计", "规划", "建设")
            ):
                plan.append(self._agent_plan_step("solution_design_agent"))

        scheduled_actions = {str(item.get("id")) for item in plan}
        if "document_writer_agent" not in scheduled_actions:
            plan.append(self._agent_plan_step("document_writer_agent"))
        if "quality_review_agent" not in scheduled_actions:
            plan.append(self._agent_plan_step("quality_review_agent"))
        return plan

    def _plan_skill_workflow(
        self,
        workflow: list[dict[str, Any]],
        skill: dict[str, Any],
        enabled_tools: set[str],
    ) -> list[dict[str, Any]]:
        plan: list[dict[str, Any]] = []
        for raw_step in workflow[:12]:
            if not isinstance(raw_step, dict):
                continue
            step_id = str(raw_step.get("id") or "")
            step_title = str(raw_step.get("title") or step_id or "技能步骤")
            step_skills = [
                str(item)
                for item in raw_step.get("skills", [])
                if str(item or "").strip()
            ][:8]
            metadata = {
                "skill_id": str(skill["id"]),
                "skill_step_id": step_id,
                "skill_step_title": step_title,
                "skill_step_objective": str(raw_step.get("objective") or ""),
                "skill_step_output": str(raw_step.get("output") or ""),
                "skill_step_skills": step_skills,
            }
            scheduled_in_step: set[str] = set()
            resource_count = 0
            for tool_id in raw_step.get("tools", []):
                tool_id = str(tool_id)
                if (
                    tool_id not in enabled_tools
                    or tool_id in scheduled_in_step
                    or resource_count >= MAX_SKILL_STEP_RESOURCES
                ):
                    continue
                tool_step = self._tool_plan_step(tool_id)
                if tool_step:
                    plan.append({**tool_step, **metadata})
                    scheduled_in_step.add(tool_id)
                    resource_count += 1
            for agent_id in raw_step.get("agents", []):
                agent_id = str(agent_id)
                if (
                    agent_id in scheduled_in_step
                    or resource_count >= MAX_SKILL_STEP_RESOURCES
                ):
                    continue
                agent_step = self._agent_plan_step(agent_id)
                if agent_step:
                    plan.append({**agent_step, **metadata})
                    scheduled_in_step.add(agent_id)
                    resource_count += 1
            if resource_count == 0:
                plan.append(
                    {
                        "kind": "skill",
                        "id": f"{skill['id']}:{step_id or len(plan) + 1}",
                        "name": f"{skill['name']} · {step_title}",
                        "action": "activate_skill_step",
                        **metadata,
                    }
                )
        return plan

    @staticmethod
    def _tool_plan_step(tool_id: str) -> dict[str, Any] | None:
        definitions = {
            MEMORY_SEARCH_TOOL_ID: ("记忆搜索 Tool", "memory_search"),
            INTERNET_SEARCH_TOOL_ID: ("互联网检索 Tool", "internet_search"),
            GITHUB_SEARCH_TOOL_ID: ("GitHub 检索 Tool", GITHUB_SEARCH_TOOL_ID),
            PLANTUML_DIAGRAM_TOOL_ID: (
                "PlantUML 画图 Tool",
                PLANTUML_DIAGRAM_TOOL_ID,
            ),
        }
        definition = definitions.get(tool_id)
        if not definition:
            return None
        name, action = definition
        return {
            "kind": "tool",
            "id": tool_id,
            "name": name,
            "action": action,
        }

    @staticmethod
    def _agent_plan_step(agent_id: str) -> dict[str, Any] | None:
        definitions = {
            "industry_research_agent": (
                "行业调研 Agent",
                "specialist",
                "industry_research",
            ),
            "data_analysis_agent": (
                "数据分析 Agent",
                "specialist",
                "data_analysis",
            ),
            "solution_design_agent": (
                "方案设计 Agent",
                "specialist",
                "solution_design",
            ),
            "document_writer_agent": ("文档撰写 Agent", "writer", None),
            "quality_review_agent": ("质量审校 Agent", "review", None),
        }
        definition = definitions.get(agent_id)
        if not definition:
            return None
        name, action, output_key = definition
        step = {
            "kind": "agent",
            "id": agent_id,
            "name": name,
            "action": action,
        }
        if output_key:
            step["output_key"] = output_key
        return step

    def _match_skills(self, state: LoopState) -> list[dict[str, Any]]:
        matches: list[dict[str, Any]] = []
        for item in state.selected_skills:
            title = str(item.get("title") or item.get("name") or "已安装技能")
            matches.append(
                {
                    "id": item.get("id") or item.get("clientSkillKey") or title,
                    "name": title,
                    "summary": item.get("summary") or "",
                    "skill_description": (
                        item.get("skillDescription")
                        or item.get("skill_description")
                        or {}
                    ),
                    "execution_steps": (
                        item.get("executionSteps")
                        or item.get("execution_steps")
                        or []
                    ),
                    "title_design_style": (
                        item.get("titleDesignStyle")
                        or item.get("title_design_style")
                        or []
                    ),
                    "writing_design": (
                        item.get("writingDesign")
                        or item.get("writing_design")
                        or ""
                    ),
                    "image_generation": (
                        item.get("imageGeneration")
                        or item.get("image_generation")
                        or ""
                    ),
                    "structure": item.get("structurePattern") or item.get("structure_pattern") or [],
                    "voice_style": (
                        item.get("voiceStyle")
                        or item.get("voice_style")
                        or item.get("writingGuidelines")
                        or item.get("writing_guidelines")
                        or []
                    ),
                    # 保留旧键供恢复态兼容；新撰写提示以 voice_style 为准。
                    "guidelines": (
                        item.get("voiceStyle")
                        or item.get("voice_style")
                        or item.get("writingGuidelines")
                        or item.get("writing_guidelines")
                        or []
                    ),
                    "field_examples": item.get("fieldExamples") or item.get("field_examples") or {},
                    "example_document": item.get("exampleDocument") or item.get("example_document") or "",
                    "source": "installed",
                }
            )

        haystack = " ".join(
            [
                state.root_request,
                state.user_message,
                str(state.environment["requirement"].get("doc_type") or ""),
            ]
        )
        scored = [
            (sum(1 for trigger in skill.triggers if trigger.lower() in haystack.lower()), skill)
            for skill in BUILTIN_SKILLS
        ]
        scored.sort(key=lambda item: item[0], reverse=True)
        if scored and scored[0][0] > 0:
            skill = scored[0][1]
            matches.append(
                {
                    "id": skill.id,
                    "name": skill.name,
                    "summary": skill.summary,
                    "structure": list(skill.structure),
                    "guidelines": list(skill.guidelines),
                    "source": "builtin_market",
                }
            )

        seen: set[str] = set()
        result = []
        for item in matches:
            key = str(item["id"])
            if key in seen:
                continue
            seen.add(key)
            result.append(item)
        return result[:4]

    async def _execute_step(
        self,
        state: LoopState,
        step: dict[str, Any],
        *,
        creation_model: str | None,
        creation_api_key: str | None,
        creation_base_url: str | None,
    ) -> AsyncIterator[dict[str, Any]]:
        actor = self._actor(step["kind"], step["id"], step["name"])
        yield self._event(
            state,
            f"{step['kind']}.started",
            f"{step['name']} 开始执行",
            actor=actor,
        )

        action = step["action"]
        if action == "plan":
            state.environment["plan_summary"] = [item["name"] for item in state.plan[1:]]
            self._update_goal(state)
            yield self._event(
                state,
                "agent.completed",
                f"已根据目标动态选择 {len(state.plan) - 1} 个后续能力",
                status="completed",
                actor=actor,
                environment_patch={"plan": state.environment["plan_summary"]},
            )
            return

        if action == "memory_search":
            options = CreationOptions(**state.options)
            requirement = state.environment["requirement"]
            references = self.service.retrieve_references(
                self._step_context_query(state, step),
                requirement,
                options,
            )
            state.environment["references"] = [self._reference_to_state(item) for item in references]
            state.environment["reference_summaries"] = [
                {
                    "id": item.id,
                    "title": item.title,
                    "doc_type": item.doc_type,
                    "reason": item.reason,
                    "final_weight": round(item.final_weight, 4),
                    "relevance_score": round(item.relevance_score, 4),
                    "quality_score": round(item.quality_score, 4),
                    "completeness_score": round(item.completeness_score, 4),
                    "usage_score": round(item.usage_score, 4),
                    "format_score": round(item.format_score, 4),
                    "freshness_score": round(item.freshness_score, 4),
                    "usage_count": item.usage_count,
                    "summary": self.service._clip(item.summary, 600),
                    "source_url": item.source_url,
                }
                for item in references
            ]
            state.environment.setdefault("tool_results", []).append(
                {
                    "tool_id": MEMORY_SEARCH_TOOL_ID,
                    "status": "completed",
                    "result_count": len(references),
                }
            )
            self._update_goal(state)
            yield self._event(
                state,
                "tool.completed",
                f"记忆搜索完成，召回 {len(references)} 条本地资料",
                status="completed",
                actor=actor,
                environment_patch={"references": state.environment["reference_summaries"]},
                data={"result_count": len(references)},
            )
            return

        if action == "internet_search":
            results = await self.service.collect_web_context(
                self._step_context_query(state, step),
                state.environment["requirement"],
            )
            state.environment["web_results"] = [asdict(item) for item in results]
            state.environment.setdefault("tool_results", []).append(
                {
                    "tool_id": INTERNET_SEARCH_TOOL_ID,
                    "status": "completed",
                    "result_count": len(results),
                }
            )
            self._update_goal(state)
            yield self._event(
                state,
                "tool.completed",
                f"互联网检索完成，获得 {len(results)} 条外部资料",
                status="completed",
                actor=actor,
                environment_patch={
                    "web_results": [
                        {"title": item.title, "url": item.url} for item in results
                    ]
                },
                data={"result_count": len(results)},
            )
            return

        if action == GITHUB_SEARCH_TOOL_ID:
            results = await self.service.search_github_context(
                self._step_context_query(state, step),
                state.environment["requirement"],
            )
            state.environment["github_results"] = [asdict(item) for item in results]
            state.environment.setdefault("tool_results", []).append(
                {
                    "tool_id": GITHUB_SEARCH_TOOL_ID,
                    "status": "completed",
                    "result_count": len(results),
                }
            )
            self._update_goal(state)
            yield self._event(
                state,
                "tool.completed",
                f"GitHub 检索完成，获得 {len(results)} 个公开仓库线索",
                status="completed",
                actor=actor,
                environment_patch={
                    "github_results": [
                        {
                            "full_name": item.full_name,
                            "url": item.url,
                            "stars": item.stars,
                        }
                        for item in results
                    ]
                },
                data={"result_count": len(results)},
            )
            return

        if action == PLANTUML_DIAGRAM_TOOL_ID:
            diagram_context = build_plantuml_context(
                self._step_context_query(state, step)
            )
            state.environment["plantuml_diagram"] = diagram_context
            state.environment.setdefault("tool_results", []).append(
                {
                    "tool_id": PLANTUML_DIAGRAM_TOOL_ID,
                    "status": "completed",
                    "diagram_type": diagram_context["diagram_type"],
                }
            )
            self._update_goal(state)
            yield self._event(
                state,
                "tool.completed",
                f"PlantUML 画图准备完成，将生成 {diagram_context['diagram_type']} 图",
                status="completed",
                actor=actor,
                environment_patch={
                    "plantuml_diagram": {
                        "diagram_type": diagram_context["diagram_type"],
                        "language": diagram_context["language"],
                    }
                },
                data={"diagram_type": diagram_context["diagram_type"]},
            )
            return

        if action == "apply_skill":
            skill = step["skill"]
            state.environment.setdefault("applied_skills", []).append(skill)
            self._update_goal(state)
            yield self._event(
                state,
                "skill.completed",
                f"已把 {step['name']} 的结构与写作规则写入环境",
                status="completed",
                actor=actor,
                environment_patch={
                    "skill": {
                        "id": skill["id"],
                        "name": skill["name"],
                        "source": skill.get("source"),
                    }
                },
            )
            return

        if action == "activate_skill_step":
            step_result = {
                "skill_id": step.get("skill_id"),
                "step_id": step.get("skill_step_id"),
                "title": step.get("skill_step_title"),
                "objective": step.get("skill_step_objective"),
                "output": step.get("skill_step_output"),
                "skills": step.get("skill_step_skills", []),
            }
            state.environment.setdefault("completed_skill_steps", []).append(step_result)
            self._update_goal(state)
            yield self._event(
                state,
                "skill.completed",
                f"已激活工作流步骤：{step.get('skill_step_title') or step['name']}",
                status="completed",
                actor=actor,
                environment_patch={"skill_step": step_result},
            )
            return

        if action in {"specialist", "writer"}:
            intent = state.environment.get("edit_intent", {})
            is_revision = action == "writer" and state.mode == "revision"
            if is_revision:
                targets = [str(item) for item in intent.get("target_sections", [])]
                yield self._event(
                    state,
                    "document.patch.planned",
                    (
                        f"将以{'、'.join(targets)}为线索检查全文联动"
                        if targets
                        else "将结合本轮要求检查全文联动"
                    ),
                    status="completed",
                    actor=actor,
                    data={
                        "operation": intent.get("operation"),
                        "target_sections": targets,
                        "preserve_untouched": intent.get("preserve_untouched", True),
                        "reasoning_summary": intent.get("reasoning_summary"),
                    },
                )

            system_prompt, user_prompt = self._model_prompts(state, step)
            if state.model_mode == "external":
                state.pending_model_step = {
                    "step": step,
                    "system_prompt": system_prompt,
                    "user_prompt": user_prompt,
                }
                yield self._event(
                    state,
                    "model.request",
                    f"{step['name']} 请求品牌模型推理",
                    status="waiting",
                    actor=actor,
                    data={
                        "request_id": f"model-{uuid4()}",
                        "messages": [
                            {"role": "system", "content": system_prompt},
                            {"role": "user", "content": user_prompt},
                        ],
                    },
                )
                return

            if action == "writer":
                document_parts: list[str] = []
                async for chunk in self.service.stream_agent_document(
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    creation_model=creation_model,
                    creation_api_key=creation_api_key,
                    creation_base_url=creation_base_url,
                ):
                    document_parts.append(chunk)
                    yield self._event(
                        state,
                        "document.patch.delta" if is_revision else "document.delta",
                        (
                            "文档撰写 Agent 正在联动修订全文"
                            if is_revision
                            else "文档撰写 Agent 正在更新文档"
                        ),
                        actor=actor,
                        data={"content": chunk},
                    )
                result = "".join(document_parts)
            else:
                result = await self.service.run_specialist_agent(
                    agent_id=step["id"],
                    system_prompt=system_prompt,
                    user_prompt=user_prompt,
                    creation_model=creation_model,
                    creation_api_key=creation_api_key,
                    creation_base_url=creation_base_url,
                )
            async for event in self._complete_model_step(state, step, result):
                yield event
            return

        if action == "review":
            document = str(state.environment.get("document") or "")
            headings = sum(1 for line in document.splitlines() if line.lstrip().startswith("#"))
            criteria = {
                "has_document": len(document.strip()) >= 180,
                "has_structure": headings >= 3,
                "addresses_goal": bool(state.user_message.strip()),
            }
            if state.mode == "revision":
                base_document = str(
                    state.environment.get("revision_base_document")
                    or state.current_document
                )
                intent = state.environment.get("edit_intent", {})
                criteria.update(
                    {
                        "revision_changed": self._document_hash(base_document)
                        != self._document_hash(document),
                        "preserves_structure": (
                            not bool(intent.get("preserve_untouched", True))
                            or self._revision_preserves_structure(
                                base_document,
                                document,
                            )
                        ),
                        "target_position_logical": self._target_positions_are_logical(
                            document,
                            [
                                str(item)
                                for item in intent.get("target_sections", [])
                            ],
                            allow_missing=any(
                                marker in state.user_message
                                for marker in DELETE_MARKERS
                            ),
                        ),
                    }
                )
            passed = all(criteria.values())
            hard_checks = {
                "has_document",
                "has_structure",
                "revision_changed",
            }
            hard_failures = [
                key
                for key, value in criteria.items()
                if key in hard_checks and not value
            ]
            soft_warnings = [
                key
                for key, value in criteria.items()
                if key not in hard_checks and not value
            ]
            state.environment["quality_review"] = criteria
            state.environment["quality_hard_failures"] = hard_failures
            state.environment["quality_soft_warnings"] = soft_warnings
            if hard_failures and state.writer_revisions < 1:
                state.writer_revisions += 1
                insert_at = state.cursor
                state.plan[insert_at:insert_at] = [
                    {
                        "kind": "agent",
                        "id": "document_writer_agent",
                        "name": "文档撰写 Agent",
                        "action": "writer",
                    },
                    {
                        "kind": "agent",
                        "id": "quality_review_agent",
                        "name": "质量审校 Agent",
                        "action": "review",
                    },
                ]
                summary = "质量检查发现内容或结构不完整，已把修订步骤写回目标"
            elif hard_failures:
                summary = "已完成最大修订次数，文档仍存在完整性问题"
            elif soft_warnings:
                summary = "质量检查完成，已记录待核验项；保留当前完整版本"
            else:
                summary = "质量检查通过" if passed else "质量检查完成"
            self._update_goal(state)
            yield self._event(
                state,
                "agent.completed",
                summary,
                status="completed",
                actor=actor,
                environment_patch={"quality_review": criteria},
            )

    async def _apply_model_result(
        self, state: LoopState, model_result: str
    ) -> AsyncIterator[dict[str, Any]]:
        pending = state.pending_model_step or {}
        step = pending.get("step")
        state.pending_model_step = None
        if not step:
            return
        async for event in self._complete_model_step(state, step, model_result):
            yield event

    async def _complete_model_step(
        self, state: LoopState, step: dict[str, Any], result: str
    ) -> AsyncIterator[dict[str, Any]]:
        actor = self._actor("agent", step["id"], step["name"])
        cleaned = result.strip()
        if step["action"] == "writer":
            intent = state.environment.get("edit_intent", {})
            operation = str(intent.get("operation") or "")
            if state.mode == "revision":
                if not cleaned:
                    raise RuntimeError("文档撰写 Agent 未返回修订后的完整文档")
                base_document = str(
                    state.environment.get("revision_base_document")
                    or state.current_document
                )
                document_patch = self._build_document_revision_patch(
                    base_document,
                    cleaned,
                    operation=operation or "revise_document",
                    requested_sections=[
                        str(item) for item in intent.get("target_sections", [])
                    ],
                    preserved_untouched=bool(
                        intent.get("preserve_untouched", True)
                    ),
                )
                state.environment["document"] = cleaned
                state.environment["last_document_patch"] = document_patch
                state.current_document = cleaned
                patch = {
                    "document_length": len(cleaned),
                    "document_patch": document_patch,
                }
                yield self._event(
                    state,
                    "document.patch.applied",
                    str(document_patch["summary"]),
                    status="completed",
                    actor=actor,
                    environment_patch={"document_patch": document_patch},
                    data={"content": cleaned, "patch": document_patch},
                )
            elif operation in {
                "append_section",
                "replace_section",
                "delete_section",
            }:
                updated, document_patch = self._apply_document_patch(
                    state.current_document,
                    cleaned,
                    operation=operation,
                    target_sections=[
                        str(item) for item in intent.get("target_sections", [])
                    ],
                )
                state.environment["document"] = updated
                state.environment["last_document_patch"] = document_patch
                state.current_document = updated
                patch = {
                    "document_length": len(updated),
                    "document_patch": document_patch,
                }
                yield self._event(
                    state,
                    "document.patch.applied",
                    str(document_patch["summary"]),
                    status="completed",
                    actor=actor,
                    environment_patch={"document_patch": document_patch},
                    data={"content": updated, "patch": document_patch},
                )
            else:
                if not cleaned:
                    raise RuntimeError("文档撰写 Agent 未返回文档内容")
                state.environment["document"] = cleaned
                state.current_document = cleaned
                patch = {
                    "document_length": len(cleaned),
                    "operation": operation or "rewrite_document",
                }
                yield self._event(
                    state,
                    "document.replaced",
                    "文档撰写 Agent 已提交完整文档版本",
                    status="completed",
                    actor=actor,
                    data={
                        "content": cleaned,
                        "operation": operation or "rewrite_document",
                    },
                )
        else:
            output_key = step.get("output_key") or step["id"]
            state.environment[output_key] = cleaned
            patch = {output_key: self.service._clip(cleaned, 600)}
        self._update_goal(state)
        yield self._event(
            state,
            "agent.completed",
            f"{step['name']} 已完成，并把结果写回创作环境",
            status="completed",
            actor=actor,
            environment_patch=patch,
        )

    def _apply_document_patch(
        self,
        document: str,
        generated_fragment: str,
        *,
        operation: str,
        target_sections: list[str],
    ) -> tuple[str, dict[str, Any]]:
        target = (target_sections[0] if target_sections else "").strip()
        if not document.strip():
            raise RuntimeError("局部修订缺少现有文档")
        if not target:
            raise RuntimeError("局部修订缺少目标章节")

        before_hash = self._document_hash(document)
        spans = self._markdown_section_spans(document)
        matched = self._find_section_span(target, spans)
        effective_operation = operation

        if operation == "delete_section":
            if not matched:
                raise RuntimeError(f"未在现有文档中找到要删除的“{target}”章节")
            updated = self._replace_span(document, matched["start"], matched["end"], "")
        else:
            fragment = self._extract_target_fragment(generated_fragment, target)
            if not fragment:
                raise RuntimeError(f"文档撰写 Agent 未返回“{target}”章节内容")
            if matched:
                effective_operation = "replace_section"
                updated = self._replace_span(
                    document,
                    matched["start"],
                    matched["end"],
                    fragment,
                )
            else:
                effective_operation = "append_section"
                updated = self._insert_section(document, fragment, spans)

        updated = updated.strip() + "\n"
        after_hash = self._document_hash(updated)
        if before_hash == after_hash:
            raise RuntimeError(f"“{target}”章节局部修订没有产生有效变更")

        action_label = {
            "append_section": "新增",
            "replace_section": "更新",
            "delete_section": "删除",
        }.get(effective_operation, "修改")
        patch = {
            "operation": effective_operation,
            "target_sections": [target],
            "base_hash": before_hash,
            "result_hash": after_hash,
            "preserved_untouched": True,
            "summary": f"已局部{action_label}“{target}”章节，其余内容保持不变",
        }
        return updated, patch

    @staticmethod
    def _document_hash(document: str) -> str:
        return hashlib.sha256(document.encode("utf-8")).hexdigest()[:16]

    def _build_document_revision_patch(
        self,
        base_document: str,
        updated_document: str,
        *,
        operation: str,
        requested_sections: list[str],
        preserved_untouched: bool,
    ) -> dict[str, Any]:
        changes = self._document_changes(base_document, updated_document)
        changed_sections: list[str] = []
        for change in changes:
            section = str(change.get("section_title") or "").strip()
            if section and section not in changed_sections:
                changed_sections.append(section)
        change_count = len(changes)
        section_preview = "、".join(changed_sections[:4])
        if change_count:
            summary = f"已按本轮指令完成 {change_count} 处调整"
            if section_preview:
                summary += f"，涉及{section_preview}"
        else:
            summary = "本轮修订未检测到正文差异"
        return {
            "operation": operation or "revise_document",
            "target_sections": changed_sections,
            "requested_sections": self._dedupe_strings(requested_sections),
            "changes": changes,
            "change_count": change_count,
            "base_hash": self._document_hash(base_document),
            "result_hash": self._document_hash(updated_document),
            "preserved_untouched": preserved_untouched,
            "summary": summary,
        }

    @classmethod
    def _document_changes(
        cls,
        base_document: str,
        updated_document: str,
    ) -> list[dict[str, Any]]:
        before_lines = base_document.splitlines()
        after_lines = updated_document.splitlines()
        before_sections = cls._line_section_titles(before_lines)
        after_sections = cls._line_section_titles(after_lines)
        before_section_names = {
            cls._normalize_section_name(section) for section in before_sections
        }
        after_section_names = {
            cls._normalize_section_name(section) for section in after_sections
        }
        matcher = SequenceMatcher(
            None,
            before_lines,
            after_lines,
            autojunk=False,
        )
        changes: list[dict[str, Any]] = []
        for tag, old_start, old_end, new_start, new_end in matcher.get_opcodes():
            if tag == "equal":
                continue
            if new_start < new_end:
                for segment in cls._segment_line_range(
                    after_sections,
                    new_start,
                    new_end,
                ):
                    section_title = str(segment["section_title"])
                    change_type = (
                        "added"
                        if tag == "insert"
                        or cls._normalize_section_name(section_title)
                        not in before_section_names
                        else "modified"
                    )
                    changes.append(
                        {
                            "change_type": change_type,
                            "section_title": section_title,
                            "start_line": segment["start_line"],
                            "end_line": segment["end_line"],
                            "summary": cls._change_summary(
                                change_type,
                                str(segment["section_title"]),
                            ),
                        }
                    )
            if old_start < old_end and (
                new_start == new_end or tag == "replace"
            ):
                for segment in cls._segment_line_range(
                    before_sections,
                    old_start,
                    old_end,
                ):
                    section_title = str(segment["section_title"])
                    if (
                        tag == "replace"
                        and cls._normalize_section_name(section_title)
                        in after_section_names
                    ):
                        continue
                    changes.append(
                        {
                            "change_type": "deleted",
                            "section_title": section_title,
                            "start_line": None,
                            "end_line": None,
                            "base_start_line": segment["start_line"],
                            "base_end_line": segment["end_line"],
                            "summary": cls._change_summary(
                                "deleted",
                                str(segment["section_title"]),
                            ),
                        }
                    )
        return cls._merge_adjacent_changes(changes)

    @staticmethod
    def _line_section_titles(lines: list[str]) -> list[str]:
        current = "标题与导语"
        result: list[str] = []
        for line in lines:
            match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
            if match and len(match.group(1)) == 2:
                current = re.sub(r"\s+#+\s*$", "", match.group(2)).strip()
            result.append(current)
        return result

    @staticmethod
    def _segment_line_range(
        section_titles: list[str],
        start: int,
        end: int,
    ) -> list[dict[str, Any]]:
        if start >= end:
            return []
        segments: list[dict[str, Any]] = []
        segment_start = start
        current = section_titles[start] if start < len(section_titles) else "标题与导语"
        for index in range(start + 1, end):
            section = (
                section_titles[index]
                if index < len(section_titles)
                else current
            )
            if section == current:
                continue
            segments.append(
                {
                    "section_title": current,
                    "start_line": segment_start + 1,
                    "end_line": index,
                }
            )
            current = section
            segment_start = index
        segments.append(
            {
                "section_title": current,
                "start_line": segment_start + 1,
                "end_line": end,
            }
        )
        return segments

    @classmethod
    def _merge_adjacent_changes(
        cls,
        changes: list[dict[str, Any]],
    ) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        for change in changes:
            previous = merged[-1] if merged else None
            if (
                previous
                and previous["change_type"] == change["change_type"]
                and previous["section_title"] == change["section_title"]
                and isinstance(previous.get("end_line"), int)
                and isinstance(change.get("start_line"), int)
                and int(change["start_line"]) <= int(previous["end_line"]) + 1
            ):
                previous["end_line"] = change["end_line"]
                continue
            merged.append(dict(change))
        return merged

    @staticmethod
    def _change_summary(change_type: str, section_title: str) -> str:
        action = {
            "added": "新增",
            "modified": "修改",
            "deleted": "删除",
        }.get(change_type, "调整")
        return f"{action}“{section_title}”中的内容"

    @staticmethod
    def _dedupe_strings(values: list[str]) -> list[str]:
        result: list[str] = []
        for value in values:
            text = value.strip()
            if text and text not in result:
                result.append(text)
        return result

    @classmethod
    def _revision_preserves_structure(
        cls,
        base_document: str,
        updated_document: str,
    ) -> bool:
        before = {
            cls._normalize_section_name(title)
            for title in cls._markdown_section_titles(base_document)
        }
        after = {
            cls._normalize_section_name(title)
            for title in cls._markdown_section_titles(updated_document)
        }
        if not before:
            return True
        return len(before & after) / len(before) >= 0.65

    @classmethod
    def _target_positions_are_logical(
        cls,
        document: str,
        target_sections: list[str],
        *,
        allow_missing: bool = False,
    ) -> bool:
        headings = [
            str(span["title"])
            for span in cls._markdown_section_spans(document)
            if int(span["level"]) == 2
        ]
        for target in target_sections:
            target_rank = cls._section_order_rank(target)
            if target_rank is None:
                continue
            matched = cls._match_existing_section(target, headings)
            if not matched:
                if allow_missing:
                    continue
                return False
            target_index = headings.index(matched)
            for index, heading in enumerate(headings):
                rank = cls._section_order_rank(heading)
                if rank is None or index == target_index:
                    continue
                if index < target_index and rank > target_rank:
                    return False
                if index > target_index and rank < target_rank:
                    return False
        return True

    @classmethod
    def _section_order_rank(cls, title: str) -> int | None:
        normalized = cls._normalize_section_name(title)
        for rank, markers in SECTION_ORDER_RULES:
            if any(
                cls._normalize_section_name(marker) in normalized
                for marker in markers
            ):
                return rank
        return None

    @classmethod
    def _markdown_section_spans(cls, document: str) -> list[dict[str, Any]]:
        matches = list(re.finditer(r"(?m)^(#{1,6})\s+(.+?)\s*$", document))
        spans: list[dict[str, Any]] = []
        for index, match in enumerate(matches):
            level = len(match.group(1))
            end = len(document)
            for following in matches[index + 1 :]:
                if len(following.group(1)) <= level:
                    end = following.start()
                    break
            spans.append(
                {
                    "title": re.sub(r"\s+#+\s*$", "", match.group(2)).strip(),
                    "level": level,
                    "start": match.start(),
                    "end": end,
                }
            )
        return spans

    @classmethod
    def _find_section_span(
        cls,
        target: str,
        spans: list[dict[str, Any]],
    ) -> dict[str, Any] | None:
        normalized_target = cls._normalize_section_name(target)
        exact = [
            span
            for span in spans
            if cls._normalize_section_name(str(span["title"])) == normalized_target
        ]
        if exact:
            return exact[0]
        fuzzy = [
            span
            for span in spans
            if normalized_target in cls._normalize_section_name(str(span["title"]))
            or cls._normalize_section_name(str(span["title"])) in normalized_target
        ]
        return fuzzy[0] if fuzzy else None

    @classmethod
    def _extract_target_fragment(cls, result: str, target: str) -> str:
        text = result.strip()
        if not text:
            return ""
        fenced = re.fullmatch(r"```(?:markdown|md)?\s*\n([\s\S]*?)\n```", text)
        if fenced:
            text = fenced.group(1).strip()

        spans = cls._markdown_section_spans(text)
        matched = cls._find_section_span(target, spans)
        if matched:
            fragment = text[matched["start"] : matched["end"]].strip()
            heading_match = re.match(r"^(#{1,6})\s+", fragment)
            if heading_match and len(heading_match.group(1)) == 1:
                fragment = re.sub(r"^#\s+", "## ", fragment, count=1)
            return fragment

        body = text
        if body.startswith("{") and body.endswith("}"):
            raise RuntimeError("局部修订返回了无法识别的结构化内容")
        return f"## {target}\n\n{body}".strip()

    @classmethod
    def _insert_section(
        cls,
        document: str,
        fragment: str,
        spans: list[dict[str, Any]],
    ) -> str:
        fragment_spans = cls._markdown_section_spans(fragment)
        target_heading = next(
            (
                str(span["title"])
                for span in fragment_spans
                if int(span["level"]) == 2
            ),
            "",
        )
        target_rank = cls._section_order_rank(target_heading)
        if target_rank is not None:
            for span in spans:
                if int(span["level"]) != 2:
                    continue
                existing_rank = cls._section_order_rank(str(span["title"]))
                if existing_rank is not None and existing_rank > target_rank:
                    insertion = int(span["start"])
                    return (
                        f"{document[:insertion].rstrip()}\n\n"
                        f"{fragment}\n\n"
                        f"{document[insertion:].lstrip()}"
                    )

        trailing_markers = (
            "实施计划",
            "风险",
            "验收",
            "后续核验",
            "参考资料",
            "结语",
            "总结",
        )
        insertion = None
        for span in spans:
            if span["level"] != 2:
                continue
            normalized = cls._normalize_section_name(str(span["title"]))
            if any(
                cls._normalize_section_name(marker) in normalized
                for marker in trailing_markers
            ):
                insertion = int(span["start"])
                break
        if insertion is None:
            return f"{document.rstrip()}\n\n{fragment}\n"
        return (
            f"{document[:insertion].rstrip()}\n\n"
            f"{fragment}\n\n"
            f"{document[insertion:].lstrip()}"
        )

    @staticmethod
    def _replace_span(document: str, start: int, end: int, replacement: str) -> str:
        before = document[:start].rstrip()
        after = document[end:].lstrip()
        parts = [part for part in (before, replacement.strip(), after) if part]
        return "\n\n".join(parts)

    def _model_prompts(
        self, state: LoopState, step: dict[str, Any]
    ) -> tuple[str, str]:
        environment = self._prompt_environment(state)
        agent_id = step["id"]
        if step["action"] == "writer":
            system = """你是 MemoryBread 的文档撰写 Agent。请依据目标、子 Agent 结论、Tool 证据和 Skill 规则，输出完整 Markdown 文档。
对于已安装的技能，优先复刻 title_design_style 中的子标题句式、writing_design 中的行文推进、voice_style 中的惯用话术和 image_generation 中的代码生图方式；field_examples 与 example_document 只用于学习写法，不得照抄主题或事实。不要把这些鲜明特征稀释成通用公文。
要求：保留可验证事实；不编造政策编号、指标或来源；对外部信息给出链接；环境包含 PlantUML 画图约束时必须输出对应的 ```plantuml 代码块，否则技术关系优先使用 Mermaid；只输出文档正文。"""
            if state.mode == "revision":
                intent = state.environment.get("edit_intent", {})
                targets = [str(item) for item in intent.get("target_sections", [])]
                target_hint = "、".join(targets) if targets else "由本轮要求推断的相关位置"
                system = f"""你是 MemoryBread 的文档修订 Agent。请基于现有完整文档输出修订后的完整 Markdown，不能只输出新增片段。
对于已安装的技能，优先复刻 title_design_style 中的子标题句式、writing_design 中的行文推进、voice_style 中的惯用话术和 image_generation 中的代码生图方式；field_examples 与 example_document 只用于学习写法，不得照抄主题或事实。
本轮已识别的改动线索：{target_hint}。这些只是线索，不是唯一可修改范围。
先判断新要求在全文中的合理位置和全部影响面，再执行修订：
1. 新内容必须放在语义与叙事顺序最合理的位置，不得机械追加到文末；
2. 若目录、摘要、章节编号、交叉引用、方案设计、实施计划、风险或验收条件受影响，必须联动更新；
3. 一轮可以新增、修改或删除多个章节；不要为了“局部更新”而忽略必要的跨章节修改；
4. 保留未受影响且仍有效的内容，避免无意义改写；
5. 本轮明确修改优先于冲突的原始约束，其余原始约束继续生效；
6. 保留可验证事实，不编造政策编号、指标或来源；外部结论保留链接。
只输出最终完整文档正文，不要输出 JSON 或修订说明；不要用代码围栏包裹整篇文档，但 Tool 要求的 PlantUML 或 Mermaid 图示代码块必须保留。"""
        else:
            role_instructions = {
                "data_analysis_agent": "识别可用数据、指标口径、证据缺口和可验证结论。禁止编造数字。输出给文档撰写 Agent 的精炼分析。",
                "industry_research_agent": "综合互联网检索结果，提炼行业现状、趋势、约束与待核验事实。每条外部结论保留来源 URL。",
                "solution_design_agent": "围绕目标、约束和证据设计可落地方案，明确边界、关键决策、组件关系、实施步骤、风险和验证方式。",
            }
            system = f"你是 MemoryBread 的{step['name']}。{role_instructions.get(agent_id, '完成当前专业分析。')}"
        workflow_context = ""
        if step.get("skill_step_id"):
            workflow_context = f"""【当前 Skill 执行步骤】
步骤：{step.get("skill_step_title", "")}
目标：{step.get("skill_step_objective", "")}
预期产出：{step.get("skill_step_output", "")}
可协同 Skill：{"、".join(step.get("skill_step_skills", [])) or "无"}

"""
        user = f"""{workflow_context}【目标】
{state.goal.objective}

【原始需求（基线；与本轮明确修改冲突时以本轮为准）】
{state.root_request}

【用户本轮要求】
{state.user_message}

【当前环境】
{environment}
"""
        return system, user

    @staticmethod
    def _step_context_query(state: LoopState, step: dict[str, Any]) -> str:
        context_query = str(
            state.environment.get("context_query") or state.user_message
        ).strip()
        objective = str(step.get("skill_step_objective") or "").strip()
        output = str(step.get("skill_step_output") or "").strip()
        skills = [
            str(item).strip()
            for item in step.get("skill_step_skills", [])
            if str(item).strip()
        ]
        if not objective and not output and not skills:
            return context_query
        return "\n".join(
            item
            for item in (
                context_query,
                f"当前 Skill 步骤目标：{objective}" if objective else "",
                f"需要支持的步骤产出：{output}" if output else "",
                f"本步骤协同 Skill：{'、'.join(skills)}" if skills else "",
            )
            if item
        )

    def _prompt_environment(self, state: LoopState) -> str:
        blocks = [
            f"原始需求：{state.root_request}",
            f"本轮编辑意图：{state.environment.get('edit_intent', {})}",
            f"任务画像：{state.environment.get('requirement', {})}",
            f"已应用 Skill：{state.environment.get('applied_skills', [])}",
            f"已激活的 Skill 步骤：{state.environment.get('completed_skill_steps', [])}",
            f"本地参考：{state.environment.get('references', [])}",
            f"互联网资料：{state.environment.get('web_results', [])}",
            f"GitHub 公开仓库：{state.environment.get('github_results', [])}",
            f"PlantUML 画图约束：{state.environment.get('plantuml_diagram', {})}",
            f"数据分析：{state.environment.get('data_analysis', '')}",
            f"行业调研：{state.environment.get('industry_research', '')}",
            f"方案设计：{state.environment.get('solution_design', '')}",
            f"上一轮质量审校：{state.environment.get('quality_review', {})}",
        ]
        if state.current_document:
            outline = "\n".join(
                f"{'#' * int(span['level'])} {span['title']}"
                for span in self._markdown_section_spans(state.current_document)
            )
            blocks.append(f"现有文档目录：\n{outline}")
            blocks.append(
                f"现有完整文档：\n{self.service._clip(state.current_document, 64000)}"
            )
        if state.conversation:
            blocks.append(f"关键对话：{self._conversation_for_prompt(state.conversation)}")
        return "\n\n".join(blocks)

    def _document_patch_context(
        self,
        document: str,
        target_sections: list[str],
    ) -> str:
        spans = self._markdown_section_spans(document)
        outline = "\n".join(
            f"{'#' * int(span['level'])} {span['title']}" for span in spans
        )
        target = target_sections[0] if target_sections else ""
        matched = self._find_section_span(target, spans) if target else None
        if matched:
            section = document[int(matched["start"]) : int(matched["end"])].strip()
            section_context = self.service._clip(section, 12000)
        else:
            first_h2 = next(
                (int(span["start"]) for span in spans if int(span["level"]) == 2),
                min(len(document), 3000),
            )
            preface = document[:first_h2].strip()
            section_context = (
                f"目标章节“{target}”当前不存在，需要新增。\n"
                f"文档标题和导语：\n{self.service._clip(preface, 3000)}"
            )
        return f"文档目录：\n{outline}\n\n目标章节上下文：\n{section_context}"

    def _reference_to_state(self, item: ReferenceDocument) -> dict[str, Any]:
        return {
            "id": item.id,
            "title": item.title,
            "doc_type": item.doc_type,
            "summary": self.service._clip(item.summary, 600),
            "content": self.service._clip(
                self.service._best_reference_content(item), 1600
            ),
            "reason": item.reason,
            "final_weight": round(item.final_weight, 4),
            "source_url": item.source_url,
        }

    def _needs_confirmation(self, state: LoopState) -> bool:
        compact = "".join(state.user_message.split())
        return state.mode == "initial" and len(compact) < 8

    def _update_goal(self, state: LoopState) -> None:
        state.goal.revision += 1
        state.goal.status = "active"
        state.goal.remaining_steps = [item["name"] for item in state.plan[state.cursor:]]

    def _event(
        self,
        state: LoopState,
        event_type: str,
        summary: str,
        *,
        status: str = "running",
        actor: dict[str, str] | None = None,
        environment_patch: dict[str, Any] | None = None,
        data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        state.sequence += 1
        return {
            "schema_version": SCHEMA_VERSION,
            "event_id": f"event-{uuid4()}",
            "session_id": state.session_id,
            "run_id": state.run_id,
            "sequence": state.sequence,
            "timestamp": int(time.time() * 1000),
            "type": event_type,
            "status": status,
            "actor": actor
            or self._actor("agent", "creation_main_agent", "创作 Agent"),
            "summary": summary,
            "goal": {
                "objective": state.goal.objective,
                "status": state.goal.status,
                "revision": state.goal.revision,
                "remaining_steps": state.goal.remaining_steps,
                "outcome": state.goal.outcome,
            },
            "environment_patch": environment_patch or {},
            "data": data or {},
        }

    @staticmethod
    def _actor(kind: str, actor_id: str, name: str) -> dict[str, str]:
        return {"kind": kind, "id": actor_id, "name": name}

    @staticmethod
    def _normalize_conversation(
        conversation: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        result: list[dict[str, str]] = []
        for item in conversation:
            role = str(item.get("role") or "")
            content = str(item.get("content") or "").strip()
            if role in {"user", "assistant"} and content:
                result.append({"role": role, "content": content[:12000]})
        if len(result) <= 40:
            return result
        # 根需求和最初约束永远保留；中间轮次可由当前文档承载，尾部保留近期修改。
        return [*result[:4], *result[-36:]]

    @staticmethod
    def _conversation_for_prompt(
        conversation: list[dict[str, str]]
    ) -> list[dict[str, str]]:
        if len(conversation) <= 16:
            return conversation
        return [*conversation[:4], *conversation[-12:]]
