"""
LLM 后端抽象接口
"""

from __future__ import annotations

from abc         import ABC, abstractmethod
from dataclasses import dataclass
from typing import Callable


@dataclass
class LlmResponse:
    """LLM 单次推理响应"""
    text:   str
    model:  str
    tokens: int = 0
    done_reason: str | None = None


class LlmBackend(ABC):
    """所有 LLM 后端必须实现的接口"""

    @abstractmethod
    def is_available(self) -> bool:
        """后端当前是否可用（网络可达 / 凭据有效）"""

    @abstractmethod
    def complete(self, prompt: str, system: str = "", **kwargs) -> LlmResponse:
        """
        发送 prompt 并获取 LLM 响应。

        Args:
            prompt: 用户 prompt（已组装好上下文）
            system: System prompt（可选）
            **kwargs: 模型参数（如 temperature, max_tokens）
        """

    def complete_stream(
        self,
        prompt: str,
        system: str = "",
        on_delta: Callable[[str], None] | None = None,
        **kwargs,
    ) -> LlmResponse:
        """流式完成推理。

        未提供原生流能力的后端仍可复用非流式实现；调用方因此可以只维护一套
        SSE 编排逻辑，同时让支持流式传输的后端尽快输出首段内容。
        """
        response = self.complete(prompt, system=system, **kwargs)
        if on_delta and response.text:
            on_delta(response.text)
        return response

    @property
    @abstractmethod
    def model_name(self) -> str:
        """模型标识符"""
