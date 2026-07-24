from __future__ import annotations

import json
import types

from knowledge.extractor_v2 import (
    BAKE_BUNDLE_RESPONSE_SCHEMA,
    BAKE_NUM_PREDICT,
    BAKE_RESPONSE_SCHEMA,
    KnowledgeExtractorV2,
    _extract_json_object,
    _extract_ollama_response_text,
)


class MessageLike:
    def __init__(self, content: str = "", thinking: str = ""):
        self.content = content
        self.thinking = thinking


class ResponseLike:
    def __init__(self, message):
        self.message = message




SAMPLE_CANDIDATE = {
    "source_timeline_id": 1,
    "source_capture_id": 10,
    "summary": "修复 bake pipeline 的 JSON 提炼链路",
    "overview": "定位 sidecar 返回空内容导致 bake 三类产物全部 rejected。",
    "details": "检查 extractor_v2 的 JSON 解析与 response shape 兼容逻辑，并补充测试覆盖。",
    "importance": 4,
    "occurrence_count": 1,
    "observed_at": 1710000000000,
    "event_time_start": None,
    "event_time_end": None,
    "history_view": False,
    "content_origin": "live_interaction",
    "activity_type": "coding",
    "evidence_strength": "high",
    "capture_ts": 1710000000000,
    "capture_app_name": "Cursor",
    "capture_win_title": "extractor_v2.py",
    "capture_ax_text": "修复 JSON 解析",
    "capture_ocr_text": "bake invalid_json",
    "capture_input_text": "",
    "capture_audio_text": "",
    "entities": ["bake", "JSON", "sidecar"],
}


TEMPLATE_ONLY_CANDIDATE = {
    "source_timeline_id": 2,
    "source_capture_id": 20,
    "summary": "整理周报撰写模板骨架",
    "overview": "抽象固定段落模板：背景、进展、风险、下周计划。",
    "details": "这次工作重点是沉淀一套可重复复用的周报结构与槽位，而不是总结某一周发生了什么。",
    "importance": 4,
    "occurrence_count": 1,
    "observed_at": 1710000000000,
    "event_time_start": None,
    "event_time_end": None,
    "history_view": False,
    "content_origin": "live_interaction",
    "activity_type": "writing",
    "evidence_strength": "high",
    "capture_ts": 1710000000000,
    "capture_app_name": "Cursor",
    "capture_win_title": "weekly_report_template.md",
    "capture_ax_text": "周报模板骨架 槽位 背景 进展 风险 下周计划",
    "capture_ocr_text": "模板 结构 段落 常用表达",
    "capture_input_text": "输出一个可复用的周报模板骨架，而不是总结本周内容。",
    "capture_audio_text": "",
    "entities": ["周报", "模板", "背景", "进展", "风险", "下周计划"],
}


class DummyClient:
    def __init__(self, response):
        self.response = response
        self.calls = []

    def chat(self, **kwargs):
        self.calls.append(kwargs)
        return self.response



def make_extractor() -> KnowledgeExtractorV2:
    extractor = KnowledgeExtractorV2.__new__(KnowledgeExtractorV2)
    extractor.model = "mock-model"
    extractor._build_bake_candidate_text = types.MethodType(lambda self, candidate: "candidate-text", extractor)
    return extractor



def make_raw_extractor() -> KnowledgeExtractorV2:
    extractor = KnowledgeExtractorV2.__new__(KnowledgeExtractorV2)
    extractor.model = "mock-model"
    return extractor



def test_extract_json_object_accepts_python_like_dict():
    raw = "```json\n{'accepted': True, 'reason': None, 'payload': {'summary': 'ok'}}\n```"

    parsed = _extract_json_object(raw)

    assert parsed == {
        "accepted": True,
        "reason": None,
        "payload": {"summary": "ok"},
    }



def test_extract_ollama_response_text_falls_back_to_response_field():
    response = {"response": {"text": '{"accepted": false, "reason": "rejected", "payload": null}'}}

    text = _extract_ollama_response_text(response)

    assert text == '{"accepted": false, "reason": "rejected", "payload": null}'



def test_extract_ollama_response_text_reads_object_message_content_before_thinking():
    response = ResponseLike(
        message=MessageLike(
            content='{"accepted": true, "reason": null, "payload": {"summary": "ok"}}',
            thinking='Thinking Process: should not be used',
        )
    )

    text = _extract_ollama_response_text(response)

    assert text == '{"accepted": true, "reason": null, "payload": {"summary": "ok"}}'



