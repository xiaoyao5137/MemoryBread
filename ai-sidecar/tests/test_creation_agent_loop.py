from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from creation.agent_loop import CreationAgentLoop
from creation.service import CreationOptions, CreationService, GithubSearchResult


class FakeCreationService:
    def __init__(self):
        self.reference_queries = []
        self.data_results = []
        self.scrape_outcome = None

    def analyze_requirement(self, message, options):
        return {
            "topic": message,
            "doc_type": options.doc_type or "架构设计方案",
            "audience": options.audience or "研发团队",
            "keywords": ["架构", "Agent"],
            "style": "专业清晰",
            "needs_latest": False,
            "needs_images": False,
        }

    def retrieve_references(self, user_prompt, *_args):
        self.reference_queries.append(user_prompt)
        return []

    async def collect_web_context(self, *_args):
        return []

    async def search_github_context(self, *_args):
        return [
            GithubSearchResult(
                full_name="example/agent-kit",
                url="https://github.com/example/agent-kit",
                description="Agent orchestration toolkit",
                stars=128,
                language="Python",
                updated_at="2026-07-01T00:00:00Z",
            )
        ]

    async def retrieve_data_context(self, *_args, **_kwargs):
        return list(self.data_results)

    async def scrape_data_context(self, data_results, *_args, **_kwargs):
        if self.scrape_outcome is not None:
            return self.scrape_outcome
        return {"scrapes": [], "refreshed_data": list(data_results)}

    async def run_specialist_agent(self, **kwargs):
        return f"{kwargs['agent_id']} 的分析结论"

    async def stream_agent_document(self, **_kwargs):
        yield "# Agent 架构方案\n\n"
        yield "## 目标\n\n围绕目标动态编排能力。\n\n"
        yield "## 架构\n\n主 Agent 调用子 Agent、Tool 与 Skill。\n\n"
        yield "## 实施\n\n按契约、运行时、页面和测试分步实施。"

    @staticmethod
    def _clip(value, limit):
        return value[:limit]

    @staticmethod
    def _best_reference_content(reference):
        return reference.full_content


async def collect_events(iterator):
    return [event async for event in iterator]


def test_tool_plan_enforces_required_tools_and_invokes_internet_by_intent():
    loop = CreationAgentLoop(FakeCreationService())
    regular = loop._new_state(
        user_message="写一份项目复盘总结",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-tools-regular",
        run_id="run-tools-regular",
    )
    researched = loop._new_state(
        user_message="检索最新行业政策并写调研方案",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-tools-research",
        run_id="run-tools-research",
    )

    assert "memory_search" in [step["id"] for step in regular.plan]
    assert "internet_search" not in [step["id"] for step in regular.plan]
    assert {"memory_search", "internet_search"} <= {
        step["id"] for step in researched.plan
    }


def test_weekly_report_starts_with_peer_evidence_probes_not_a_fixed_data_pipeline():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="生成本周项目周报，并分析核心指标变化",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-data-report",
        run_id="run-data-report",
    )

    step_ids = [step["id"] for step in state.plan]
    assert "memory_search" in step_ids
    assert "data_search" in step_ids
    assert "webpage_scrape" not in step_ids
    assert "data_analysis_agent" not in step_ids
    assert step_ids.index("data_search") < step_ids.index("document_writer_agent")


def test_metric_governance_uses_report_reference_as_a_data_probe():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="创作一份治理GPU利用率的方案文档",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-gpu-governance",
        run_id="run-gpu-governance",
    )

    assert "data_search" in [step["id"] for step in state.plan]
    state.environment["references"] = [
        {
            "title": "LangBridge 模型中心运营看板 - KwaiBI | 可视化",
            "source_url": "https://kwaibi.example.com/dashboard?id=2119187",
            "summary": "历史摘要",
            "content": "历史 GPU 利用率 45%",
        }
    ]
    query = loop._step_context_query(state, {"id": "data_search"})
    assert query.startswith("LangBridge 模型中心运营看板")
    assert "https://kwaibi.example.com/dashboard?id=2119187" in query

    loop._apply_data_freshness_to_references(
        state,
        [
            {
                "source_url": "https://kwaibi.example.com/dashboard?id=2119187",
                "freshness_class": "missing",
                "collected_at": None,
                "refresh_required": True,
                "can_use": False,
            }
        ],
    )
    reference = state.environment["references"][0]
    assert reference["content"] == ""
    assert reference["data_use_policy"] == "current_values_unavailable"
    assert "不得写成当前数据" in reference["summary"]


def test_evidence_validation_requires_matching_metadata_value_and_label():
    payload = {
        "title": "GPU 实时看板",
        "url": "https://bi.example.com/dashboard/gpu",
        "collected_at": 1770000000000,
        "structured_data": {
            "tables": [["区域", "GPU 利用率"], ["国内", "42%"], ["海外", "47%"]]
        },
        "evidence": {
            "page_title": "GPU 实时看板",
            "source_url": "https://bi.example.com/dashboard/gpu",
            "captured_at": 1770000000000,
        },
    }

    matched = CreationService._compare_scrape_with_ocr(
        payload,
        "GPU 实时看板\n区域 GPU 利用率\n国内 42%\n海外 47%",
    )
    mismatched = CreationService._compare_scrape_with_ocr(
        payload,
        "GPU 实时看板\n国内 65%",
    )

    assert {claim["value"] for claim in matched["verified_claims"]} == {"42%", "47%"}
    assert mismatched["verified_claims"] == []


