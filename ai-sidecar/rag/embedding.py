"""
Embedding 向量化服务

使用 Ollama API 调用 bge-small-zh-v1.5 模型将文本转换为向量。
已从本地 sentence-transformers (BGE-M3) 迁移到 Ollama API，
消除 PyTorch 本地加载带来的 ~1GB 内存开销。
"""

import logging
from typing import List

logger = logging.getLogger(__name__)


class EmbeddingService:
    """文本向量化服务（基于 Ollama API）"""

    def __init__(self, model_name: str = "qllama/bge-small-zh-v1.5:q4_k_m"):
        """
        初始化 Embedding 服务

        Args:
            model_name: Ollama 模型名称，默认使用 bge-small-zh-v1.5 量化版
        """
        self.model_name = model_name
        self._model = None
        logger.info(f"初始化 EmbeddingService，模型: {model_name}")

    def load_model(self):
        """延迟加载模型（首次调用时创建 OllamaEmbeddingBackend）"""
        if self._model is None:
            from embedding.ollama import OllamaEmbeddingBackend
            logger.info(f"正在初始化 Ollama Embedding 后端: {self.model_name}")
            self._model = OllamaEmbeddingBackend(model_name=self.model_name)
            logger.info("Ollama Embedding 后端就绪")

    def encode(self, texts: List[str]) -> List[List[float]]:
        """
        将文本列表转换为向量

        Args:
            texts: 文本列表

        Returns:
            向量列表，每个向量是一个浮点数列表
        """
        self.load_model()

        if not texts:
            return []

        logger.debug(f"正在向量化 {len(texts)} 条文本")
        results = self._model.encode(texts)
        vectors = [vec.vector for vec in results]

        if vectors:
            logger.debug(f"向量化完成，维度: {len(vectors[0])}")
        return vectors

    def encode_single(self, text: str) -> List[float]:
        """
        向量化单个文本

        Args:
            text: 单个文本

        Returns:
            向量（浮点数列表）
        """
        vectors = self.encode([text])
        return vectors[0] if vectors else []


# 全局单例
_embedding_service = None


def get_embedding_service() -> EmbeddingService:
    """获取全局 Embedding 服务单例"""
    global _embedding_service
    if _embedding_service is None:
        _embedding_service = EmbeddingService()
    return _embedding_service
