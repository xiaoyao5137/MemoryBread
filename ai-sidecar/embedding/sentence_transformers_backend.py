"""
SentenceTransformers Embedding 后端

当 Ollama 不可用时（如 Ollama 0.30.x 移除 llama-server 导致 GGUF 模型失效），
使用 sentence-transformers 直接在进程内加载模型，作为 fallback。
"""

from __future__ import annotations

import logging
from .base import EmbeddingBackend, EmbeddingVector

logger = logging.getLogger(__name__)

_DEFAULT_MODEL = "BAAI/bge-small-zh-v1.5"
_DEFAULT_DIMENSION = 512


class SentenceTransformersBackend(EmbeddingBackend):
    """sentence-transformers 本地推理后端（无需 Ollama）"""

    def __init__(self, model_name: str = _DEFAULT_MODEL) -> None:
        self._model_name = model_name
        self._model = None

    def is_available(self) -> bool:
        try:
            import sentence_transformers  # noqa: F401
            return True
        except ImportError:
            return False

    def _load(self):
        if self._model is None:
            from sentence_transformers import SentenceTransformer
            logger.info("加载本地 embedding 模型: %s", self._model_name)
            self._model = SentenceTransformer(self._model_name)
        return self._model

    def encode(self, texts: list[str]) -> list[EmbeddingVector]:
        valid = [t for t in texts if t and t.strip()]
        if not valid:
            return []
        model = self._load()
        vecs = model.encode(valid, normalize_embeddings=True).tolist()
        return [EmbeddingVector(text=t, vector=v) for t, v in zip(valid, vecs)]

    @property
    def model_name(self) -> str:
        return self._model_name

    @property
    def dimension(self) -> int:
        return _DEFAULT_DIMENSION