def test_evidence_validation_also_supports_document_style_pages():
    payload = {
        "title": "容量治理说明",
        "url": "https://docs.example.com/capacity-governance",
        "collected_at": 1770000000000,
        "structured_data": {
            "text_blocks": ["容量治理应先识别长期闲置资源，再按业务优先级分批回收。"]
        },
        "evidence": {
            "page_title": "容量治理说明",
            "source_url": "https://docs.example.com/capacity-governance",
            "captured_at": 1770000000000,
        },
    }

    matched = CreationService._compare_scrape_with_ocr(
        payload,
        "容量治理说明\n容量治理应先识别长期闲置资源，再按业务优先级分批回收。",
    )

    assert matched["verified_claims"][0]["claim_type"] == "text"


def test_verified_evidence_card_is_inserted_below_the_claim_block():
    document = "# GPU 治理方案\n\n国内 GPU 利用率为 42%，需要优先治理。\n\n## 后续动作\n\n按周复盘。"
    evidence = {
        "id": "evidence-1",
        "source_url": "https://bi.example.com/dashboard/gpu",
        "page_title": "GPU 实时看板",
        "captured_at": 1770000000000,
        "image_url": "/api/creation/evidence/evidence-1/image",
        "validation_status": "verified",
        "validation": {
            "verified_claims": [
                {"label": "国内 GPU 利用率", "value": "42%", "statement": "国内 GPU 利用率 42%"}
            ]
        },
    }

    updated, applied = CreationAgentLoop._apply_creation_evidence_cards(document, [evidence])

    assert len(applied) == 1
    assert updated.index("国内 GPU 利用率为 42%") < updated.index("![证据截图")
    assert updated.index("![证据截图") < updated.index("## 后续动作")
    assert "/api/creation/evidence/evidence-1/image" in updated


def test_quality_gate_decision_uses_user_facing_summary():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="写一份架构方案",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-quality-summary",
        run_id="run-quality-summary",
    )

    event = loop._harness_decision_event(
        state,
        {
            "trigger": "quality_review_agent",
            "trigger_status": "completed",
            "reason_code": "quality_gate_passed",
            "scheduled": [],
            "activated_skills": [],
        },
    )

    assert event["summary"] == "质量检查通过"
    assert "Harness" not in event["summary"]


def test_harness_uses_data_search_feedback_to_choose_the_next_capability():
    loop = CreationAgentLoop(FakeCreationService())

    def state_with(results):
        state = loop._new_state(
            user_message="生成本周项目周报，并分析核心指标变化",
            root_request=None,
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(enabled_tools=()),
            model_mode="local",
            session_id="session-data-feedback",
            run_id="run-data-feedback",
        )
        state.cursor = next(
            index + 1 for index, step in enumerate(state.plan) if step["id"] == "data_search"
        )
        state.environment["data_results"] = results
        return state

    stale_report = state_with(
        [
            {
                "source_id": 1,
                "source_kind": "report_url",
                "source_url": "https://bi.example.com/report",
                "refresh_required": True,
                "can_use": False,
                "content_excerpt": "上次采集的指标",
            }
        ]
    )
    decision = loop._replan_after_feedback(
        stale_report,
        {"id": "data_search"},
        status="completed",
    )
    assert decision["scheduled"] == ["webpage_scrape"]
    assert stale_report.plan[stale_report.cursor]["id"] == "webpage_scrape"

    fresh_snapshot = state_with(
        [
            {
                "source_id": 2,
                "source_kind": "report_url",
                "source_url": "https://bi.example.com/report",
                "refresh_required": False,
                "can_use": True,
                "content_excerpt": "本周订单 1200",
            }
        ]
    )
    decision = loop._replan_after_feedback(
        fresh_snapshot,
        {"id": "data_search"},
        status="completed",
    )
    assert decision["scheduled"] == ["webpage_scrape"]
    assert fresh_snapshot.plan[fresh_snapshot.cursor]["id"] == "webpage_scrape"

    no_data = state_with([])
    decision = loop._replan_after_feedback(
        no_data,
        {"id": "data_search"},
        status="completed",
    )
    assert decision["scheduled"] == []
    assert decision["reason_code"] == "no_matching_data"


