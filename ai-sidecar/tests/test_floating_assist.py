import json

import model_api_server
from model_api_server import (
    _analyze_floating_assist_intent,
    _build_floating_assist_rag_query,
    _build_floating_assist_rag_query_from_intent,
    _extract_floating_assist_question,
)
from rag.pipeline import _extract_core_retrieval_query
from rag.pipeline import RagResult
from rag.retriever import RetrievedChunk


class FakeIntentLlm:
    model_name = "fake-intent"

    def __init__(self, response: str):
        self.response = response
        self.last_prompt = ""
        self.last_system = ""
        self.last_kwargs = {}

    def is_available(self):
        return True

    def complete(self, prompt: str, system: str = "", **kwargs):
        from rag.llm.base import LlmResponse

        self.last_prompt = prompt
        self.last_system = system
        self.last_kwargs = kwargs
        return LlmResponse(text=self.response, model=self.model_name, tokens=12)


def test_floating_assist_question_ignores_bare_url_with_query_string():
    ocr_text = "\n".join(
        [
            "docs.corp.kuaishou.com/k/home/page?ro=false#section=h.s1",
            "Loop Engineering 怎么落地到 Top5 任务？",
        ]
    )

    assert _extract_floating_assist_question(ocr_text) == "Loop Engineering 怎么落地到 Top5 任务？"


def test_floating_assist_rag_query_does_not_use_url_as_core_question():
    raw_query = "你是记忆面包的工作场景助手。\n当前屏幕 OCR：\ndocs.corp.kuaishou.com/k/home/page?ro=false#section=h.s1"
    metadata = {"source": "floating_assist"}

    assert _build_floating_assist_rag_query(raw_query, metadata) == raw_query


def test_floating_assist_model_intent_understands_ocr_before_rag_query():
    llm = FakeIntentLlm(
        """
        {
          "core_question": "Loop Engineering 怎么落地到 Top5 任务？",
          "retrieval_query": "Loop Engineering Top5 任务 自动化闭环 Token 预算",
          "screen_context_summary": "屏幕展示的是关于从人 Prompt Agent 升级到自动化 Loop 的执行建议。",
          "answer_requirements": ["给出落地路径", "覆盖 Token 预算", "不要反问"],
          "needs_rag": true,
          "confidence": 0.86
        }
        """
    )
    raw_query = "你是记忆面包的工作场景助手。\n当前屏幕 OCR：\ndocs.corp.kuaishou.com/k/home/page?ro=false\nLoop Engineering 怎么落地？"

    intent = _analyze_floating_assist_intent(raw_query, {"source": "floating_assist"}, llm)
    rag_query = _build_floating_assist_rag_query_from_intent(raw_query, intent)

    assert intent.source == "model"
    assert intent.confidence == 0.86
    assert llm.last_kwargs["num_predict"] == 384
    assert "屏幕 OCR" in llm.last_prompt
    assert "核心问题：Loop Engineering 怎么落地到 Top5 任务？" in rag_query
    assert "检索问题：Loop Engineering Top5 任务 自动化闭环 Token 预算" in rag_query
    assert "屏幕理解：屏幕展示的是关于从人 Prompt Agent 升级到自动化 Loop 的执行建议。" in rag_query
    assert _extract_core_retrieval_query(rag_query) == "Loop Engineering Top5 任务 自动化闭环 Token 预算"


def test_rag_stream_sends_references_before_answer_and_finishes_with_elapsed(monkeypatch):
    chunk = RetrievedChunk(
        capture_id=1,
        doc_key="document:1",
        text="提前召回资料",
        score=0.9,
        source="document",
        metadata={"source_type": "document", "title": "资料一"},
    )

    calls: list[str] = []

    class FakePipeline:
        def query(
            self,
            query,
            top_k=None,
            llm=None,
            references_only=False,
            on_contexts=None,
            on_delta=None,
        ):
            if references_only:
                calls.append("retrieve")
                return RagResult(answer="", contexts=[chunk], model="references-only")
            calls.append("generate")
            on_contexts([chunk])
            on_delta("部分")
            on_delta("答案")
            return RagResult(answer="部分答案", contexts=[chunk], model="internal-model")

        def _build_context(self, contexts):
            return "context"

    class InlineQueue:
        def submit_sync(self, priority, func, timeout=None, lane=None):
            calls.append("queue")
            assert calls == ["retrieve", "queue"]
            return func()

    monkeypatch.setattr(model_api_server, "_rag_pipeline", FakePipeline())
    monkeypatch.setattr(model_api_server, "get_global_queue", lambda: InlineQueue())
    monkeypatch.setattr(model_api_server, "_build_rag_llm_override", lambda *args, **kwargs: None)
    monkeypatch.setattr(model_api_server, "_save_rag_session", lambda *args, **kwargs: 1)
    monkeypatch.setattr(model_api_server, "log_llm_usage", lambda *args, **kwargs: None)
    monkeypatch.setattr("model_registry_global.check_memory_pressure", lambda: "normal")

    response = model_api_server.app.test_client().post(
        "/query/stream",
        json={"query": "测试问题", "top_k": 5, "source": "monitor"},
        buffered=True,
    )
    events = [
        json.loads(line[6:])
        for line in response.get_data(as_text=True).splitlines()
        if line.startswith("data: ")
    ]
    types = [event["type"] for event in events]

    assert response.status_code == 200
    assert types.index("references") < types.index("delta")
    statuses = [event["stage"] for event in events if event["type"] == "status"]
    assert statuses == ["queued", "retrieving", "waiting_generation", "answering"]
    assert calls == ["retrieve", "queue", "generate"]
    assert [event["text"] for event in events if event["type"] == "delta"] == ["部分", "答案"]
    done = next(event for event in events if event["type"] == "done")
    assert done["answer"] == "部分答案"
    assert done["model"] == "mbcd-std-v1"
    assert done["elapsed_ms"] >= 0
    assert done["inference_elapsed_ms"] >= 0
