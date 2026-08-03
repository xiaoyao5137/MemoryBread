"""目标驱动的创作 Agent Loop。

创作 Agent 只负责维护目标、环境和下一步计划。子 Agent、Tool、Skill 的每次
执行都会先产生可观察事件，再把结果写回环境，随后重新评估剩余步骤。
"""

from __future__ import annotations

import hashlib
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from difflib import SequenceMatcher
from typing import Any, Optional, Union, AsyncIterator
from uuid import uuid4

from .service import CreationOptions, CreationService, ReferenceDocument
from .tools import (
    CreationToolExecutionError,
    DATA_SEARCH_TOOL_ID,
    GITHUB_SEARCH_TOOL_ID,
    INTERNET_SEARCH_TOOL_ID,
    MEMORY_SEARCH_TOOL_ID,
    PLANTUML_DIAGRAM_TOOL_ID,
    WEBPAGE_SCRAPE_TOOL_ID,
    build_plantuml_context,
    normalize_creation_tool_ids,
    should_use_github_search,
    should_use_internet_search,
    should_use_data_tools,
    should_use_plantuml,
)

SCHEMA_VERSION = "creation.agent.v1"
MAX_LOOP_STEPS = 64
MAX_QUALITY_CYCLES = 3
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

QUALITY_AGENT_ORDER = (
    "document_writer_agent",
    "detail_polish_agent",
    "table_polish_agent",
    "image_polish_agent",
    "anti_ai_style_agent",
    "typography_polish_agent",
)
QUALITY_SKILL_CAPABILITY_FIELDS = {
    "skill:voice_style": ("voice_style", "guidelines"),
    "skill:structure": ("structure", "skill_description", "field_examples"),
    "skill:table_style": ("writing_design", "field_examples"),
    "skill:typography_style": ("title_design_style", "voice_style"),
    "skill:image_style": ("image_generation",),
}
AI_STYLE_BOILERPLATE = (
    "在当今",
    "随着时代的发展",
    "在这个快速发展的时代",
    "值得注意的是",
    "不难发现",
    "不可否认",
    "毋庸置疑",
    "综上所述",
    "总而言之",
    "由此可见",
    "这不仅",
    "更是",
    "赋能",
)
AI_STYLE_TRANSITIONS = (
    "首先",
    "其次",
    "再次",
    "此外",
    "同时",
    "最后",
    "一方面",
    "另一方面",
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
    quality_cycles: int = 0

    def serializable(self) -> dict[str, Any]:
        value = asdict(self)
        value["goal"] = asdict(self.goal)
        return value

    @classmethod
    def restore(cls, value: dict[str, Any]) -> "LoopState":
        data = dict(value)
        data.setdefault("root_request", data.get("user_message", ""))
        data.setdefault("quality_cycles", 0)
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
        root_request: Optional[str] = None,
        current_document: str,
        conversation: list[dict[str, str]],
        selected_skills: list[dict[str, Any]],
        options: CreationOptions,
        model_mode: str = "local",
        session_id: Optional[str] = None,
        run_id: Optional[str] = None,
        confirmed: bool = False,
        resume_state: dict[str, Any] | None = None,
        model_result: Optional[str] = None,
        creation_model: Optional[str] = None,
        creation_api_key: Optional[str] = None,
        creation_base_url: Optional[str] = None,
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
            completed_model_step = dict(state.pending_model_step.get("step") or {})
            async for event in self._apply_model_result(state, model_result):
                yield event
            decision = self._replan_after_feedback(
                state,
                completed_model_step,
                status="completed",
            )
            if decision:
                yield self._harness_decision_event(state, decision)
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
            step_status = "completed"
            error_code: Optional[str] = None
            try:
                async for event in self._execute_step(
                    state,
                    step,
                    creation_model=creation_model,
                    creation_api_key=creation_api_key,
                    creation_base_url=creation_base_url,
                ):
                    yield event
            except Exception as exc:
                if step.get("kind") != "tool":
                    raise
                tool_id = str(step.get("id") or "")
                error_code = (
                    exc.error_code
                    if isinstance(exc, CreationToolExecutionError)
                    else "TOOL_EXECUTION_FAILED"
                )
                state.environment.setdefault("tool_results", []).append(
                    {
                        "tool_id": tool_id,
                        "status": "failed",
                        "error_code": error_code,
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
                    data={"error_code": error_code},
                )
                step_status = "failed"
            if not state.pending_model_step:
                decision = self._replan_after_feedback(
                    state,
                    step,
                    status=step_status,
                    error_code=error_code,
                )
                if decision:
                    yield self._harness_decision_event(state, decision)
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
        document, applied_evidence = self._apply_creation_evidence_cards(
            str(state.environment.get("document") or state.current_document),
            [
                item
                for item in state.environment.get("creation_evidence", [])
                if isinstance(item, dict)
            ],
        )
        if applied_evidence:
            state.environment["document"] = document
            state.current_document = document
            state.environment["creation_evidence"] = applied_evidence
            yield self._event(
                state,
                "document.evidence.applied",
                f"已把 {len(applied_evidence)} 张校验通过的即时截图放到对应数据引用下方",
                status="completed",
                data={"content": document, "evidence": applied_evidence},
            )
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
                "evidence": state.environment.get("creation_evidence", []),
                "goal": asdict(state.goal),
            },
        )

    def _new_state(
        self,
        *,
        user_message: str,
        root_request: Optional[str],
        current_document: str,
        conversation: list[dict[str, str]],
        selected_skills: list[dict[str, Any]],
        options: CreationOptions,
        model_mode: str,
        session_id: Optional[str],
        run_id: Optional[str],
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
        root_request: Optional[str],
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
        use_data_tools = should_use_data_tools(text, requirement)
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

        if use_data_tools:
            # 数据检索与记忆/互联网检索同属证据探针。网页刷新和数据分析是
            # 依赖反馈的动作，不在初始计划中预置固定流水线。
            normalized_plan: list[dict[str, Any]] = []
            data_search_step: dict[str, Any] | None = None
            for item in plan:
                step_id = str(item.get("id") or "")
                if step_id in {WEBPAGE_SCRAPE_TOOL_ID, "data_analysis_agent"}:
                    continue
                if step_id == DATA_SEARCH_TOOL_ID:
                    if data_search_step is None:
                        data_search_step = item
                    continue
                normalized_plan.append(item)
            plan = normalized_plan
            insert_at = 1
            while (
                insert_at < len(plan)
                and plan[insert_at].get("kind") == "skill"
                and plan[insert_at].get("action") == "apply_skill"
            ):
                insert_at += 1
            memory_positions = [
                index
                for index, item in enumerate(plan)
                if str(item.get("id") or "") == MEMORY_SEARCH_TOOL_ID
            ]
            if memory_positions:
                insert_at = memory_positions[0] + 1
            plan.insert(
                insert_at,
                data_search_step or self._tool_plan_step(DATA_SEARCH_TOOL_ID),
            )

        scheduled_actions = {str(item.get("id")) for item in plan}
        if "document_writer_agent" not in scheduled_actions:
            plan.append(self._agent_plan_step("document_writer_agent"))
        if state.mode == "initial":
            # 章节设计是初稿的显式前置产物。即使 Skill 自带 Writer 步骤，
            # Harness 也会把统一的章节设计 Agent 放到首个 Writer 之前。
            plan = [
                item
                for item in plan
                if str(item.get("id") or "") != "chapter_design_agent"
            ]
            writer_index = next(
                index
                for index, item in enumerate(plan)
                if str(item.get("id") or "") == "document_writer_agent"
            )
            plan.insert(
                writer_index,
                self._agent_plan_step("chapter_design_agent"),
            )
        scheduled_actions = {str(item.get("id")) for item in plan}
        if "quality_review_agent" not in scheduled_actions:
            plan.append(self._agent_plan_step("quality_review_agent"))
        return plan

    def _replan_after_feedback(
        self,
        state: LoopState,
        step: dict[str, Any],
        *,
        status: str,
        error_code: Optional[str] = None,
    ) -> dict[str, Any] | None:
        """Harness 只依据可观察 Tool 反馈追加下一步，不预演固定链路。"""
        step_id = str(step.get("id") or "")
        step_key = self._step_schedule_key(step)
        completed_ids = state.environment.setdefault("harness_completed_step_ids", [])
        if status == "completed" and step_key and step_key not in completed_ids:
            completed_ids.append(step_key)
        if step_id == "quality_review_agent":
            return self._replan_quality_issues(state, status=status)
        if step_id not in {DATA_SEARCH_TOOL_ID, WEBPAGE_SCRAPE_TOOL_ID}:
            return None

        results = [
            item
            for item in state.environment.get("data_results", [])
            if isinstance(item, dict)
        ]
        refreshable_count = sum(
            1
            for item in results
            if item.get("source_kind") == "report_url"
            and item.get("source_url")
        )
        analyzable_count = sum(1 for item in results if self._has_analyzable_data(item))
        scheduled_steps: list[dict[str, Any]] = []
        reason_code: str

        if step_id == DATA_SEARCH_TOOL_ID:
            if status != "completed":
                reason_code = "data_search_failed"
            elif refreshable_count > 0:
                scheduled_steps.append(self._tool_plan_step(WEBPAGE_SCRAPE_TOOL_ID))
                reason_code = "refresh_required"
            elif analyzable_count > 0:
                scheduled_steps.append(self._agent_plan_step("data_analysis_agent"))
                reason_code = "snapshot_ready"
            elif results:
                reason_code = "source_metadata_only"
            else:
                reason_code = "no_matching_data"
        elif analyzable_count > 0:
            scheduled_steps.append(self._agent_plan_step("data_analysis_agent"))
            reason_code = (
                "refresh_failed_stale_snapshot_available"
                if status != "completed"
                else "refresh_feedback_ready"
            )
        else:
            reason_code = (
                "refresh_failed_without_snapshot"
                if status != "completed"
                else "refresh_returned_no_analyzable_data"
            )

        inserted = self._insert_harness_steps(state, scheduled_steps)
        decision = {
            "trigger": step_id,
            "trigger_status": status,
            "reason_code": reason_code,
            "result_count": len(results),
            "refreshable_count": refreshable_count,
            "analyzable_count": analyzable_count,
            "scheduled": [item["id"] for item in inserted],
            "error_code": error_code,
        }
        state.environment.setdefault("harness_decisions", []).append(decision)
        self._update_goal(state)
        return decision

    def _replan_quality_issues(
        self,
        state: LoopState,
        *,
        status: str,
    ) -> dict[str, Any]:
        issues = [
            item
            for item in state.environment.get("quality_issues", [])
            if isinstance(item, dict)
        ]
        if status != "completed":
            reason_code = "quality_review_failed"
            candidates: list[dict[str, Any] | None] = []
        elif not issues:
            reason_code = "quality_gate_passed"
            candidates = []
        elif state.quality_cycles >= MAX_QUALITY_CYCLES:
            reason_code = "quality_cycle_budget_exhausted"
            candidates = []
        else:
            state.quality_cycles += 1
            cycle = state.quality_cycles
            state.environment["quality_cycle"] = cycle
            candidates = []
            reason_code = "quality_issues_detected"
            hard_issues = [item for item in issues if item.get("severity") == "hard"]
            if hard_issues:
                if state.writer_revisions < 1:
                    state.writer_revisions += 1
                    candidates.append(
                        self._quality_cycle_step("document_writer_agent", cycle)
                    )
                else:
                    reason_code = "hard_failure_retry_exhausted"
            else:
                enabled_tools = set(
                    normalize_creation_tool_ids(state.options.get("enabled_tools"))
                )
                requested_agents = {
                    str(item.get("agent_id") or "") for item in issues
                }
                required_capabilities = {
                    str(capability)
                    for item in issues
                    for capability in item.get("required_capabilities", [])
                    if str(capability)
                }
                if (
                    DATA_SEARCH_TOOL_ID in required_capabilities
                    and not state.environment.get("data_results")
                ):
                    candidates.append(self._tool_plan_step(DATA_SEARCH_TOOL_ID))
                if (
                    "data_analysis_agent" in required_capabilities
                    and not state.environment.get("data_analysis")
                    and state.environment.get("data_results")
                ):
                    candidates.append(
                        self._quality_cycle_step("data_analysis_agent", cycle)
                    )
                if (
                    PLANTUML_DIAGRAM_TOOL_ID in required_capabilities
                    and PLANTUML_DIAGRAM_TOOL_ID in enabled_tools
                    and not state.environment.get("plantuml_diagram")
                ):
                    candidates.append(self._tool_plan_step(PLANTUML_DIAGRAM_TOOL_ID))
                candidates.extend(self._quality_skill_steps(state, issues, cycle))
                for agent_id in QUALITY_AGENT_ORDER:
                    if agent_id not in requested_agents:
                        continue
                    candidates.append(self._quality_cycle_step(agent_id, cycle))
            if candidates:
                review = self._quality_cycle_step("quality_review_agent", cycle)
                if review:
                    candidates.append(review)

        inserted = self._insert_harness_steps(state, candidates)
        activated_skills = [
            str(item.get("skill_id") or "")
            for item in inserted
            if item.get("kind") == "skill"
        ]
        decision = {
            "trigger": "quality_review_agent",
            "trigger_status": status,
            "reason_code": reason_code,
            "quality_cycle": state.quality_cycles,
            "issue_count": len(issues),
            "issue_codes": [str(item.get("code") or "") for item in issues],
            "scheduled": [
                str(item.get("id") or "")
                for item in inserted
                if item.get("kind") != "skill"
            ],
            "activated_skills": activated_skills,
            "error_code": None,
        }
        state.environment.setdefault("harness_decisions", []).append(decision)
        self._update_goal(state)
        return decision

    def _quality_skill_steps(
        self,
        state: LoopState,
        issues: list[dict[str, Any]],
        cycle: int,
    ) -> list[dict[str, Any]]:
        """把质检声明的 Skill 能力解析成受控、可观察的上下文激活步骤。"""
        requested = {
            str(capability)
            for issue in issues
            for capability in issue.get("required_capabilities", [])
            if str(capability).startswith("skill:")
        }
        if not requested:
            return []

        remaining = set(requested)
        steps: list[dict[str, Any]] = []
        for skill in state.environment.get("applied_skills", []):
            if not isinstance(skill, dict):
                continue
            matched = [
                capability
                for capability in sorted(remaining)
                if any(
                    bool(skill.get(field))
                    for field in QUALITY_SKILL_CAPABILITY_FIELDS.get(capability, ())
                )
            ]
            if not matched:
                continue
            skill_id = str(skill.get("id") or "")
            if not skill_id:
                continue
            issue_codes = [
                str(issue.get("code") or "")
                for issue in issues
                if any(
                    str(capability) in matched
                    for capability in issue.get("required_capabilities", [])
                )
            ]
            steps.append(
                {
                    "kind": "skill",
                    "id": f"skill:{skill_id}",
                    "skill_id": skill_id,
                    "name": f"{skill.get('name') or skill_id} · 质检复用",
                    "action": "activate_quality_skill",
                    "skill": skill,
                    "quality_cycle": cycle,
                    "quality_issue_codes": issue_codes,
                    "matched_capabilities": matched,
                    "schedule_key": f"skill:{skill_id}:quality:{cycle}",
                }
            )
            remaining.difference_update(matched)
            if not remaining or len(steps) >= 2:
                break
        return steps

    def _quality_cycle_step(
        self,
        agent_id: str,
        cycle: int,
    ) -> dict[str, Any] | None:
        step = self._agent_plan_step(agent_id)
        if not step:
            return None
        return {
            **step,
            "quality_cycle": cycle,
            "schedule_key": f"{agent_id}:quality:{cycle}",
        }

    @staticmethod
    def _has_analyzable_data(item: dict[str, Any]) -> bool:
        if item.get("source_kind") == "report_url":
            evidence = item.get("creation_evidence")
            if not isinstance(evidence, dict) or evidence.get("validation_status") != "verified":
                return False
            if item.get("can_use") is not True:
                return False
        return bool(item.get("content_excerpt")) or item.get("structured_data") is not None

    @staticmethod
    def _step_schedule_key(step: dict[str, Any]) -> str:
        return str(step.get("schedule_key") or step.get("id") or "")

    @staticmethod
    def _insert_harness_steps(
        state: LoopState,
        candidates: list[dict[str, Any] | None],
    ) -> list[dict[str, Any]]:
        completed = set(state.environment.get("harness_completed_step_ids", []))
        future_ids = {
            CreationAgentLoop._step_schedule_key(item)
            for item in state.plan[state.cursor :]
        }
        inserted: list[dict[str, Any]] = []
        for candidate in candidates:
            if not candidate:
                continue
            step_id = CreationAgentLoop._step_schedule_key(candidate)
            if step_id in completed or step_id in future_ids:
                continue
            inserted.append(candidate)
            future_ids.add(step_id)
        if inserted:
            state.plan[state.cursor : state.cursor] = inserted
        return inserted

    def _harness_decision_event(
        self,
        state: LoopState,
        decision: dict[str, Any],
    ) -> dict[str, Any]:
        scheduled = decision.get("scheduled") or []
        activated_skills = decision.get("activated_skills") or []
        if scheduled or activated_skills:
            additions = [*activated_skills, *scheduled]
            summary = f"已根据反馈补充 {len(additions)} 项后续处理"
        elif decision.get("reason_code") == "quality_gate_passed":
            summary = "质量检查通过"
        elif decision.get("reason_code") == "quality_cycle_budget_exhausted":
            summary = "已达到自动优化上限，剩余问题需要人工复核"
        else:
            summary = "已根据反馈保留当前处理计划"
        return self._event(
            state,
            "harness.decision",
            summary,
            status="completed",
            actor=self._actor("agent", "creation_main_agent", "创作 Agent"),
            environment_patch={"harness_decision": decision},
            data=decision,
        )

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
            DATA_SEARCH_TOOL_ID: ("数据检索 Tool", DATA_SEARCH_TOOL_ID),
            WEBPAGE_SCRAPE_TOOL_ID: ("网页爬取 Tool", WEBPAGE_SCRAPE_TOOL_ID),
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
            "chapter_design_agent": (
                "章节设计 Agent",
                "specialist",
                "chapter_design",
            ),
            "document_writer_agent": ("文档撰写 Agent", "writer", None),
            "anti_ai_style_agent": (
                "去 AI 味 Agent",
                "polisher",
                None,
            ),
            "detail_polish_agent": (
                "细节润色 Agent",
                "polisher",
                None,
            ),
            "table_polish_agent": (
                "表格润色 Agent",
                "polisher",
                None,
            ),
            "typography_polish_agent": (
                "字体润色 Agent",
                "polisher",
                None,
            ),
            "image_polish_agent": (
                "图片润色 Agent",
                "polisher",
                None,
            ),
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
        creation_model: Optional[str],
        creation_api_key: Optional[str],
        creation_base_url: Optional[str],
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

        if action == DATA_SEARCH_TOOL_ID:
            results = await self.service.retrieve_data_context(
                self._step_context_query(state, step),
                state.environment["requirement"],
            )
            self._enforce_report_evidence_policy(results)
            state.environment["data_results"] = results
            self._apply_data_freshness_to_references(state, results)
            refresh_count = sum(
                1 for item in results if item.get("refresh_required") is True
            )
            state.environment.setdefault("tool_results", []).append(
                {
                    "tool_id": DATA_SEARCH_TOOL_ID,
                    "status": "completed",
                    "result_count": len(results),
                    "refresh_required_count": refresh_count,
                }
            )
            self._update_goal(state)
            yield self._event(
                state,
                "tool.completed",
                f"数据检索完成，召回 {len(results)} 个来源，其中 {refresh_count} 个需要刷新",
                status="completed",
                actor=actor,
                environment_patch={
                    "data_sources": [
                        {
                            "source_id": item.get("source_id"),
                            "title": item.get("title"),
                            "source_kind": item.get("source_kind"),
                            "freshness_class": item.get("freshness_class"),
                            "refresh_required": item.get("refresh_required"),
                            "can_use": item.get("can_use"),
                        }
                        for item in results
                    ]
                },
                data={
                    "result_count": len(results),
                    "refresh_required_count": refresh_count,
                },
            )
            return

        if action == WEBPAGE_SCRAPE_TOOL_ID:
            outcome = await self.service.scrape_data_context(
                list(state.environment.get("data_results") or []),
                self._step_context_query(state, step),
                state.environment["requirement"],
                run_id=state.run_id,
                session_id=state.session_id,
            )
            scrapes = list(outcome.get("scrapes") or [])
            refreshed = list(outcome.get("refreshed_data") or [])
            self._enforce_report_evidence_policy(refreshed)
            state.environment["webpage_scrapes"] = scrapes
            state.environment["data_results"] = refreshed
            state.environment["creation_evidence"] = [
                item["evidence"]
                for item in scrapes
                if item.get("status") == "completed"
                and isinstance(item.get("evidence"), dict)
                and item["evidence"].get("validation_status") == "verified"
            ]
            self._apply_data_freshness_to_references(state, refreshed)
            completed_count = sum(
                1 for item in scrapes if item.get("status") == "completed"
            )
            failed_count = sum(
                1 for item in scrapes if item.get("status") in {"failed", "rejected"}
            )
            state.environment.setdefault("tool_results", []).append(
                {
                    "tool_id": WEBPAGE_SCRAPE_TOOL_ID,
                    "status": "completed",
                    "result_count": completed_count,
                    "failed_count": failed_count,
                }
            )
            self._update_goal(state)
            yield self._event(
                state,
                "tool.completed",
                (
                    f"网页数据刷新完成，更新 {completed_count} 个报表来源"
                    if scrapes
                    else "没有可实时刷新的报表 URL，保留工作记忆数据与采集时间"
                ),
                status="completed",
                actor=actor,
                environment_patch={
                    "scraped_source_count": completed_count,
                    "failed_source_count": failed_count,
                },
                data={
                    "result_count": completed_count,
                    "failed_count": failed_count,
                },
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

        if action == "activate_quality_skill":
            skill = step.get("skill") or {}
            activation = {
                "skill_id": step.get("skill_id"),
                "name": skill.get("name") or step.get("name"),
                "quality_cycle": step.get("quality_cycle"),
                "issue_codes": step.get("quality_issue_codes", []),
                "capabilities": step.get("matched_capabilities", []),
                "structure": skill.get("structure", []),
                "voice_style": skill.get("voice_style") or skill.get("guidelines", []),
                "writing_design": skill.get("writing_design", ""),
                "image_generation": skill.get("image_generation", ""),
                "field_examples": skill.get("field_examples", {}),
            }
            state.environment.setdefault("activated_quality_skills", []).append(
                activation
            )
            self._update_goal(state)
            yield self._event(
                state,
                "skill.completed",
                f"已按质检问题激活 {activation['name']} 的相关规则",
                status="completed",
                actor=actor,
                environment_patch={"quality_skill_activation": activation},
                data={
                    "quality_cycle": activation["quality_cycle"],
                    "issue_codes": activation["issue_codes"],
                    "capabilities": activation["capabilities"],
                },
            )
            return

        if action in {"specialist", "writer", "polisher"}:
            intent = state.environment.get("edit_intent", {})
            is_revision = action == "writer" and state.mode == "revision"
            is_document_mutation = action in {"writer", "polisher"}
            if is_revision or action == "polisher":
                targets = [str(item) for item in intent.get("target_sections", [])]
                yield self._event(
                    state,
                    "document.patch.planned",
                    (
                        f"{step['name']}将以{'、'.join(targets)}为线索检查全文联动"
                        if targets
                        else f"{step['name']}将根据质检问题检查完整文档"
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

            if is_document_mutation:
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
                        (
                            "document.patch.delta"
                            if is_revision or action == "polisher"
                            else "document.delta"
                        ),
                        (
                            f"{step['name']}正在联动修订全文"
                            if is_revision or action == "polisher"
                            else f"{step['name']}正在更新文档"
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
            criteria, issues = self._inspect_document_quality(state, document)
            report = {
                **criteria,
                "passed": not issues and all(criteria.values()),
                "cycle": state.quality_cycles,
                "issues": issues,
            }
            hard_failures = [
                str(item.get("code") or "")
                for item in issues
                if item.get("severity") == "hard"
            ]
            soft_warnings = [
                str(item.get("code") or "")
                for item in issues
                if item.get("severity") != "hard"
            ]
            soft_warnings.extend(
                key
                for key, value in criteria.items()
                if key not in {"has_document", "has_structure", "revision_changed"}
                and not value
                and key not in soft_warnings
            )
            state.environment["quality_review"] = report
            state.environment["quality_issues"] = issues
            state.environment["quality_hard_failures"] = hard_failures
            state.environment["quality_soft_warnings"] = soft_warnings
            summary = (
                f"质检发现 {len(issues)} 个可执行问题，正在安排后续优化"
                if issues
                else (
                    "质量检查完成，已记录非阻断警告；保留当前完整版本"
                    if soft_warnings
                    else "质量检查通过"
                )
            )
            self._update_goal(state)
            yield self._event(
                state,
                "agent.completed",
                summary,
                status="completed",
                actor=actor,
                environment_patch={"quality_review": report},
                data={
                    "issue_count": len(issues),
                    "issue_codes": [
                        str(item.get("code") or "") for item in issues
                    ],
                    "quality_cycle": state.quality_cycles,
                },
            )

    def _inspect_document_quality(
        self,
        state: LoopState,
        document: str,
    ) -> tuple[dict[str, bool], list[dict[str, Any]]]:
        """把主观质检拆成可观察指标和可路由的问题。"""
        headings = sum(
            1
            for line in document.splitlines()
            if re.match(r"^#{1,6}\s+\S", line.lstrip())
        )
        criteria: dict[str, bool] = {
            "has_document": len(document.strip()) >= 180,
            "has_structure": headings >= 3,
            "addresses_goal": bool(state.user_message.strip()),
        }
        issues: list[dict[str, Any]] = []

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

        hard_checks = {
            "has_document": "文档正文不足，不能形成可交付版本",
            "has_structure": "文档缺少可导航的章节结构",
            "revision_changed": "修订结果与原文没有可观察差异",
        }
        for code, summary in hard_checks.items():
            if code in criteria and not criteria[code]:
                issues.append(
                    self._quality_issue(
                        code=code,
                        severity="hard",
                        agent_id="document_writer_agent",
                        summary=summary,
                    )
                )

        prose = self._prose_for_quality(document)
        ai_style_signals = self._ai_style_signals(prose)
        criteria["natural_expression"] = not ai_style_signals
        if ai_style_signals:
            issues.append(
                self._quality_issue(
                    code="ai_style_signals",
                    severity="soft",
                    agent_id="anti_ai_style_agent",
                    summary="表达存在模板词、机械衔接、装饰性引号或长句堆叠",
                    evidence=ai_style_signals,
                    required_capabilities=["skill:voice_style"],
                )
            )

        short_sections = self._short_detail_sections(document)
        placeholder_count = len(
            re.findall(r"(?i)\b(?: Union[TODO, TBD])\b|待补充|此处补充|后续完善", prose)
        )
        detail_incomplete = (
            len(document.strip()) >= 500
            and (bool(short_sections) or placeholder_count > 0)
        )
        criteria["detail_complete"] = not detail_incomplete
        if detail_incomplete:
            required_capabilities: list[str] = ["skill:structure"]
            context = str(state.environment.get("context_query") or state.user_message)
            requirement = state.environment.get("requirement", {})
            if should_use_data_tools(context, requirement) and not state.environment.get(
                "data_analysis"
            ):
                if state.environment.get("data_results"):
                    if any(
                        self._has_analyzable_data(item)
                        for item in state.environment.get("data_results", [])
                        if isinstance(item, dict)
                    ):
                        required_capabilities.append("data_analysis_agent")
                else:
                    required_capabilities.append(DATA_SEARCH_TOOL_ID)
            issues.append(
                self._quality_issue(
                    code="detail_incomplete",
                    severity="soft",
                    agent_id="detail_polish_agent",
                    summary="部分章节只有观点或结论，缺少边界、动作、依据或例子",
                    evidence={
                        "short_sections": short_sections[:8],
                        "placeholder_count": placeholder_count,
                    },
                    required_capabilities=required_capabilities,
                )
            )

        context = "\n".join(
            (
                state.root_request,
                state.user_message,
                str(state.environment.get("requirement", {}).get("doc_type") or ""),
            )
        )
        has_table, malformed_tables = self._markdown_table_quality(document)
        table_expected = any(
            marker in context
            for marker in ("表格", "对比", "矩阵", "清单", "指标", "参数", "排期")
        )
        table_needs_polish = malformed_tables > 0 or (
            len(document.strip()) >= 500 and table_expected and not has_table
        )
        criteria["table_readable"] = not table_needs_polish
        if table_needs_polish:
            issues.append(
                self._quality_issue(
                    code="table_needs_polish",
                    severity="soft",
                    agent_id="table_polish_agent",
                    summary="需要补充或修复结构化表格，确保列口径和 Markdown 结构一致",
                    evidence={
                        "has_table": has_table,
                        "malformed_table_count": malformed_tables,
                    },
                    required_capabilities=["skill:table_style"],
                )
            )

        bold_spans = re.findall(r"\*\*([^*\n]{1,120})\*\*", document)
        bold_chars = sum(len(item) for item in bold_spans)
        prose_chars = max(1, len(re.sub(r"\s+", "", prose)))
        emphasis_ratio = bold_chars / prose_chars
        emphasis_needs_polish = len(document.strip()) >= 600 and (
            not bold_spans or emphasis_ratio > 0.18
        )
        criteria["emphasis_selective"] = not emphasis_needs_polish
        if emphasis_needs_polish:
            issues.append(
                self._quality_issue(
                    code="emphasis_needs_polish",
                    severity="soft",
                    agent_id="typography_polish_agent",
                    summary="重点结论、风险和行动项缺少克制且一致的视觉强调",
                    evidence={
                        "bold_span_count": len(bold_spans),
                        "bold_character_ratio": round(emphasis_ratio, 4),
                    },
                    required_capabilities=["skill:typography_style"],
                )
            )

        has_diagram = bool(
            re.search(r"```\s*(?: Union[plantuml, mermaid])\b", document, re.IGNORECASE)
        )
        visual_expected = bool(
            state.environment.get("requirement", {}).get("needs_images")
        ) or any(
            marker in context
            for marker in ("架构", "流程", "时序", "链路", "模块关系", "状态机")
        )
        visual_needs_polish = (
            len(document.strip()) >= 500 and visual_expected and not has_diagram
        )
        criteria["visual_explains_relationships"] = not visual_needs_polish
        if visual_needs_polish:
            issues.append(
                self._quality_issue(
                    code="visual_needs_polish",
                    severity="soft",
                    agent_id="image_polish_agent",
                    summary="关键关系或流程仅靠连续文字表达，需要可编辑代码图示",
                    evidence={"has_diagram": has_diagram},
                    required_capabilities=[
                        PLANTUML_DIAGRAM_TOOL_ID,
                        "skill:image_style",
                    ],
                )
            )

        return criteria, issues

    @staticmethod
    def _quality_issue(
        *,
        code: str,
        severity: str,
        agent_id: str,
        summary: str,
        evidence: Optional[Any] = None,
        required_capabilities: Optional[list[str]] = None,
    ) -> dict[str, Any]:
        return {
            "code": code,
            "severity": severity,
            "agent_id": agent_id,
            "summary": summary,
            "evidence": evidence if evidence is not None else {},
            "required_capabilities": required_capabilities or [],
        }

    @staticmethod
    def _prose_for_quality(document: str) -> str:
        prose = re.sub(r"```.*?```", "", document, flags=re.DOTALL)
        prose = re.sub(r"(?m)^\s*\|.*\|\s*$", "", prose)
        prose = re.sub(r"(?m)^#{1,6}\s+", "", prose)
        return prose

    @staticmethod
    def _ai_style_signals(prose: str) -> dict[str, Any]:
        compact = re.sub(r"\s+", "", prose)
        if len(compact) < 260:
            return {}
        quote_pairs = len(re.findall(r"“[^”\n]{1,80}”", prose))
        boilerplate = {
            phrase: prose.count(phrase)
            for phrase in AI_STYLE_BOILERPLATE
            if prose.count(phrase)
        }
        transitions = {
            phrase: prose.count(phrase)
            for phrase in AI_STYLE_TRANSITIONS
            if prose.count(phrase)
        }
        sentences = [
            sentence.strip()
            for sentence in re.split(r"[。！？!?；;\n]+", prose)
            if len(sentence.strip()) >= 8
        ]
        overlong_count = sum(1 for sentence in sentences if len(sentence) > 90)
        signals: dict[str, Any] = {}
        if quote_pairs >= max(5, len(compact) // 360):
            signals["decorative_quote_pairs"] = quote_pairs
        if sum(boilerplate.values()) >= 3:
            signals["boilerplate_phrases"] = boilerplate
        if sum(transitions.values()) >= 8 or any(
            count >= 3 for count in transitions.values()
        ):
            signals["mechanical_transitions"] = transitions
        if overlong_count >= 2 and overlong_count / max(1, len(sentences)) >= 0.18:
            signals["overlong_sentences"] = overlong_count
        return signals

    @classmethod
    def _short_detail_sections(cls, document: str) -> list[str]:
        result: list[str] = []
        ignored_markers = ("参考", "附录", "核验", "结语", "总结")
        for span in cls._markdown_section_spans(document):
            if int(span.get("level") or 0) != 2:
                continue
            title = str(span.get("title") or "")
            if any(marker in title for marker in ignored_markers):
                continue
            block = document[int(span["start"]) : int(span["end"])]
            body = re.sub(r"(?m)^#{1,6}\s+.*$", "", block)
            body = re.sub(r"```.*?```", "", body, flags=re.DOTALL)
            body = re.sub(r"(?m)^\s*[-*+]\s+", "", body)
            body = re.sub(r"\s+", "", body)
            if 0 < len(body) < 60:
                result.append(title)
        return result

    @staticmethod
    def _markdown_table_quality(document: str) -> tuple[bool, int]:
        lines = document.splitlines()
        has_table = False
        malformed = 0
        for index in range(len(lines) - 1):
            header = lines[index].strip()
            separator = lines[index + 1].strip()
            if not (header.startswith("|") and header.endswith("|")):
                continue
            if not re.match(
                r"^\|\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|$",
                separator,
            ):
                continue
            has_table = True
            expected = max(0, header.count("|") - 1)
            row_index = index + 2
            while row_index < len(lines):
                row = lines[row_index].strip()
                if not (row.startswith("|") and row.endswith("|")):
                    break
                if max(0, row.count("|") - 1) != expected:
                    malformed += 1
                row_index += 1
        return has_table, malformed

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
        if step["action"] == "polisher":
            if not cleaned:
                raise RuntimeError(f"{step['name']} 未返回润色后的完整文档")
            base_document = state.current_document
            relevant_issues = [
                item
                for item in state.environment.get("quality_issues", [])
                if isinstance(item, dict) and item.get("agent_id") == step["id"]
            ]
            document_patch = self._build_document_revision_patch(
                base_document,
                cleaned,
                operation=f"quality_polish:{step['id']}",
                requested_sections=[
                    str(section)
                    for item in relevant_issues
                    for section in (
                        (item.get("evidence") or {}).get("short_sections", [])
                        if isinstance(item.get("evidence"), dict)
                        else []
                    )
                ],
                preserved_untouched=True,
            )
            state.environment["document"] = cleaned
            state.environment["last_document_patch"] = document_patch
            state.current_document = cleaned
            state.environment.setdefault("quality_mutations", []).append(
                {
                    "agent_id": step["id"],
                    "quality_cycle": step.get("quality_cycle"),
                    "issue_codes": [
                        str(item.get("code") or "") for item in relevant_issues
                    ],
                    "document_hash": self._document_hash(cleaned),
                }
            )
            patch = {
                "document_length": len(cleaned),
                "document_patch": document_patch,
            }
            yield self._event(
                state,
                "document.patch.applied",
                f"{step['name']}已应用：{document_patch['summary']}",
                status="completed",
                actor=actor,
                environment_patch={"document_patch": document_patch},
                data={"content": cleaned, "patch": document_patch},
            )
        elif step["action"] == "writer":
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
        fenced = re.fullmatch(r"```(?: Union[markdown, md])?\s*\n([\s\S]*?)\n```", text)
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
章节设计 Agent 已给出章节蓝图时，以蓝图作为初稿骨架；如证据不足，只能标记缺口，不能用套话把章节撑满。
对于已安装的技能，优先复刻 title_design_style 中的子标题句式、writing_design 中的行文推进、voice_style 中的惯用话术和 image_generation 中的代码生图方式；field_examples 与 example_document 只用于学习写法，不得照抄主题或事实。不要把这些鲜明特征稀释成通用公文。
要求：保留可验证事实；不编造政策编号、指标或来源；对外部信息给出链接；数据、文档、知识、操作和互联网线索是平权证据，不因所属模块获得额外优先级，按相关性、可靠性、时效和口径适配度取舍；使用数据时写明统计周期和采集时间，`can_use=false` 或陈旧快照只能作为待核验线索；环境包含 PlantUML 画图约束时必须输出对应的 ```plantuml 代码块，否则技术关系优先使用 Mermaid；只输出文档正文。"""
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
6. 保留可验证事实，不编造政策编号、指标或来源；外部结论保留链接；数据、文档、知识、操作和互联网线索按相关性、可靠性、时效和口径适配度平权取舍；数据结论写明统计周期和采集时间，`can_use=false` 或陈旧快照只能标为待核验。
只输出最终完整文档正文，不要输出 JSON 或修订说明；不要用代码围栏包裹整篇文档，但 Tool 要求的 PlantUML 或 Mermaid 图示代码块必须保留。"""
        elif step["action"] == "polisher":
            common = """请基于当前完整文档做一次有边界的二次编辑，并输出润色后的完整 Markdown 文档。
只处理质检分派给你的问题，保留未受影响的章节、事实、来源 URL、数据口径、代码块和用户明确要求。不得编造数字、案例、政策编号或来源；证据不足时保留待核验说明。不要输出 JSON、修改说明或思考过程，也不要用代码围栏包住整篇文档。"""
            role_instructions = {
                "anti_ai_style_agent": """目标是提高中文表达的自然度和作者感，不以规避 AIGC 检测为目标。
删除空泛开场、重复小结、机械的“首先/其次/最后”和无增量的转折；普通概念不要为了强调而滥用引号，真实引语、字段名、代码和专有名词除外。把过长复句拆成自然短句，长短句交替；补出明确主语和动作，能用直接动词就不用“进行、实现、赋能”等名词化套话。优先贴合已安装 Skill 的 voice_style、用户历史表达和当前文档语域，但不得模仿特定在世作者。保持原意和事实强度，不把严谨内容改成网络口头禅。""",
                "detail_polish_agent": """逐章检查观点是否有完整的“对象/边界—依据—动作或机制—结果/验证”。只在已有用户材料、Tool 证据、数据分析和专业 Agent 结论支持的范围内补充细节；需要数据但环境没有证据时，明确口径或待核验项，不得补造数字。优先深挖质检列出的短章节、跳步推论和只写口号的段落，避免为了变长而重复同义句。""",
                "table_polish_agent": """修复不合法的 Markdown 表格；对确实需要逐项比较、职责映射、参数口径或验收矩阵的内容使用表格。表头要短而明确，同一列保持同一口径，单元格避免堆整段正文；复杂解释仍放在表格前后。只输出标准 Markdown 表格，不写内联 HTML/CSS。创作页面会自动为合法表头应用品牌背景色、边框、对齐和斑马纹。""",
                "typography_polish_agent": """只强调读者必须先看到的结论、决策、关键数字、风险和行动项。使用标准 Markdown `**重点**`，每千字通常保留 3—8 处，不能整段加粗，也不要用内联 HTML。页面会把 `strong` 渲染为品牌色、加粗和下划线；标题本身已有层级，不再重复强调。""",
                "image_polish_agent": """只在组件关系、状态变化、跨角色流程或时间交互用文字难以准确理解时补充代码图示。环境有 PlantUML 约束时优先输出 `plantuml` 代码块；否则使用 `mermaid`。图中对象、连线和标签必须来自正文，先用一段正文说明阅读方式，图后补充异常或边界；不插入装饰图、占位图片或无法编辑的外链图片。""",
            }
            system = (
                f"你是 MemoryBread 的{step['name']}。\n"
                f"{common}\n{role_instructions.get(agent_id, '')}"
            )
        else:
            role_instructions = {
                "data_analysis_agent": "优先使用网页实时采集后的数据，其次使用数据检索中 can_use=true 的快照。逐项核对采集时间、指标口径和统计周期；不同周期或口径不得直接合并。工作记忆只能按 observed_at 加权，陈旧数据必须标注。禁止编造数字，输出可验证结论与证据缺口。",
                "industry_research_agent": "综合互联网检索结果，提炼行业现状、趋势、约束与待核验事实。每条外部结论保留来源 URL。",
                "solution_design_agent": "围绕目标、约束和证据设计可落地方案，明确边界、关键决策、组件关系、实施步骤、风险和验证方式。",
                "chapter_design_agent": "先设计章节，再交给文档撰写 Agent。结合目标、读者、文档类型、证据和 Skill，输出有顺序的章节蓝图；每章写明目的、要回答的问题、可用证据、建议表达形式和完成标准。章节必须互斥且共同覆盖目标，不写正文，不补造事实。",
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
        if str(step.get("id") or "") == DATA_SEARCH_TOOL_ID:
            # data_search 位于 memory_search 之后时，优先带上已经命中的报表标题。
            # 这样“GPU 利用率治理”既能召回旧资料，也能把其中引用的运营看板
            # 解析成需要即时刷新的数据源。
            report_titles = []
            for reference in state.environment.get("references", []):
                if not isinstance(reference, dict):
                    continue
                title = str(reference.get("title") or "").strip()
                url = str(reference.get("source_url") or "").strip()
                evidence = f"{title}\n{url}".lower()
                if not any(
                    marker in evidence
                    for marker in (
                        "看板",
                        "报表",
                        "dashboard",
                        "report",
                        "analytics",
                        "grafana",
                        "tableau",
                        "powerbi",
                        "kwaibi",
                    )
                ):
                    continue
                if title:
                    report_titles.append(title)
                if url:
                    report_titles.append(url)
                if len(report_titles) >= 4:
                    break
            if report_titles:
                context_query = "\n".join([*report_titles, context_query])
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

    @staticmethod
    def _apply_data_freshness_to_references(
        state: LoopState,
        data_results: list[dict[str, Any]],
    ) -> None:
        """阻止报表型旧文档在刷新失败后继续冒充当前数据。"""
        by_url = {
            str(item.get("source_url") or "").strip(): item
            for item in data_results
            if isinstance(item, dict) and str(item.get("source_url") or "").strip()
        }
        if not by_url:
            return
        for reference in state.environment.get("references", []):
            if not isinstance(reference, dict):
                continue
            source_url = str(reference.get("source_url") or "").strip()
            result = by_url.get(source_url)
            if not result:
                continue
            reference["data_freshness"] = {
                "freshness_class": result.get("freshness_class"),
                "collected_at": result.get("collected_at"),
                "refresh_required": result.get("refresh_required"),
                "can_use": result.get("can_use"),
                "evidence_verified": (
                    isinstance(result.get("creation_evidence"), dict)
                    and result["creation_evidence"].get("validation_status") == "verified"
                ),
            }
            evidence_verified = (
                isinstance(result.get("creation_evidence"), dict)
                and result["creation_evidence"].get("validation_status") == "verified"
            )
            if result.get("can_use") is True and evidence_verified:
                reference["data_use_policy"] = "current_snapshot_available"
                continue
            reference["content"] = ""
            reference["summary"] = (
                "该引用指向需要即时刷新的报表；刷新成功前只能作为来源线索，"
                "其中的历史数值不得写成当前数据。"
            )
            reference["data_use_policy"] = "current_values_unavailable"

    @staticmethod
    def _enforce_report_evidence_policy(data_results: list[dict[str, Any]]) -> None:
        """未通过本轮截图校验的报表只保留来源元数据，不把数值暴露给写作 Agent。"""
        for result in data_results:
            if not isinstance(result, dict) or result.get("source_kind") != "report_url":
                continue
            evidence = result.get("creation_evidence")
            verified = (
                isinstance(evidence, dict)
                and evidence.get("validation_status") == "verified"
            )
            if verified:
                validation = evidence.get("validation") or {}
                claims = [
                    claim
                    for claim in validation.get("verified_claims", [])
                    if isinstance(claim, dict)
                ]
                result["content_excerpt"] = "\n".join(
                    str(claim.get("statement") or "").strip()
                    for claim in claims
                    if str(claim.get("statement") or "").strip()
                )
                result["structured_data"] = {
                    "validation": "dom_ocr_verified",
                    "verified_claims": claims,
                }
                result["provenance"] = {
                    "creation_evidence_id": evidence.get("id"),
                    "captured_at": evidence.get("captured_at"),
                    "source_url": evidence.get("source_url"),
                }
                continue
            result["can_use"] = False
            result["content_excerpt"] = None
            result["structured_data"] = None
            result["provenance"] = None

    @classmethod
    def _apply_creation_evidence_cards(
        cls,
        document: str,
        evidence_items: list[dict[str, Any]],
    ) -> tuple[str, list[dict[str, Any]]]:
        if not document.strip() or not evidence_items:
            return document, []
        blocks = re.split(r"(\n\s*\n)", document)
        applied: list[dict[str, Any]] = []
        for evidence in evidence_items:
            if evidence.get("validation_status") != "verified":
                continue
            image_url = str(evidence.get("image_url") or "").strip()
            if not image_url or image_url in document:
                continue
            validation = evidence.get("validation") or {}
            claims = validation.get("verified_claims") or []
            matched_index: Optional[int] = None
            for index in range(0, len(blocks), 2):
                block = blocks[index]
                normalized_block = cls._normalize_evidence_match_text(block)
                for claim in claims:
                    if not isinstance(claim, dict):
                        continue
                    if claim.get("claim_type") == "text":
                        statement = str(claim.get("statement") or "")
                        normalized_statement = cls._normalize_evidence_match_text(statement)
                        tokens = cls._evidence_match_tokens(statement)
                        matched_tokens = [
                            token
                            for token in tokens
                            if cls._normalize_evidence_match_text(token) in normalized_block
                        ]
                        if (
                            normalized_statement
                            and normalized_statement in normalized_block
                        ) or (
                            len(matched_tokens) >= 2
                            and len(matched_tokens) / max(1, len(tokens)) >= 0.6
                        ):
                            matched_index = index
                            break
                        continue
                    value = cls._normalize_evidence_match_text(str(claim.get("value") or ""))
                    labels = cls._evidence_match_tokens(str(claim.get("label") or ""))
                    label_match = any(
                        cls._normalize_evidence_match_text(label) in normalized_block
                        for label in labels
                    )
                    if value and value in normalized_block and label_match:
                        matched_index = index
                        break
                if matched_index is not None:
                    break
            if matched_index is None:
                continue
            title = str(evidence.get("page_title") or "即时数据页面").replace("]", "）")
            source_url = str(evidence.get("source_url") or "").strip()
            captured_at = int(evidence.get("captured_at") or 0)
            captured_label = (
                datetime.fromtimestamp(captured_at / 1000).astimezone().strftime("%Y-%m-%d %H:%M:%S %Z")
                if captured_at > 0
                else "创作时"
            )
            source_markdown = f"[{title}](<{source_url}>)" if source_url else title
            card = (
                f"\n\n![证据截图：{title}]({image_url})\n\n"
                f"> 证据截图 · 来源：{source_markdown} · 采集于 {captured_label} · "
                "页面数据与截图文字已通过一致性校验"
            )
            blocks[matched_index] = f"{blocks[matched_index].rstrip()}{card}"
            applied.append(evidence)
        return "".join(blocks), applied

    @staticmethod
    def _normalize_evidence_match_text(value: str) -> str:
        return re.sub(r"[\s,，:：;；|｜]", "", value).lower()

    @staticmethod
    def _evidence_match_tokens(value: str) -> list[str]:
        tokens: list[str] = []
        for english in re.findall(r"[a-zA-Z]{2,}", value):
            lowered = english.lower()
            if lowered not in tokens:
                tokens.append(lowered)
        for sequence in re.findall(r"[\u4e00-\u9fff]{2,}", value):
            chars = list(sequence)
            for index in range(max(1, len(chars) - 1)):
                token = "".join(chars[index : index + 2])
                if len(token) == 2 and token not in tokens:
                    tokens.append(token)
        return tokens[:24]

    def _prompt_environment(self, state: LoopState) -> str:
        blocks = [
            f"原始需求：{state.root_request}",
            f"本轮编辑意图：{state.environment.get('edit_intent', {})}",
            f"任务画像：{state.environment.get('requirement', {})}",
            f"已应用 Skill：{state.environment.get('applied_skills', [])}",
            f"已激活的 Skill 步骤：{state.environment.get('completed_skill_steps', [])}",
            f"本轮质检动态激活 Skill：{state.environment.get('activated_quality_skills', [])}",
            f"本地参考：{state.environment.get('references', [])}",
            f"互联网资料：{state.environment.get('web_results', [])}",
            f"GitHub 公开仓库：{state.environment.get('github_results', [])}",
            f"PlantUML 画图约束：{state.environment.get('plantuml_diagram', {})}",
            f"数据检索结果：{state.environment.get('data_results', [])}",
            f"网页实时采集记录：{state.environment.get('webpage_scrapes', [])}",
            f"数据分析：{state.environment.get('data_analysis', '')}",
            f"行业调研：{state.environment.get('industry_research', '')}",
            f"方案设计：{state.environment.get('solution_design', '')}",
            f"章节设计：{state.environment.get('chapter_design', '')}",
            f"上一轮质量审校：{state.environment.get('quality_review', {})}",
            f"当前质检问题：{state.environment.get('quality_issues', [])}",
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