def test_call_bake_llm_uses_structured_json_schema():
    extractor = make_extractor()
    client = DummyClient(
        {
            "model": "mock-model",
            "message": {"content": '{"accepted": false, "reason": "rejected", "payload": null}'},
            "prompt_eval_count": 10,
            "eval_count": 8,
        }
    )
    extractor._ollama_chat = client.chat

    parsed, meta = extractor._call_bake_llm("knowledge:1", "system", "user")

    assert parsed == {"accepted": False, "reason": "rejected", "payload": None}
    assert client.calls[0]["format"] == BAKE_RESPONSE_SCHEMA
    assert client.calls[0]["options"] == {
        "temperature": 0.0,
        "num_predict": BAKE_NUM_PREDICT,
    }
    assert meta["empty_content"] is False



def test_extract_bake_artifact_marks_empty_content_as_degraded():
    extractor = make_extractor()
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            None,
            {
                "usage": {"prompt_tokens": 10, "completion_tokens": 0},
                "model": "mock-model",
                "raw_content": "",
                "raw_preview": "",
                "response_preview": "{}",
                "empty_content": True,
            },
        ),
        extractor,
    )

    artifact, meta = extractor._extract_bake_artifact(SAMPLE_CANDIDATE, "knowledge", "prompt")

    assert artifact == {
        "accepted": False,
        "reason": "empty_content",
        "payload": None,
    }
    assert meta["degraded"] is True



def test_extract_bake_artifact_marks_missing_payload_as_degraded():
    extractor = make_extractor()
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            {"accepted": True, "reason": None, "payload": None},
            {
                "usage": {"prompt_tokens": 12, "completion_tokens": 8},
                "model": "mock-model",
                "raw_content": '{"accepted": true}',
                "raw_preview": '{"accepted": true}',
                "response_preview": '{"accepted": true}',
                "empty_content": False,
            },
        ),
        extractor,
    )

    artifact, meta = extractor._extract_bake_artifact(SAMPLE_CANDIDATE, "template", "prompt")

    assert artifact == {
        "accepted": False,
        "reason": "accepted_without_payload",
        "payload": None,
    }
    assert meta["degraded"] is True



def test_extract_bake_bundle_uses_one_llm_call_for_three_artifacts():
    extractor = make_extractor()
    response_payload = {
        "knowledge": {
            "accepted": False,
            "reason": "not_a_knowledge",
            "payload": None,
        },
        "design": {
            "accepted": True,
            "reason": None,
            "payload": {"name": "周报模板"},
        },
        "sop": {
            "accepted": False,
            "reason": "not_a_sop",
            "payload": None,
        },
    }
    client = DummyClient(
        {
            "model": "mock-model",
            "message": {"content": json.dumps(response_payload, ensure_ascii=False)},
            "prompt_eval_count": 7,
            "eval_count": 8,
        }
    )
    extractor._ollama_chat = client.chat

    result = extractor.extract_bake_bundle(SAMPLE_CANDIDATE)

    assert len(client.calls) == 1
    assert client.calls[0]["format"] == BAKE_BUNDLE_RESPONSE_SCHEMA
    assert result["knowledge"]["reason"] == "not_a_knowledge"
    assert result["design"]["payload"]["name"] == "周报模板"
    assert result["sop"]["reason"] == "not_a_sop"
    assert result["usage"] == {"prompt_tokens": 7, "completion_tokens": 8}
    assert result["degraded"] is False
    assert set(result["stage_elapsed_ms"]) == {"bundle"}
    assert isinstance(result["total_elapsed_ms"], int)
    assert result["total_elapsed_ms"] >= 0



