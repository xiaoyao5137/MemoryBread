"""
OpenAI API 兼容后端

兼容所有遵循 OpenAI Chat Completions API 的服务：
- 通义千问（DashScope OpenAI 兼容接口）
- 文心一言（通过 ERNIE API）
- Claude API（通过 aws-bedrock 或直接 API）
- 本地 LiteLLM proxy

不依赖 openai SDK，使用标准库 urllib 保持轻量。
"""

from __future__ import annotations

import json
import logging
import urllib.error
import urllib.request

from .base import LlmBackend, LlmResponse

logger = logging.getLogger(__name__)


class OpenAICompatBackend(LlmBackend):
    """
    OpenAI API 兼容后端（Chat Completions）。

    通过 POST /chat/completions 调用，支持 system prompt 和用户 prompt。
    """

    def __init__(
        self,
        model:    str,
        api_key:  str,
        base_url: str = "https://api.openai.com/v1",
        timeout:  int = 60,
    ) -> None:
        self._model    = model
        self._api_key  = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout  = timeout

    def is_available(self) -> bool:
        """有 API Key 即视为可用（不做网络探测）"""
        return bool(self._api_key)

    def complete(self, prompt: str, system: str = "", **kwargs) -> LlmResponse:
        url  = f"{self._base_url}/chat/completions"
        msgs = []
        if system:
            msgs.append({"role": "system", "content": system})
        msgs.append({"role": "user", "content": prompt})

        body: dict = {"model": self._model, "messages": msgs}
        for key in ("temperature", "max_tokens", "top_p"):
            if key in kwargs:
                body[key] = kwargs[key]

        data = json.dumps(body).encode("utf-8")
        req  = urllib.request.Request(
            url,
            data    = data,
            headers = {
                "Content-Type":  "application/json",
                "Authorization": f"Bearer {self._api_key}",
            },
            method  = "POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"OpenAI API 请求失败: {exc}") from exc

        choice = result["choices"][0]
        text   = choice["message"]["content"]
        tokens = result.get("usage", {}).get("total_tokens", 0)
        return LlmResponse(text=text, model=self._model, tokens=tokens, done_reason=choice.get("finish_reason"))

    @property
    def model_name(self) -> str:
        return self._model