def test_harness_does_not_analyze_unverified_report_after_refresh_failure():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="生成本周项目周报，并分析核心指标变化",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-data-refresh-failed",
        run_id="run-data-refresh-failed",
    )
    state.cursor = next(
        index + 1 for index, step in enumerate(state.plan) if step["id"] == "data_search"
    )
    state.environment["data_results"] = [
        {
            "source_id": 1,
            "source_kind": "report_url",
            "source_url": "https://bi.example.com/report",
            "refresh_required": True,
            "can_use": False,
            "content_excerpt": "历史订单 900",
        }
    ]
    loop._replan_after_feedback(state, {"id": "data_search"}, status="completed")
    state.cursor += 1

    decision = loop._replan_after_feedback(
        state,
        {"id": "webpage_scrape"},
        status="failed",
        error_code="SCRAPE_AUTH_REQUIRED",
    )

    assert decision["scheduled"] == []
    assert decision["reason_code"] == "refresh_failed_without_snapshot"


def test_quality_feedback_routes_specialists_and_dependencies_in_stable_order():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="写一份带流程图和对比表的架构方案",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=("plantuml_diagram",)),
        model_mode="local",
        session_id="session-quality-routing",
        run_id="run-quality-routing",
    )
    state.cursor = len(state.plan)
    state.environment["quality_issues"] = [
        {"code": "ai_style_signals", "severity": "soft", "agent_id": "anti_ai_style_agent", "required_capabilities": []},
        {"code": "detail_incomplete", "severity": "soft", "agent_id": "detail_polish_agent", "required_capabilities": []},
        {"code": "table_needs_polish", "severity": "soft", "agent_id": "table_polish_agent", "required_capabilities": []},
        {"code": "visual_needs_polish", "severity": "soft", "agent_id": "image_polish_agent", "required_capabilities": ["plantuml_diagram"]},
        {"code": "emphasis_needs_polish", "severity": "soft", "agent_id": "typography_polish_agent", "required_capabilities": []},
    ]

    decision = loop._replan_after_feedback(
        state,
        {"id": "quality_review_agent"},
        status="completed",
    )

    assert decision["reason_code"] == "quality_issues_detected"
    assert decision["quality_cycle"] == 1
    assert decision["activated_skills"] == []
    assert decision["scheduled"] == [
        "plantuml_diagram",
        "detail_polish_agent",
        "table_polish_agent",
        "image_polish_agent",
        "anti_ai_style_agent",
        "typography_polish_agent",
        "quality_review_agent",
    ]

    contract_path = (
        Path(__file__).resolve().parents[2]
        / "shared"
        / "creation-tools"
        / "creation-tools.schema.json"
    )
    contract = json.loads(contract_path.read_text(encoding="utf-8"))
    quality_branch = contract["$defs"]["harness_decision_event"]["properties"][
        "data"
    ]["oneOf"][1]
    assert set(quality_branch["required"]) <= set(decision)
    assert decision["trigger"] == quality_branch["properties"]["trigger"]["const"]
    allowed_scheduled = set(
        quality_branch["properties"]["scheduled"]["items"]["enum"]
    )
    assert set(decision["scheduled"]) <= allowed_scheduled


@pytest.mark.asyncio
async def test_quality_feedback_dynamically_activates_a_matching_skill():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="把复盘写得自然一些",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[
            {
                "id": "natural-retrospective",
                "title": "自然复盘表达 Skill",
                "writingGuidelines": ["用团队日常语言陈述判断", "避免模板化转折"],
                "executionSteps": [],
            }
        ],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-quality-skill",
        run_id="run-quality-skill",
    )
    state.environment["applied_skills"] = loop._match_skills(state)
    state.cursor = len(state.plan)
    state.environment["quality_issues"] = [
        {
            "code": "ai_style_signals",
            "severity": "soft",
            "agent_id": "anti_ai_style_agent",
            "required_capabilities": ["skill:voice_style"],
        }
    ]

    decision = loop._replan_after_feedback(
        state,
        {"id": "quality_review_agent"},
        status="completed",
    )

    assert decision["activated_skills"] == ["natural-retrospective"]
    assert decision["scheduled"] == [
        "anti_ai_style_agent",
        "quality_review_agent",
    ]
    skill_step = state.plan[state.cursor]
    assert skill_step["action"] == "activate_quality_skill"
    events = await collect_events(
        loop._execute_step(
            state,
            skill_step,
            creation_model=None,
            creation_api_key=None,
            creation_base_url=None,
        )
    )
    assert events[-1]["type"] == "skill.completed"
    assert state.environment["activated_quality_skills"][0]["issue_codes"] == [
        "ai_style_signals"
    ]
    anti_ai_step = next(
        item for item in state.plan if item["id"] == "anti_ai_style_agent"
    )
    _, prompt = loop._model_prompts(state, anti_ai_step)
    assert "本轮质检动态激活 Skill" in prompt
    assert "避免模板化转折" in prompt


def test_quality_review_detects_observable_ai_style_signals():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="写一份运营方案",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[],
        options=CreationOptions(enabled_tools=()),
        model_mode="local",
        session_id="session-ai-style",
        run_id="run-ai-style",
    )
    repeated = (
        "首先，值得注意的是，我们需要关注“核心能力”。其次，不难发现，"
        "“协同机制”具有重要价值。此外，我们还要建设“增长飞轮”。"
    )
    document = (
        "# 运营方案\n\n## 背景\n\n"
        + repeated * 3
        + "\n\n## 执行\n\n"
        + repeated * 3
        + "\n\n## 验证\n\n通过真实结果复核每项动作。"
    )

    criteria, issues = loop._inspect_document_quality(state, document)

    assert criteria["natural_expression"] is False
    style_issue = next(item for item in issues if item["code"] == "ai_style_signals")
    assert style_issue["agent_id"] == "anti_ai_style_agent"
    assert style_issue["evidence"]["decorative_quote_pairs"] >= 5