def test_extract_bake_knowledge_rejects_template_like_candidate_after_llm_accepts():
    extractor = make_extractor()
    payload = {
        "summary": "周报撰写四段式模板骨架",
        "overview": "沉淀背景、进展、风险、下周计划四段式结构。",
        "entities": ["周报", "模板"],
        "importance": 4,
        "occurrence_count": 1,
        "observed_at": 1710000000000,
        "event_time_start": None,
        "event_time_end": None,
        "history_view": False,
        "content_origin": "live_interaction",
        "activity_type": "writing",
        "evidence_strength": "high",
        "evidence_summary": "来源强调模板骨架与槽位复用。",
        "match_score": 0.95,
        "match_level": "high",
        "review_status": "auto_created",
    }
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            {"accepted": True, "reason": None, "payload": payload},
            {
                "usage": {"prompt_tokens": 18, "completion_tokens": 24},
                "model": "mock-model",
                "raw_content": '{"accepted": true}',
                "raw_preview": '{"accepted": true}',
                "response_preview": '{"accepted": true}',
                "empty_content": False,
                "elapsed_ms": 31,
            },
        ),
        extractor,
    )

    artifact, meta = extractor._extract_bake_artifact(TEMPLATE_ONLY_CANDIDATE, "knowledge", "prompt")

    assert artifact == {
        "accepted": False,
        "reason": "template_like_content",
        "payload": None,
    }
    assert meta["degraded"] is False
    assert meta["elapsed_ms"] >= 0



def test_extract_bake_knowledge_rejects_sop_like_candidate_after_llm_accepts():
    extractor = make_extractor()
    sop_candidate = {
        **SAMPLE_CANDIDATE,
        "source_timeline_id": 3,
        "source_capture_id": 30,
        "summary": "启动失败排查步骤",
        "overview": "按步骤排查本地服务启动失败。",
        "details": "先检查 /health，再检查端口监听与日志输出。",
        "activity_type": "coding",
        "entities": ["排查", "步骤", "health"],
    }
    payload = {
        "summary": "启动失败排查步骤",
        "overview": "按步骤检查 health、端口与日志。",
        "entities": ["health", "port"],
        "importance": 4,
        "occurrence_count": 1,
        "observed_at": 1710000000000,
        "event_time_start": None,
        "event_time_end": None,
        "history_view": False,
        "content_origin": "live_interaction",
        "activity_type": "coding",
        "evidence_strength": "high",
        "evidence_summary": "来自一次启动失败排查记录。",
        "match_score": 0.9,
        "match_level": "high",
        "review_status": "auto_created",
    }
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            {"accepted": True, "reason": None, "payload": payload},
            {
                "usage": {"prompt_tokens": 18, "completion_tokens": 24},
                "model": "mock-model",
                "raw_content": '{"accepted": true}',
                "raw_preview": '{"accepted": true}',
                "response_preview": '{"accepted": true}',
                "empty_content": False,
                "elapsed_ms": 31,
            },
        ),
        extractor,
    )

    artifact, meta = extractor._extract_bake_artifact(sop_candidate, "knowledge", "prompt")

    assert artifact == {
        "accepted": False,
        "reason": "sop_like_content",
        "payload": None,
    }
    assert meta["degraded"] is False
    assert meta["elapsed_ms"] >= 0


def test_extract_bake_artifact_accepts_valid_payload():
    extractor = make_extractor()
    payload = {
        "summary": "保留 bake JSON hardening",
        "overview": "确保 sidecar 返回可解析结果。",
        "entities": ["bake", "JSON"],
        "importance": 4,
        "occurrence_count": 1,
        "observed_at": 1710000000000,
        "event_time_start": None,
        "event_time_end": None,
        "history_view": False,
        "content_origin": "live_interaction",
        "activity_type": "coding",
        "evidence_strength": "high",
        "evidence_summary": "多次排查 sidecar 空响应。",
        "match_score": 0.93,
        "match_level": "high",
        "review_status": "auto_created",
    }
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            {"accepted": True, "reason": None, "payload": payload},
            {
                "usage": {"prompt_tokens": 20, "completion_tokens": 40},
                "model": "mock-model",
                "raw_content": '{"accepted": true}',
                "raw_preview": '{"accepted": true}',
                "response_preview": '{"accepted": true}',
                "empty_content": False,
                "elapsed_ms": 44,
            },
        ),
        extractor,
    )

    artifact, meta = extractor._extract_bake_artifact(SAMPLE_CANDIDATE, "knowledge", "prompt")

    assert artifact == {
        "accepted": True,
        "reason": None,
        "payload": payload,
    }
    assert meta["degraded"] is False
    assert meta["model"] == "mock-model"
    assert meta["elapsed_ms"] >= 0



