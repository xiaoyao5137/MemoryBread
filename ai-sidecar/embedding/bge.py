"""
BAAI/bge-m3 Embedding 后端

使用 sentence-transformers 库懒加载 bge-m3 模型。
bge-m3 输出 1024 维向量，支持中英文混合语义检索。
"""

from __future__ import annotations

import logging

from .base import EmbeddingBackend, EmbeddingVector

logger = logging.getLogger(__name__)

_DEFAULT_MODEL     = "BAAI/bge-m3"
_DEFAULT_DIMENSION = 1024

# 全局单例，避免重复加载模型
_global_model_instance = None
_global_model_lock = __import__('threading').Lock()


class BgeM3Backend(EmbeddingBackend):
    """
    BAAI/bge-m3 Embedding 后端。

    使用全局单例模式，避免重复加载模型。
    """

    def __init__(
        self,
        model_name: str = _DEFAULT_MODEL,
        device:     str | None = None,
    ) -> None:
        self._model_name = model_name
        self._device     = device or self._auto_detect_device()

    # ── 接口实现 ──────────────────────────────────────────────────────────────

    def is_available(self) -> bool:
        try:
            import sentence_transformers  # type: ignore  # noqa: F401
            return True
        except ImportError:
            return False

    def encode(self, texts: list[str]) -> list[EmbeddingVector]:
        if not texts:
            return []
        self._ensure_loaded()
        import numpy as np  # type: ignore
        global _global_model_instance
        embeddings = _global_model_instance.encode(  # type: ignore[union-attr]
            texts,
            normalize_embeddings=True,
            show_progress_bar=False,
        )
        return [
            EmbeddingVector(text=t, vector=e.tolist() if hasattr(e, "tolist") else list(e))
            for t, e in zip(texts, embeddings)
        ]

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def dimension(self) -> int:
        global _global_model_instance
        if _global_model_instance is not None:
            dim = _global_model_instance.get_sentence_embedding_dimension()  # type: ignore[union-attr]
            return dim if dim is not None else _DEFAULT_DIMENSION
        return _DEFAULT_DIMENSION

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _auto_detect_device(self) -> str:
        """自动检测可用设备：MPS > CUDA > CPU"""
        try:
            import torch
            if torch.backends.mps.is_available():
                return "mps"
            if torch.cuda.is_available():
                return "cuda"
        except Exception:
            pass
        return "cpu"

    def _ensure_loaded(self) -> None:
        global _global_model_instance, _global_model_lock
        if _global_model_instance is None:
            with _global_model_lock:
                if _global_model_instance is None:
                    from sentence_transformers import SentenceTransformer  # type: ignore
                    logger.info("正在加载 Embedding 模型: %s (device=%s)", self._model_name, self._device)
                    _global_model_instance = SentenceTransformer(self._model_name, device=self._device)
                    logger.info("Embedding 模型加载完成，维度: %d", self.dimension)
