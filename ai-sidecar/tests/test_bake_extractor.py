from __future__ import annotations

import types

from knowledge.extractor_v2 import BAKE_RESPONSE_SCHEMA, KnowledgeExtractorV2, _extract_json_object, _extract_ollama_response_text


class MessageLike:
    def __init__(self, content: str = "", thinking: str = ""):
        self.content = content
        self.thinking = thinking


class ResponseLike:
    def __init__(self, message):
        self.message = message




SAMPLE_CANDIDATE = {
    "source_knowledge_id": 1,
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
    "source_knowledge_id": 2,
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
    extractor.client = DummyClient(
        {
            "model": "mock-model",
            "message": {"content": '{"accepted": false, "reason": "rejected", "payload": null}'},
            "prompt_eval_count": 10,
            "eval_count": 8,
        }
    )

    parsed, meta = extractor._call_bake_llm("knowledge:1", "system", "user")

    assert parsed == {"accepted": False, "reason": "rejected", "payload": None}
    assert extractor.client.calls[0]["think"] is False
    assert extractor.client.calls[0]["format"] == BAKE_RESPONSE_SCHEMA
    assert extractor.client.calls[0]["options"] == {"temperature": 0.0, "num_predict": 1024}
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



def test_extract_bake_bundle_returns_stage_timing_metadata():
    extractor = make_extractor()
    extractor.extract_bake_knowledge = types.MethodType(
        lambda self, candidate: (
            {"accepted": False, "reason": "not_a_knowledge", "payload": None},
            {"usage": {"prompt_tokens": 1, "completion_tokens": 2}, "model": "mock-model", "degraded": False, "elapsed_ms": 11},
        ),
        extractor,
    )
    extractor.extract_bake_template = types.MethodType(
        lambda self, candidate: (
            {"accepted": True, "reason": None, "payload": {"name": "周报模板"}},
            {"usage": {"prompt_tokens": 3, "completion_tokens": 4}, "model": "mock-model", "degraded": False, "elapsed_ms": 22},
        ),
        extractor,
    )
    extractor.extract_bake_sop = types.MethodType(
        lambda self, candidate: (
            {"accepted": False, "reason": "not_a_sop", "payload": None},
            {"usage": {"prompt_tokens": 5, "completion_tokens": 6}, "model": "mock-model", "degraded": True, "elapsed_ms": 33},
        ),
        extractor,
    )

    result = extractor.extract_bake_bundle(SAMPLE_CANDIDATE)

    assert result["usage"] == {"prompt_tokens": 9, "completion_tokens": 12}
    assert result["degraded"] is True
    assert result["stage_elapsed_ms"] == {"knowledge": 11, "template": 22, "sop": 33}
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
        "source_knowledge_id": 3,
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