def test_extract_bake_sop_accepts_valid_payload():
    extractor = make_extractor()
    payload = {
        "title": "启动失败排查 SOP",
        "preconditions": ["具备服务日志访问权限"],
        "steps": [
            {"index": 1, "action": "访问 /health", "expected": "返回 200"},
            {"index": 2, "action": "检查端口监听", "expected": "端口处于 LISTEN"},
            {"index": 3, "action": "查看错误日志", "expected": "定位异常堆栈"},
        ],
        "checkpoints": ["health ok", "port ok"],
        "outcome": "定位问题原因并给出修复建议",
    }
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            {"accepted": True, "reason": None, "payload": payload},
            {
                "usage": {"prompt_tokens": 16, "completion_tokens": 28},
                "model": "mock-model",
                "raw_content": '{"accepted": true}',
                "raw_preview": '{"accepted": true}',
                "response_preview": '{"accepted": true}',
                "empty_content": False,
                "elapsed_ms": 33,
            },
        ),
        extractor,
    )

    artifact, meta = extractor._extract_bake_artifact(SAMPLE_CANDIDATE, "sop", "prompt")

    assert artifact == {
        "accepted": True,
        "reason": None,
        "payload": payload,
    }
    assert meta["degraded"] is False
    assert meta["model"] == "mock-model"
    assert meta["elapsed_ms"] >= 0



def test_build_bake_candidate_text_strips_score_metadata_from_details():
    extractor = make_raw_extractor()
    candidate = {
        **SAMPLE_CANDIDATE,
        "details": {
            "summary": "保留语义内容",
            "match_score": 0.95,
            "match_level": "high",
            "review_status": "auto_created",
            "inner": {
                "confidence": "high",
                "facts": "需要保留",
            },
        },
    }

    text = extractor._build_bake_candidate_text(candidate)

    assert "match_score" not in text
    assert "match_level" not in text
    assert "review_status" not in text
    assert "保留语义内容" in text
    assert "需要保留" in text


def test_build_bake_candidate_text_keeps_long_document_capture_beyond_3000_chars():
    extractor = make_raw_extractor()
    long_tail = "长文档尾部关键信息"
    candidate = {
        **SAMPLE_CANDIDATE,
        "capture_ax_text": "正文" * 3500 + long_tail,
        "capture_ocr_text": "",
    }

    text = extractor._build_bake_candidate_text(candidate)

    assert long_tail in text


def test_merge_document_appends_patch_without_rewriting_existing_long_content():
    extractor = make_raw_extractor()
    existing_content = "# 原文\n" + "已有正文。" * 1800
    captured_call = {}

    def call_bake_llm(self, caller_id, system_prompt, user_prompt, response_schema):
        captured_call.update({
            "caller_id": caller_id,
            "system_prompt": system_prompt,
            "user_prompt": user_prompt,
            "response_schema": response_schema,
        })
        return {
            "no_change": False,
            "title": "长文档",
            "summary": "补充了新章节",
            "content_patch": "## 新章节\n这是新增内容。",
            "insert_mode": "append",
            "target_section_index": None,
        }, {}

    extractor._call_bake_llm = types.MethodType(call_bake_llm, extractor)

    result = extractor._merge_with_llm_once(
        {
            "title": "长文档",
            "summary": "旧摘要",
            "full_content": existing_content,
            "sections_json": "[]",
        },
        SAMPLE_CANDIDATE,
        "新 capture 的完整证据",
    )

    assert result["no_change"] is False
    assert result["full_content"].startswith(existing_content)
    assert result["full_content"].endswith("## 新章节\n这是新增内容。")
    assert len(result["full_content"]) > len(existing_content)
    assert "content_patch" in captured_call["response_schema"]["properties"]
    assert "前3000字" not in captured_call["user_prompt"]
    assert "旧正文不在模型侧重写" in captured_call["system_prompt"]


def test_merge_document_rejects_legacy_full_content_that_drops_existing_tail():
    extractor = make_raw_extractor()
    existing_content = "A" * 3000 + "不可丢失的旧正文尾部"
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt, response_schema: (
            {
                "no_change": False,
                "title": "长文档",
                "full_content": existing_content[:3000],
            },
            {},
        ),
        extractor,
    )

    result = extractor._merge_with_llm_once(
        {
            "title": "长文档",
            "full_content": existing_content,
            "sections_json": "[]",
        },
        SAMPLE_CANDIDATE,
        "新 capture",
    )

    assert result == {"title": "长文档", "no_change": True}


