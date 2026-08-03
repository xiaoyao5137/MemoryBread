"""
VlmModel — VLM 编排器（支持后端注入）
"""

from __future__ import annotations

import logging

from .backend  import VlmBackend, VlmOutput
from .minicpm  import MiniCpmVBackend

logger = logging.getLogger(__name__)


class VlmModel:
    """
    VLM 模型编排器。

    默认使用 MiniCPM-V，支持后端注入（用于测试）。
    """

    def __init__(self, backend: Optional[VlmBackend] = None) -> None:
        self._backend = backend or MiniCpmVBackend()

    @classmethod
    def create_default(cls) -> "VlmModel":
        return cls(backend=MiniCpmVBackend())

    def analyze(self, image_path: str, prompt: str = "") -> VlmOutput:
        """
        分析截图。

        Raises:
            FileNotFoundError: 文件不存在
            RuntimeError:      后端不可用
        """
        if not self._backend.is_available():
            raise RuntimeError(
                f"VLM 后端 {self._backend.model_name!r} 不可用"
                "（请确认 transformers / torch 已安装）"
            )
        return self._backend.analyze(image_path, prompt)

    @property
    def model_name(self) -> str:
        return self._backend.model_name