@pytest.mark.asyncio
async def test_quality_loop_runs_anti_ai_polisher_and_rechecks_the_result():
    class NaturalRewriteService(FakeCreationService):
        async def stream_agent_document(self, **kwargs):
            if "去 AI 味 Agent" in kwargs["system_prompt"]:
                yield """# 项目复盘

## 发生了什么

团队在两周内完成了需求拆分、接口联调和灰度发布。联调阶段暴露出三个边界条件，负责人当天补充了用例，第二天完成回归。这个过程没有改变发布目标，但让验收口径从口头约定变成了可重复检查的清单。

## 我们怎么判断

复盘以工单、测试记录和发布日志为依据。**关键判断是先修正进入条件，再增加提醒。** 原因很直接：同一问题连续出现时，提醒只能让人更忙，明确的进入条件才能减少返工。没有证据支持的猜测继续留在核验清单中。

## 下一步怎么做

产品负责人本周补齐异常路径，研发负责人把边界用例加入回归集，发布负责人在下一次灰度前核对清单。下轮复盘只看三个结果：异常是否提前暴露、返工是否减少、责任人能否根据记录直接接手。
"""
                return
            repeated = (
                "首先，值得注意的是，我们需要关注“核心能力”。其次，不难发现，"
                "“协同机制”具有重要价值。此外，我们还要建设“增长飞轮”。"
            )
            yield (
                "# 项目复盘\n\n## 发生了什么\n\n"
                + repeated * 3
                + "\n\n## 我们怎么判断\n\n"
                + repeated * 3
                + "\n\n## 下一步怎么做\n\n"
                + repeated * 2
                + " **下一步由负责人复核结果。**"
            )

    events = await collect_events(
        CreationAgentLoop(NaturalRewriteService()).run(
            user_message="请写一份完整的项目复盘",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(enable_rag=False),
        )
    )

    assert events[-1]["type"] == "run.completed"
    assert any(
        event["type"] == "agent.completed"
        and event["actor"]["id"] == "anti_ai_style_agent"
        for event in events
    )
    assert sum(
        event["type"] == "agent.completed"
        and event["actor"]["id"] == "quality_review_agent"
        for event in events
    ) == 2
    final_document = events[-1]["data"]["document"]
    assert "值得注意的是" not in final_document
    assert "关键判断" in final_document


@pytest.mark.asyncio
async def test_harness_replans_during_the_run_from_fresh_data_feedback():
    service = FakeCreationService()
    service.data_results = [
        {
            "source_id": 2,
            "source_kind": "work_memory",
            "source_url": None,
            "refresh_required": False,
            "can_use": True,
            "content_excerpt": "本周完成需求 12 项",
            "structured_data": {"metric_statements": ["本周完成需求 12 项"]},
        }
    ]

    events = await collect_events(
        CreationAgentLoop(service).run(
            user_message="生成本周项目周报，并分析核心指标变化",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(enabled_tools=()),
        )
    )

    decisions = [event for event in events if event["type"] == "harness.decision"]
    assert decisions[0]["data"]["scheduled"] == ["data_analysis_agent"]
    assert not any(
        (event.get("actor") or {}).get("id") == "webpage_scrape" for event in events
    )
    assert any(
        (event.get("actor") or {}).get("id") == "data_analysis_agent"
        and event["type"] == "agent.completed"
        for event in events
    )
    assert events[-1]["type"] == "run.completed"


