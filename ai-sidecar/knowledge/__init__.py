"""
知识库模块 - 使用 Qwen3.5-4B 提炼 OCR 文本为结构化知识
"""

from __future__ import annotations

from .extractor import KnowledgeExtractor
from .manager import KnowledgeManager

# API 模块可选导入（需要 FastAPI）
try:
    from .api import app as knowledge_api
    __all__ = ['KnowledgeExtractor', 'KnowledgeManager', 'knowledge_api']
except ImportError:
    __all__ = ['KnowledgeExtractor', 'KnowledgeManager']
