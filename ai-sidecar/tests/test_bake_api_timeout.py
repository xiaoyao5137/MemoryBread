from __future__ import annotations

import concurrent.futures

import model_api_server
from knowledge.extractor_v2 import BakeOutputTruncatedError


class _TimeoutQueue:
    def __init__(self):
        self.timeout = None

    def submit_sync(self, *_args, **kwargs):
        self.timeout = kwargs.get("timeout")
        raise concurrent.futures.TimeoutError


class _Extractor:
    def __init__(self, prompt_tokens):
        self.prompt_tokens = prompt_tokens

    def estimate_bake_bundle_prompt_tokens(self, _candidate):
        return self.prompt_tokens

    def estimate_merge_document_prompt_tokens(self, _existing_document, _candidate):
        return self.prompt_tokens


def test_bake_extract_timeout_is_terminal(monkeypatch):
    queue = _TimeoutQueue()
    monkeypatch.setattr(model_api_server, "get_global_queue", lambda: queue)
    monkeypatch.setattr(model_api_server, "get_bake_extractor", lambda: _Extractor(12_000))

    response = model_api_server.app.test_client().post(
        "/bake/extract",
        json={"candidate": {"source_timeline_id": 42}},
    )

    assert response.status_code == 504
    assert response.get_json() == {
        "error": "bake 提炼超时，任务已取消",
        "code": "INFERENCE_TIMEOUT",
        "retryable": False,
    }
    assert queue.timeout == 180.0


def test_bake_extract_truncated_output_is_structured_and_terminal(monkeypatch):
    class _TruncatedQueue:
        def submit_sync(self, *_args, **_kwargs):
            raise BakeOutputTruncatedError(
                "bake bundle output invalid: truncated_json"
            )

    monkeypatch.setattr(model_api_server, "get_global_queue", _TruncatedQueue)
    monkeypatch.setattr(model_api_server, "get_bake_extractor", lambda: _Extractor(24_000))

    response = model_api_server.app.test_client().post(
        "/bake/extract",
        json={"candidate": {"source_timeline_id": 42}},
    )

    assert response.status_code == 422
    assert response.get_json() == {
        "error": "bake bundle output invalid: truncated_json",
        "code": "BAKE_OUTPUT_TRUNCATED",
        "retryable": False,
    }


def test_bake_document_merge_timeout_is_terminal(monkeypatch):
    queue = _TimeoutQueue()
    monkeypatch.setattr(model_api_server, "get_global_queue", lambda: queue)
    monkeypatch.setattr(model_api_server, "get_bake_extractor", lambda: _Extractor(24_000))

    response = model_api_server.app.test_client().post(
        "/bake/merge_document",
        json={
            "existing_document": {"title": "existing"},
            "candidate": {"source_timeline_id": 42},
        },
    )

    assert response.status_code == 504
    assert response.get_json() == {
        "error": "bake 文档合并超时，任务已取消",
        "code": "INFERENCE_TIMEOUT",
        "retryable": False,
    }
    assert queue.timeout == 300.0


def test_bake_timeout_budget_uses_prompt_size():
    assert model_api_server.bake_inference_timeout_seconds(19_999) == 180.0
    assert model_api_server.bake_inference_timeout_seconds(20_000) == 300.0
