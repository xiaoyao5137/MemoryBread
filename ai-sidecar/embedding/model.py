"""
EmbeddingModel — Embedding 编排器

提供统一的 encode() 接口，封装后端选择逻辑。
支持依赖注入（测试时注入 MockEmbeddingBackend）。
"""

from __future__ import annotations

import logging

from .base import EmbeddingBackend, EmbeddingVector
from .ollama import OllamaEmbeddingBackend

logger = logging.getLogger(__name__)


class EmbeddingModel:
    """
    Embedding 模型编排器。

    默认使用 OllamaEmbeddingBackend（bge-small-zh-v1.5 量化模型），可通过构造函数注入自定义后端。
    """

    def __init__(self, backend: EmbeddingBackend | None = None) -> None:
        self._backend = backend or OllamaEmbeddingBackend()

    # ── 工厂方法 ──────────────────────────────────────────────────────────────

    @classmethod
    def create_default(cls) -> "EmbeddingModel":
        """创建默认配置的 EmbeddingModel（Ollama，量化模型）"""
        return cls(backend=OllamaEmbeddingBackend())

    # ── 公共接口 ──────────────────────────────────────────────────────────────

    def encode(self, texts: list[str]) -> list[EmbeddingVector]:
        """
        将文本列表编码为 Embedding 向量。

        Raises:
            RuntimeError: 后端不可用或编码过程中出现错误
        """
        if not texts:
            return []
        if not self._backend.is_available():
            raise RuntimeError(
                f"Embedding 后端 {self._backend.model_name!r} 不可用"
                "（请确认 sentence-transformers 已安装）"
            )
        return self._backend.encode(texts)

    @property
    def model_name(self) -> str:
        return self._backend.model_name

    @property
    def dimension(self) -> int:
        return self._backend.dimension
