"""
IPC Embed 任务处理器

处理来自 core-engine 的 Embedding 请求
"""

from __future__ import annotations

import logging
from typing import Dict, Any
from .embedding import get_embedding_service
from .qdrant_manager import QdrantManager

logger = logging.getLogger(__name__)


class EmbedTaskHandler:
    """Embed 任务处理器"""
    
    def __init__(self, qdrant_manager: QdrantManager):
        """
        初始化处理器
        
        Args:
            qdrant_manager: Qdrant 管理器
        """
        self.qdrant = qdrant_manager
        self.embedding_service = get_embedding_service()
        logger.info("初始化 EmbedTaskHandler")
    
    def handle(self, task_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        处理 Embed 任务
        
        Args:
            task_data: 任务数据，包含 capture_id 和 texts
            
        Returns:
            结果字典，包含 vectors
        """
        capture_id = task_data.get("capture_id")
        texts = task_data.get("texts", [])
        
        if not texts:
            logger.warning(f"Embed 任务文本为空: capture_id={capture_id}")
            return {"vectors": []}
        
        logger.info(f"处理 Embed 任务: capture_id={capture_id}, texts={len(texts)}")
        
        try:
            # 1. 文本向量化
            vectors = self.embedding_service.encode(texts)
            
            # 2. 写入 Qdrant
            # 注意：point_id 由 core-engine 生成并存储在 vector_index 表中
            # 这里我们需要从 task_data 中获取 point_id，或者返回向量让 core-engine 处理
            
            # 为了简化，我们直接返回向量，由 core-engine 负责写入 Qdrant
            # 但更好的做法是在这里直接写入 Qdrant
            
            # 如果 task_data 包含 point_id 和其他元数据，我们可以直接写入
            point_id = task_data.get("point_id")
            if point_id and len(vectors) > 0:
                payload = {
                    "capture_id": capture_id,
                    "text": texts[0],  # 假设只有一个文本
                    "timestamp": task_data.get("timestamp"),
                    "app_name": task_data.get("app_name"),
                }
                
                success = self.qdrant.insert_vector(
                    point_id=point_id,
                    vector=vectors[0],
                    payload=payload,
                )
                
                if success:
                    logger.info(f"向量已写入 Qdrant: {point_id}")
                else:
                    logger.error(f"向量写入 Qdrant 失败: {point_id}")
            
            return {"vectors": vectors}
        
        except Exception as e:
            logger.error(f"Embed 任务处理失败: {e}", exc_info=True)
            raise