def test_merge_document_no_change_keeps_existing_title_when_model_omits_it():
    extractor = make_raw_extractor()
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt, response_schema: (
            {"no_change": True},
            {},
        ),
        extractor,
    )

    result = extractor._merge_with_llm_once(
        {
            "title": "已有文档标题",
            "full_content": "已有正文",
            "sections_json": "[]",
        },
        SAMPLE_CANDIDATE,
        "重复的新 capture",
    )

    assert result == {"no_change": True, "title": "已有文档标题"}



def test_extract_bake_design_downgrades_sop_like_high_score_payload():
    extractor = make_extractor()
    sop_like_candidate = {
        **SAMPLE_CANDIDATE,
        "summary": "启动故障排查步骤",
        "overview": "按步骤执行排查流程",
        "details": "触发条件: 启动失败；前置条件: 有日志；步骤: 检查 health、检查端口、验证结果",
        "entities": ["步骤", "排查", "触发条件"],
    }
    payload = {
        "name": "启动故障排查记录",
        "category": "analysis",
        "status": "active",
        "tags": ["排查"],
        "applicable_tasks": ["creation"],
        "linked_knowledge_ids": [],
        "structure_sections": [{"title": "步骤", "keywords": ["检查"], "notes": "逐条执行"}],
        "style_phrases": ["先检查再验证"],
        "replacement_rules": [],
        "prompt_hint": "按步骤排查",
        "diagram_code": None,
        "image_assets": [],
        "evidence_summary": "原始候选强调流程步骤",
        "match_score": 0.96,
        "match_level": "high",
        "review_status": "auto_created",
    }
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            {"accepted": True, "reason": None, "payload": payload},
            {
                "usage": {"prompt_tokens": 20, "completion_tokens": 22},
                "model": "mock-model",
                "raw_content": '{"accepted": true}',
                "raw_preview": '{"accepted": true}',
                "response_preview": '{"accepted": true}',
                "empty_content": False,
                "elapsed_ms": 18,
            },
        ),
        extractor,
    )

    artifact, _ = extractor._extract_bake_artifact(sop_like_candidate, "design", "prompt")

    assert artifact["accepted"] is True
    assert artifact["payload"]["match_level"] == "low"
    assert artifact["payload"]["review_status"] == "auto_created"
    assert artifact["payload"]["match_score"] <= 0.49



def test_extract_bake_sop_downgrades_template_like_high_score_payload():
    extractor = make_extractor()
    template_like_candidate = {
        **TEMPLATE_ONLY_CANDIDATE,
        "summary": "周报模板结构沉淀",
        "details": "模板骨架包含背景、进展、风险、计划四段；按槽位填写。",
        "entities": ["模板", "骨架", "槽位"],
    }
    payload = {
        "summary": "周报输出 SOP",
        "overview": "执行周报产出流程",
        "source_title": "周报模板实践",
        "trigger_keywords": ["周报", "产出"],
        "extracted_problem": "如何稳定产出周报",
        "steps": ["收集素材", "填充结构", "输出结果"],
        "linked_knowledge_ids": [],
        "confidence": "high",
        "evidence_summary": "候选中出现模板骨架",
        "match_score": 0.94,
        "match_level": "high",
        "review_status": "auto_created",
    }
    extractor._call_bake_llm = types.MethodType(
        lambda self, caller_id, system_prompt, user_prompt: (
            {"accepted": True, "reason": None, "payload": payload},
            {
                "usage": {"prompt_tokens": 20, "completion_tokens": 22},
                "model": "mock-model",
                "raw_content": '{"accepted": true}',
                "raw_preview": '{"accepted": true}',
                "response_preview": '{"accepted": true}',
                "empty_content": False,
                "elapsed_ms": 18,
            },
        ),
        extractor,
    )

    artifact, _ = extractor._extract_bake_artifact(template_like_candidate, "sop", "prompt")

    assert artifact["accepted"] is True
    assert artifact["payload"]["match_level"] == "low"
    assert artifact["payload"]["review_status"] == "auto_created"
    assert artifact["payload"]["match_score"] <= 0.49