def test_primary_skill_workflow_drives_agent_tool_order_and_step_context():
    loop = CreationAgentLoop(FakeCreationService())
    state = loop._new_state(
        user_message="为管理层写一份市场进入方案",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[
            {
                "id": "market-entry-skill",
                "title": "市场进入方案 Skill",
                "summary": "把行业事实、数据判断和方案取舍组织成决策材料。",
                "skillDescription": {
                    "purpose": "帮助决策者形成可验证的市场进入方案。",
                    "documentTypes": ["市场进入方案"],
                    "problems": ["判断机会、约束与进入路径"],
                    "domains": ["市场战略"],
                    "deliverables": ["可评审的市场进入方案"],
                },
                "executionSteps": [
                    {
                        "id": "research-market",
                        "title": "调研市场",
                        "objective": "核对行业现状与趋势。",
                        "output": "带来源的行业事实",
                        "agents": ["industry_research_agent"],
                        "skills": ["evidence-brief"],
                        "tools": ["internet_search", "github_search"],
                    },
                    {
                        "id": "analyze-evidence",
                        "title": "分析证据",
                        "objective": "形成数据判断并标记证据缺口。",
                        "output": "数据结论和待核验项",
                        "agents": ["data_analysis_agent"],
                        "skills": [],
                        "tools": [],
                    },
                    {
                        "id": "design-entry",
                        "title": "设计进入方案",
                        "objective": "把约束与结论转成进入路径。",
                        "output": "方案结构与关键取舍",
                        "agents": [
                            "solution_design_agent",
                            "document_writer_agent",
                            "quality_review_agent",
                        ],
                        "skills": [],
                        "tools": [],
                    },
                ],
            }
        ],
        options=CreationOptions(enabled_tools=("internet_search",)),
        model_mode="local",
        session_id="session-skill-workflow",
        run_id="run-skill-workflow",
    )

    assert [step["id"] for step in state.plan] == [
        "creation_main_agent",
        "market-entry-skill",
        "architecture-solution-template",
        "internet_search",
        "industry_research_agent",
        "data_analysis_agent",
        "solution_design_agent",
        "chapter_design_agent",
        "document_writer_agent",
        "quality_review_agent",
    ]
    research_step = next(
        step for step in state.plan if step["id"] == "industry_research_agent"
    )
    assert research_step["skill_step_id"] == "research-market"
    assert research_step["skill_step_skills"] == ["evidence-brief"]
    _, prompt = loop._model_prompts(state, research_step)
    assert "【当前 Skill 执行步骤】" in prompt
    assert "核对行业现状与趋势" in prompt
    assert "带来源的行业事实" in prompt
    assert "evidence-brief" in prompt
    assert "github_search" not in [step["id"] for step in state.plan]


def test_skill_workflow_reuses_resources_across_steps_and_keeps_logic_only_step():
    loop = CreationAgentLoop(FakeCreationService())
    skill = {
        "id": "research-review-skill",
        "title": "调研复核 Skill",
        "executionSteps": [
            {
                "id": "initial-research",
                "title": "开展初查",
                "objective": "收集第一轮行业事实。",
                "output": "初查事实清单",
                "agents": ["industry_research_agent"],
                "skills": ["evidence-brief"],
                "tools": ["internet_search"],
            },
            {
                "id": "source-review",
                "title": "复核来源",
                "objective": "用第二轮检索交叉核验关键结论。",
                "output": "复核后的事实与冲突项",
                "agents": ["industry_research_agent"],
                "skills": ["evidence-brief"],
                "tools": ["internet_search"],
            },
            {
                "id": "set-boundary",
                "title": "确认边界",
                "objective": "明确哪些结论可以进入成稿。",
                "output": "可写事实边界",
                "agents": [],
                "skills": [],
                "tools": [],
            },
        ],
    }
    state = loop._new_state(
        user_message="写一份行业研究材料",
        root_request=None,
        current_document="",
        conversation=[],
        selected_skills=[skill],
        options=CreationOptions(enabled_tools=("internet_search",)),
        model_mode="local",
        session_id="session-repeat-resources",
        run_id="run-repeat-resources",
    )

    assert [
        step["skill_step_id"]
        for step in state.plan
        if step["id"] == "internet_search"
    ] == ["initial-research", "source-review"]
    assert [
        step["skill_step_id"]
        for step in state.plan
        if step["id"] == "industry_research_agent"
    ] == ["initial-research", "source-review"]
    logic_step = next(
        step for step in state.plan if step.get("skill_step_id") == "set-boundary"
    )
    assert logic_step["action"] == "activate_skill_step"
    query = loop._step_context_query(
        state,
        next(
            step
            for step in state.plan
            if step["id"] == "internet_search"
            and step["skill_step_id"] == "source-review"
        ),
    )
    assert "交叉核验关键结论" in query
    assert "evidence-brief" in query


@pytest.mark.asyncio
async def test_optional_tools_are_called_only_when_enabled_and_matched():
    events = await collect_events(
        CreationAgentLoop(FakeCreationService()).run(
            user_message="检索 GitHub 开源仓库并用 PlantUML 画一张时序图，形成技术方案",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(
                enabled_tools=(
                    "internet_search",
                    "memory_search",
                    "github_search",
                    "plantuml_diagram",
                )
            ),
        )
    )

    tool_events = [
        event
        for event in events
        if event["type"] == "tool.completed"
    ]
    assert {"github_search", "plantuml_diagram"} <= {
        event["actor"]["id"] for event in tool_events
    }
    github_event = next(
        event for event in tool_events if event["actor"]["id"] == "github_search"
    )
    assert github_event["data"]["result_count"] == 1
    plantuml_event = next(
        event for event in tool_events if event["actor"]["id"] == "plantuml_diagram"
    )
    assert plantuml_event["data"]["diagram_type"] == "sequence"
    assert events[-1]["type"] == "run.completed"


@pytest.mark.asyncio
async def test_tool_failure_uses_stable_error_code_and_creation_continues():
    class FailingMemoryService(FakeCreationService):
        def retrieve_references(self, *_args):
            raise RuntimeError("本地索引暂时不可用")

    events = await collect_events(
        CreationAgentLoop(FailingMemoryService()).run(
            user_message="输出一份项目复盘方案",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(),
        )
    )

    failed = next(event for event in events if event["type"] == "tool.failed")
    assert failed["actor"]["id"] == "memory_search"
    assert failed["data"]["error_code"] == "TOOL_EXECUTION_FAILED"
    assert events[-1]["type"] == "run.completed"


