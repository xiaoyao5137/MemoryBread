from __future__ import annotations

import ssl
import urllib.error

from rag.llm.cloud import CloudChatBackend


class _JsonResponse:
    def __init__(self, body: bytes) -> None:
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self) -> bytes:
        return self._body


def _ssl_eof_error() -> urllib.error.URLError:
    return urllib.error.URLError(
        ssl.SSLEOFError(
            8,
            "[SSL: UNEXPECTED_EOF_WHILE_READING] EOF occurred in violation of protocol (_ssl.c:1081)",
        )
    )


def test_cloud_backend_retries_ssl_eof_and_succeeds(monkeypatch):
    calls = {"count": 0}

    def fake_urlopen(req, timeout=0):
        calls["count"] += 1
        if calls["count"] == 1:
            raise _ssl_eof_error()
        return _JsonResponse(
            b'{"model":"qwen-plus","choices":[{"message":{"content":"ok"}}],"usage":{"completion_tokens":3}}'
        )

    monkeypatch.setattr("rag.llm.cloud.urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr("rag.llm.cloud.time.sleep", lambda _: None)

    backend = CloudChatBackend(model="qwen-plus", api_key="test-key", retries=2)
    result = backend.complete("hello", "system")

    assert result.text == "ok"
    assert result.tokens == 3
    assert calls["count"] == 2


def test_cloud_backend_reports_friendly_network_error_after_retries(monkeypatch):
    calls = {"count": 0}

    def fake_urlopen(req, timeout=0):
        calls["count"] += 1
        raise _ssl_eof_error()

    monkeypatch.setattr("rag.llm.cloud.urllib.request.urlopen", fake_urlopen)
    monkeypatch.setattr("rag.llm.cloud.time.sleep", lambda _: None)

    backend = CloudChatBackend(model="qwen-plus", api_key="test-key", retries=2)

    try:
        backend.complete("hello")
        assert False, "expected RuntimeError"
    except RuntimeError as exc:
        message = str(exc)

    assert calls["count"] == 3
    assert "云端模型服务不可达" in message
    assert "网络或 TLS 连接被中断" in message
    assert "base_url" in message
    assert "urlopen error" not in message
