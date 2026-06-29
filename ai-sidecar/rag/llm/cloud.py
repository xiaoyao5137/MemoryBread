"""
OpenAI-compatible and Anthropic cloud LLM backend for RAG.
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .base import LlmBackend, LlmResponse


class CloudChatBackend(LlmBackend):
    """Synchronous non-streaming backend used by RAG jobs."""

    def __init__(self, model: str, api_key: str, base_url: str = "", timeout: int = 300) -> None:
        self._model = model
        self._api_key = api_key
        self._base_url = (base_url or "").rstrip("/")
        self._timeout = timeout

    @property
    def model_name(self) -> str:
        return self._model

    def is_available(self) -> bool:
        return bool(self._model and self._api_key)

    def complete(self, prompt: str, system: str = "", **kwargs) -> LlmResponse:
        if "claude" in self._model.lower() or "anthropic.com" in self._base_url:
            return self._complete_anthropic(prompt, system, **kwargs)
        return self._complete_openai_compatible(prompt, system, **kwargs)

    def _complete_openai_compatible(self, prompt: str, system: str = "", **kwargs) -> LlmResponse:
        base_url = self._base_url or self._default_base_url()
        url = f"{base_url.rstrip('/')}/chat/completions"
        payload = {
            "model": self._model,
            "stream": False,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": prompt},
            ],
            "temperature": kwargs.get("temperature", 0.5),
            "top_p": kwargs.get("top_p", 0.9),
            "max_tokens": kwargs.get("num_predict", 1536),
        }
        data = self._post_json(
            url,
            payload,
            {
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
        )
        choice = (data.get("choices") or [{}])[0]
        message = choice.get("message") or {}
        usage = data.get("usage") or {}
        return LlmResponse(
            text=message.get("content", ""),
            model=data.get("model", self._model),
            tokens=usage.get("completion_tokens", 0),
        )

    def _complete_anthropic(self, prompt: str, system: str = "", **kwargs) -> LlmResponse:
        url = self._anthropic_messages_url(self._base_url)
        payload = {
            "model": self._model,
            "max_tokens": kwargs.get("num_predict", 1536),
            "system": system,
            "messages": [{"role": "user", "content": prompt}],
        }
        data = self._post_json(
            url,
            payload,
            {
                "x-api-key": self._api_key,
                "anthropic-version": "2023-06-01",
                "Content-Type": "application/json",
            },
        )
        parts = data.get("content") or []
        text = "".join(part.get("text", "") for part in parts if part.get("type") == "text")
        usage = data.get("usage") or {}
        return LlmResponse(
            text=text,
            model=data.get("model", self._model),
            tokens=usage.get("output_tokens", 0),
        )

    def _post_json(self, url: str, payload: dict, headers: dict) -> dict:
        req = urllib.request.Request(
            url,
            data=json.dumps(payload).encode("utf-8"),
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            body = exc.read().decode("utf-8", errors="replace")
            raise RuntimeError(f"云端模型请求失败 HTTP {exc.code}: {body}") from exc
        except urllib.error.URLError as exc:
            raise RuntimeError(f"云端模型服务不可达: {exc}") from exc

    def _default_base_url(self) -> str:
        lower = self._model.lower()
        if "qwen" in lower:
            return "https://dashscope.aliyuncs.com/compatible-mode/v1"
        if "glm" in lower:
            return "https://open.bigmodel.cn/api/paas/v4"
        if "moonshot" in lower or "kimi" in lower:
            return "https://api.moonshot.cn/v1"
        return "https://api.openai.com/v1"

    @staticmethod
    def _anthropic_messages_url(base_url: str) -> str:
        base = (base_url or "https://api.anthropic.com").rstrip("/")
        if base.endswith("/messages"):
            return base
        if base.endswith("/v1"):
            return f"{base}/messages"
        return f"{base}/v1/messages"