def test_installed_skill_keeps_full_style_fingerprint_for_writer():
    loop = CreationAgentLoop(FakeCreationService())
    state = SimpleNamespace(
        selected_skills=[
            {
                "id": "skill-style",
                "title": "架构方案风格",
                "summary": "复刻源文档风格",
                "titleDesignStyle": ["子标题使用问句结构"],
                "writingDesign": "先解释原因，再展开方案。",
                "imageGeneration": "推荐工具：PlantUML。",
                "structurePattern": ["问题与原因", "方案设计"],
                "voiceStyle": ["习惯用“基于此”承接方案。"],
                "fieldExamples": {"titleDesignStyle": ["方案如何落地"]},
                "exampleDocument": "# 示例\n\n## 方案如何落地\n\n正文。",
            }
        ],
        root_request="输出架构方案",
        user_message="输出架构方案",
        environment={"requirement": {"doc_type": "架构方案"}},
    )

    matched = loop._match_skills(state)

    assert matched[0]["title_design_style"] == ["子标题使用问句结构"]
    assert matched[0]["writing_design"] == "先解释原因，再展开方案。"
    assert matched[0]["image_generation"] == "推荐工具：PlantUML。"
    assert matched[0]["voice_style"] == ["习惯用“基于此”承接方案。"]
    assert matched[0]["field_examples"]["titleDesignStyle"] == ["方案如何落地"]
    assert "方案如何落地" in matched[0]["example_document"]


@pytest.mark.asyncio
async def test_loop_updates_goal_after_agent_tool_and_skill_results():
    loop = CreationAgentLoop(FakeCreationService())
    events = await collect_events(
        loop.run(
            user_message="设计创作功能的 Agent Loop 架构方案",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(enable_rag=True, doc_type="架构设计方案"),
        )
    )

    event_types = [event["type"] for event in events]
    assert event_types[0] == "run.started"
    assert "tool.completed" in event_types
    assert "skill.completed" in event_types
    assert "document.delta" in event_types
    assert event_types[-1] == "run.completed"

    completed = [
        event
        for event in events
        if event["type"] in {"agent.completed", "tool.completed", "skill.completed"}
    ]
    revisions = [event["goal"]["revision"] for event in completed]
    assert revisions == sorted(revisions)
    assert len(set(revisions)) == len(revisions)
    assert any(
        event["actor"]["id"] == "solution_design_agent" for event in completed
    )
    assert any(
        event["actor"]["id"] == "document_writer_agent" for event in completed
    )


@pytest.mark.asyncio
async def test_external_model_can_pause_and_resume_each_dynamic_agent_step():
    loop = CreationAgentLoop(FakeCreationService())
    first = await collect_events(
        loop.run(
            user_message="输出一份架构方案",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(enable_rag=False, doc_type="架构设计方案"),
            model_mode="external",
        )
    )
    assert first[-2]["type"] == "model.request"
    assert first[-1]["type"] == "run.paused"
    first_state = first[-1]["data"]["continuation"]

    second = await collect_events(
        loop.run(
            user_message="",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(),
            resume_state=first_state,
            model_result="已明确组件边界、数据流和验证方式。",
        )
    )
    assert second[-2]["type"] == "model.request"
    assert second[-1]["type"] == "run.paused"
    second_state = second[-1]["data"]["continuation"]

    third = await collect_events(
        loop.run(
            user_message="",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(),
            resume_state=second_state,
            model_result="章节蓝图：目标、总体架构、实施与验证。",
        )
    )
    assert third[-2]["type"] == "model.request"
    assert third[-1]["type"] == "run.paused"
    third_state = third[-1]["data"]["continuation"]

    document = """# Agent 架构方案

## 目标

建立目标驱动的动态编排运行时。

## 总体架构

主 Agent 根据环境选择子 Agent、Tool 和 Skill。

## 实施与验证

用契约测试、运行时测试和页面测试验证完整链路。

先固化事件协议，再实现可暂停和恢复的运行时。每个 Agent、Tool 和 Skill 完成后都更新环境快照与目标修订号，主 Agent 依据最新状态选择下一步。验收覆盖初次生成、多轮修订、外部模型恢复、用户确认和失败重试。
"""
    final = await collect_events(
        loop.run(
            user_message="",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(),
            resume_state=third_state,
            model_result=document,
        )
    )
    assert final[-1]["type"] == "run.completed"
    assert final[-1]["data"]["document"] == document.strip()
    assert final[-1]["goal"]["status"] == "complete"


@pytest.mark.asyncio
async def test_short_initial_goal_requests_user_confirmation():
    loop = CreationAgentLoop(FakeCreationService())
    events = await collect_events(
        loop.run(
            user_message="写方案",
            current_document="",
            conversation=[],
            selected_skills=[],
            options=CreationOptions(enable_rag=False),
        )
    )
    assert events[-2]["type"] == "confirmation.required"
    assert events[-2]["goal"]["status"] == "waiting_user"
    assert events[-1]["type"] == "run.paused"


