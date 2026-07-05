from model_api_server import (
    _analyze_floating_assist_intent,
    _build_floating_assist_rag_query,
    _build_floating_assist_rag_query_from_intent,
    _extract_floating_assist_question,
)
from rag.pipeline import _extract_core_retrieval_query


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
