"""
LLM 后端抽象接口
"""

from __future__ import annotations

from abc         import ABC, abstractmethod
from dataclasses import dataclass, field


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

    @property
    @abstractmethod
    def model_name(self) -> str:
        """模型标识符"""