@pytest.mark.asyncio
async def test_follow_up_revises_full_document_and_places_new_section_logically():
    class IndustryResearchService(FakeCreationService):
        async def stream_agent_document(self, **_kwargs):
            yield """# 新能源数据平台建设方案

## 背景与目标

本方案面向集团管理层，建设新能源数据平台，统一数据口径并支持经营分析。原始范围包括数据治理、指标服务和权限审计，所有结论必须基于可核验资料。

## 行业调研

行业需求持续增长，具体规模和政策口径需结合检索来源核验。

- 趋势：从单点工具走向平台化协同。
- 约束：合规、数据质量与组织协作仍是主要挑战。

## 总体架构

平台由采集、治理、指标和应用四层组成，沿用既有安全边界与部署约束。

## 实施计划

第一阶段完成行业口径核验与数据梳理，第二阶段建设平台，第三阶段进行验收和推广。

## 风险与验证

通过数据质量抽检、权限审计、行业口径复核和业务验收验证方案有效性。
"""

    original = """# 新能源数据平台建设方案

## 背景与目标

本方案面向集团管理层，建设新能源数据平台，统一数据口径并支持经营分析。原始范围包括数据治理、指标服务和权限审计，所有结论必须基于可核验资料。

## 总体架构

平台由采集、治理、指标和应用四层组成，沿用既有安全边界与部署约束。

## 实施计划

第一阶段完成口径梳理，第二阶段建设平台，第三阶段进行验收和推广。

## 风险与验证

通过数据质量抽检、权限审计和业务验收验证方案有效性。
"""
    service = IndustryResearchService()
    loop = CreationAgentLoop(service)
    events = await collect_events(
        loop.run(
            user_message="补充下行业调研",
            root_request="为集团管理层生成新能源数据平台建设方案，保留安全边界",
            current_document=original,
            conversation=[
                {
                    "role": "user",
                    "content": "为集团管理层生成新能源数据平台建设方案，保留安全边界",
                },
                {"role": "assistant", "content": "已生成首版"},
                {"role": "user", "content": "补充下行业调研"},
            ],
            selected_skills=[],
            options=CreationOptions(enable_rag=True, enable_web_search=False),
        )
    )

    intent = next(event for event in events if event["type"] == "intent.interpreted")
    assert intent["data"]["operation"] == "revise_document"
    assert intent["data"]["target_sections"] == ["行业调研"]
    assert intent["data"]["root_request"].startswith("为集团管理层")

    patch_event = next(
        event for event in events if event["type"] == "document.patch.applied"
    )
    updated = patch_event["data"]["content"]
    assert "## 行业调研" in updated
    assert "## 总体架构\n\n平台由采集、治理、指标和应用四层组成" in updated
    assert updated.index("## 行业调研") < updated.index("## 总体架构")
    assert patch_event["data"]["patch"]["preserved_untouched"] is True
    assert patch_event["data"]["patch"]["operation"] == "revise_document"
    assert patch_event["data"]["patch"]["change_count"] >= 3
    assert {
        change["section_title"]
        for change in patch_event["data"]["patch"]["changes"]
    } >= {"行业调研", "实施计划", "风险与验证"}
    assert not any(event["type"] == "document.replaced" for event in events)
    assert events[-1]["data"]["document"] == updated
    assert "新能源数据平台建设方案" in service.reference_queries[0]
    assert "补充下行业调研" in service.reference_queries[0]


def test_context_window_keeps_original_request_and_recent_turns():
    service = FakeCreationService()
    loop = CreationAgentLoop(service)
    conversation = [
        {
            "role": "user" if index % 2 == 0 else "assistant",
            "content": (
                "最初的完整行业方案需求"
                if index == 0
                else f"第 {index} 轮补充"
            ),
        }
        for index in range(70)
    ]

    state = loop._new_state(
        user_message="再补充行业调研",
        root_request=None,
        current_document="# 方案\n\n## 背景\n\n已有内容",
        conversation=conversation,
        selected_skills=[],
        options=CreationOptions(enable_rag=True),
        model_mode="local",
        session_id="session-context",
        run_id="run-context",
    )

    assert state.root_request == "最初的完整行业方案需求"
    assert state.conversation[0]["content"] == "最初的完整行业方案需求"
    assert state.conversation[-1]["content"] == "第 69 轮补充"
    assert "最初的完整行业方案需求" in state.environment["context_query"]
    assert "再补充行业调研" in state.goal.objective


