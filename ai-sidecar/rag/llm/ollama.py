"""
Ollama 本地 LLM 后端

通过 Ollama HTTP API（localhost:11434）调用本地模型，
默认模型：qwen2.5:7b。不依赖任何 Python SDK，使用标准库 urllib。
"""

from __future__ import annotations

import json
import logging
import urllib.request
import urllib.error

from .base import LlmBackend, LlmResponse

logger = logging.getLogger(__name__)


class OllamaBackend(LlmBackend):
    """Ollama 本地 LLM 后端（通过 /api/generate 非流式调用）"""

    def __init__(
        self,
        model:       str = "qwen2.5:7b",
        base_url:    str = "http://localhost:11434",
        timeout:     int = 60,
        num_predict: int = 1024,
    ) -> None:
        self._model       = model
        self._base_url    = base_url.rstrip("/")
        self._timeout     = timeout
        self._num_predict = num_predict

    def is_available(self) -> bool:
        """检查 Ollama 服务是否运行（访问 /api/tags 端点）"""
        try:
            req = urllib.request.Request(
                f"{self._base_url}/api/tags",
                method="GET",
            )
            with urllib.request.urlopen(req, timeout=2) as resp:
                return resp.status == 200
        except Exception:
            return False

    def complete(self, prompt: str, system: str = "", **kwargs) -> LlmResponse:
        url = f"{self._base_url}/api/generate"
        body: dict = {
            "model":       self._model,
            "prompt":      prompt,
            "stream":      False,
            "num_predict": kwargs.pop("num_predict", self._num_predict),
            # keep_alive=10m：请求完成后模型在内存中保留 10 分钟，
            # 避免频繁调用时 Ollama 反复加载/卸载模型（默认 5 分钟太短）。
            # 对于 RAG 查询 + 时间线提炼交替使用的场景，10 分钟可以覆盖大部分间隔。
            "keep_alive":  "10m",
        }
        if system:
            body["system"] = system
        # 透传支持的模型参数
        for key in ("temperature", "top_p", "seed"):
            if key in kwargs:
                body[key] = kwargs[key]

        data = json.dumps(body).encode("utf-8")
        req  = urllib.request.Request(
            url,
            data    = data,
            headers = {"Content-Type": "application/json"},
            method  = "POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=self._timeout) as resp:
                result = json.loads(resp.read().decode("utf-8"))
        except urllib.error.URLError as exc:
            raise RuntimeError(f"Ollama 服务不可达: {exc}") from exc

        return LlmResponse(
            text   = result.get("response", ""),
            model  = result.get("model", self._model),
            tokens = result.get("eval_count", 0),
        )

    @property
    def model_name(self) -> str:
        return self._model
