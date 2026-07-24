"""
Ollama 本地 LLM 后端

通过 Ollama HTTP API（localhost:11434）调用本地模型，
默认模型：qwen2.5:7b。不依赖任何 Python SDK，使用标准库 urllib。
"""

from __future__ import annotations

import json
import http.client
import logging
import urllib.request
import urllib.error
import urllib.parse
from typing import Callable

from inference_queue import (
    current_task_preempt_requested,
    raise_if_preempted,
    register_current_preempt_callback,
)

from .base import LlmBackend, LlmResponse

logger = logging.getLogger(__name__)


class OllamaBackend(LlmBackend):
    """Ollama 本地 LLM 后端（通过 /api/generate 调用）"""

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
        # 即使调用方不消费增量，也使用流式传输。这样 P0 到达时可以关闭
        # 正在运行的后台 HTTP 响应，而不必等待整段非流式推理完成。
        return self.complete_stream(
            prompt,
            system=system,
            on_delta=None,
            **kwargs,
        )

    def complete_stream(
        self,
        prompt: str,
        system: str = "",
        on_delta: Callable[[str], None] | None = None,
        **kwargs,
    ) -> LlmResponse:
        raise_if_preempted()
        url = f"{self._base_url}/api/generate"
        options = {
            "num_predict": kwargs.pop("num_predict", self._num_predict),
        }
        for key in ("temperature", "top_p", "seed"):
            if key in kwargs:
                options[key] = kwargs[key]

        body: dict = {
            "model": self._model,
            "prompt": prompt,
            "stream": True,
            "options": options,
            "think": False,
            "keep_alive": "10m",
        }
        if system:
            body["system"] = system

        parts: list[str] = []
        model = self._model
        tokens = 0
        done_reason = None
        parsed_url = urllib.parse.urlparse(url)
        connection_class = (
            http.client.HTTPSConnection
            if parsed_url.scheme == "https"
            else http.client.HTTPConnection
        )
        connection = connection_class(
            parsed_url.hostname,
            parsed_url.port,
            timeout=self._timeout,
        )
        unregister = register_current_preempt_callback(connection.close)
        try:
            connection.request(
                "POST",
                parsed_url.path or "/api/generate",
                body=json.dumps(body).encode("utf-8"),
                headers={"Content-Type": "application/json"},
            )
            response = connection.getresponse()
            if response.status >= 400:
                detail = response.read().decode("utf-8", errors="replace")
                raise RuntimeError(
                    f"Ollama 请求失败 ({response.status}): {detail[:500]}"
                )
            for raw_line in response:
                raise_if_preempted()
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                payload = json.loads(line)
                delta = payload.get("response", "")
                if delta:
                    parts.append(delta)
                    if on_delta:
                        on_delta(delta)
                model = payload.get("model", model)
                if payload.get("done"):
                    tokens = payload.get("eval_count", 0)
                    done_reason = payload.get("done_reason") or payload.get("finish_reason")
            raise_if_preempted()
        except (OSError, TimeoutError, http.client.HTTPException) as exc:
            if current_task_preempt_requested():
                raise_if_preempted()
            raise RuntimeError(f"Ollama 服务不可达: {exc}") from exc
        except Exception:
            if current_task_preempt_requested():
                raise_if_preempted()
            raise
        finally:
            unregister()
            connection.close()

        if not done_reason and tokens >= int(options.get("num_predict", 0) or 0):
            done_reason = "length"
        return LlmResponse(
            text="".join(parts),
            model=model,
            tokens=tokens,
            done_reason=done_reason,
        )

    @property
    def model_name(self) -> str:
        return self._model