@pytest.mark.asyncio
async def test_soft_quality_warning_does_not_regenerate_an_already_complete_revision():
    class CompleteRevisionService(FakeCreationService):
        def __init__(self):
            super().__init__()
            self.writer_calls = 0

        async def stream_agent_document(self, **_kwargs):
            self.writer_calls += 1
            yield """# 周年员工礼物自主领取指南

## 领取原则

参考成熟互联网公司的员工关怀做法，周年礼物采用自主选择、统一额度、按时领取的方式。礼物方案覆盖实用、纪念与体验三类，并明确适用人群、领取窗口和异常处理。

## 礼物分档

员工可在标准额度内选择办公用品、生活家电或纪念礼盒。每项礼物展示规格、库存和预计到货时间，缺货时提供同档替代选项，避免默认升级或隐性加价。

## 执行安排

人力团队提前确认名单，采购团队维护礼物池，员工在周年日前完成选择。系统保留选择记录，逾期、退换和地址变更进入人工处理，并由负责人按周核验完成情况。
"""

    original = """# 周年礼物指南

## 背景

说明周年礼物的员工关怀目标。

## 选品

列出可选择的礼物。

## 领取流程

说明领取步骤。

## 预算

说明预算约束。

## 风险

说明缺货和延期处理。
"""
    service = CompleteRevisionService()
    events = await collect_events(
        CreationAgentLoop(service).run(
            user_message="参考快手员工周年礼物方案",
            root_request="写一份周年员工的礼物指南",
            current_document=original,
            conversation=[
                {"role": "user", "content": "写一份周年员工的礼物指南"},
                {"role": "assistant", "content": "文档已更新"},
                {"role": "user", "content": "参考快手员工周年礼物方案"},
            ],
            selected_skills=[],
            options=CreationOptions(enable_rag=False),
        )
    )

    quality_event = next(
        event
        for event in events
        if event["type"] == "agent.completed"
        and event["actor"]["id"] == "quality_review_agent"
    )
    assert service.writer_calls == 1
    assert sum(event["type"] == "document.patch.applied" for event in events) == 1
    assert quality_event["environment_patch"]["quality_review"]["preserves_structure"] is False
    assert "保留当前完整版本" in quality_event["summary"]
    assert events[-1]["type"] == "run.completed"
    assert "待核验项" in events[-1]["goal"]["outcome"]


def test_replace_and_delete_section_patches_preserve_other_sections():
    loop = CreationAgentLoop(FakeCreationService())
    original = """# 平台方案

## 背景

背景保持不变。

## 行业调研

旧调研内容。

## 实施计划

实施计划保持不变。
"""
    replaced, replace_patch = loop._apply_document_patch(
        original,
        "## 行业调研\n\n新调研内容，并保留可核验口径。",
        operation="replace_section",
        target_sections=["行业调研"],
    )
    assert "旧调研内容" not in replaced
    assert "背景保持不变" in replaced
    assert "实施计划保持不变" in replaced
    assert replace_patch["operation"] == "replace_section"
    assert replace_patch["base_hash"] != replace_patch["result_hash"]

    deleted, delete_patch = loop._apply_document_patch(
        replaced,
        "",
        operation="delete_section",
        target_sections=["行业调研"],
    )
    assert "## 行业调研" not in deleted
    assert "背景保持不变" in deleted
    assert "实施计划保持不变" in deleted
    assert delete_patch["operation"] == "delete_section"

    inserted, _ = loop._apply_document_patch(
        original.replace(
            "## 行业调研\n\n旧调研内容。\n\n",
            "",
        ),
        "## 行业调研\n\n新增调研内容。",
        operation="append_section",
        target_sections=["行业调研"],
    )
    assert inserted.index("## 行业调研") < inserted.index("## 实施计划")
    assert loop._target_positions_are_logical(inserted, ["行业调研"]) is True
    appended_too_late = (
        original.replace(
            "## 行业调研\n\n旧调研内容。\n\n",
            "",
        ).rstrip()
        + "\n\n## 行业调研\n\n新增调研内容。\n"
    )
    assert loop._target_positions_are_logical(
        appended_too_late,
        ["行业调研"],
    ) is False

    global_change = loop._interpret_edit_intent(
        "把目标读者改为董事会成员",
        current_document=original,
        mode="revision",
    )
    assert global_change.operation == "revise_document"


def test_revision_patch_tracks_added_modified_and_deleted_ranges():
    loop = CreationAgentLoop(FakeCreationService())
    before = """# 平台方案

## 背景与目标

服务研发团队。

## 总体架构

沿用旧架构。

## 实施计划

分两阶段实施。
"""
    after = """# 平台方案

## 背景与目标

服务董事会和经营团队。

## 行业调研

行业正在从单点工具向平台化协同演进。

## 总体架构

采用数据、服务和应用三层架构。
"""
    patch = loop._build_document_revision_patch(
        before,
        after,
        operation="revise_document",
        requested_sections=["背景与目标", "行业调研", "总体架构"],
        preserved_untouched=True,
    )

    assert patch["operation"] == "revise_document"
    assert patch["change_count"] >= 4
    assert {change["change_type"] for change in patch["changes"]} == {
        "added",
        "modified",
        "deleted",
    }
    visible_changes = [
        change
        for change in patch["changes"]
        if change["change_type"] != "deleted"
    ]
    assert all(change["start_line"] <= change["end_line"] for change in visible_changes)
    assert "行业调研" in patch["target_sections"]
