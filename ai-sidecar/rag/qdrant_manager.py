"""
Qdrant 向量库管理

负责向量的存储、检索和管理
"""

from __future__ import annotations

import logging
import uuid
from typing import List, Optional, Dict, Any
from qdrant_client import QdrantClient
from qdrant_client.models import (
    Distance,
    VectorParams,
    PointStruct,
    Filter,
    FieldCondition,
    MatchValue,
)

logger = logging.getLogger(__name__)


class QdrantManager:
    """Qdrant 向量库管理器"""
    
    def __init__(
        self,
        host: str = "localhost",
        port: int = 6333,
        collection_name: str = "memory_bread_captures",
        vector_size: int = 512,  # bge-small-zh-v1.5 的向量维度
    ):
        """
        初始化 Qdrant 管理器
        
        Args:
            host: Qdrant 服务地址
            port: Qdrant 服务端口
            collection_name: 集合名称
            vector_size: 向量维度
        """
        self.host = host
        self.port = port
        self.collection_name = collection_name
        self.vector_size = vector_size
        self.client = None
        logger.info(f"初始化 QdrantManager: {host}:{port}, collection={collection_name}")
    
    def connect(self):
        """连接到 Qdrant 服务"""
        if self.client is None:
            logger.info(f"正在连接到 Qdrant: {self.host}:{self.port}")
            self.client = QdrantClient(host=self.host, port=self.port)
            self._ensure_collection()
    
    def _ensure_collection(self):
        """确保集合存在，不存在则创建"""
        collections = self.client.get_collections().collections
        collection_names = [c.name for c in collections]
        
        if self.collection_name not in collection_names:
            logger.info(f"创建集合: {self.collection_name}")
            self.client.create_collection(
                collection_name=self.collection_name,
                vectors_config=VectorParams(
                    size=self.vector_size,
                    distance=Distance.COSINE,  # 余弦相似度
                ),
            )
        else:
            logger.debug(f"集合已存在: {self.collection_name}")
    
    def insert_vector(
        self,
        point_id: str,
        vector: List[float],
        payload: Dict[str, Any],
    ) -> bool:
        """
        插入单个向量
        
        Args:
            point_id: 向量 ID（UUID）
            vector: 向量数据
            payload: 元数据（capture_id, text, timestamp 等）
            
        Returns:
            是否成功
        """
        self.connect()
        
        try:
            point = PointStruct(
                id=point_id,
                vector=vector,
                payload=payload,
            )
            
            self.client.upsert(
                collection_name=self.collection_name,
                points=[point],
            )
            
            logger.debug(f"向量已插入: {point_id}")
            return True
        except Exception as e:
            logger.error(f"插入向量失败: {e}")
            return False
    
    def insert_vectors_batch(
        self,
        points: List[Dict[str, Any]],
    ) -> int:
        """
        批量插入向量
        
        Args:
            points: 向量列表，每个元素包含 id, vector, payload
            
        Returns:
            成功插入的数量
        """
        self.connect()
        
        try:
            point_structs = [
                PointStruct(
                    id=p["id"],
                    vector=p["vector"],
                    payload=p["payload"],
                )
                for p in points
            ]
            
            self.client.upsert(
                collection_name=self.collection_name,
                points=point_structs,
            )
            
            logger.info(f"批量插入 {len(points)} 个向量")
            return len(points)
        except Exception as e:
            logger.error(f"批量插入失败: {e}")
            return 0
    
    def search(
        self,
        query_vector: List[float],
        top_k: int = 10,
        score_threshold: float = 0.5,
        filter_conditions: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        向量相似度搜索
        
        Args:
            query_vector: 查询向量
            top_k: 返回结果数量
            score_threshold: 相似度阈值（0-1）
            filter_conditions: 过滤条件（可选）
            
        Returns:
            搜索结果列表，每个元素包含 id, score, payload
        """
        self.connect()
        
        try:
            search_filter = None
            if filter_conditions:
                # 构建过滤器（示例：按 app_name 过滤）
                conditions = []
                for key, value in filter_conditions.items():
                    conditions.append(
                        FieldCondition(key=key, match=MatchValue(value=value))
                    )
                search_filter = Filter(must=conditions)
            
            results = self.client.search(
                collection_name=self.collection_name,
                query_vector=query_vector,
                limit=top_k,
                score_threshold=score_threshold,
                query_filter=search_filter,
            )
            
            # 转换为字典格式
            output = []
            for hit in results:
                output.append({
                    "id": hit.id,
                    "score": hit.score,
                    "payload": hit.payload,
                })
            
            logger.debug(f"向量搜索完成，返回 {len(output)} 条结果")
            return output
        except Exception as e:
            logger.error(f"向量搜索失败: {e}")
            return []
    
    def delete_by_id(self, point_id: str) -> bool:
        """删除指定 ID 的向量"""
        self.connect()
        
        try:
            self.client.delete(
                collection_name=self.collection_name,
                points_selector=[point_id],
            )
            logger.debug(f"向量已删除: {point_id}")
            return True
        except Exception as e:
            logger.error(f"删除向量失败: {e}")
            return False
    
    def count(self) -> int:
        """获取集合中的向量总数"""
        self.connect()
        
        try:
            info = self.client.get_collection(self.collection_name)
            return info.points_count
        except Exception as e:
            logger.error(f"获取向量数量失败: {e}")
            return 0


# 全局单例
_qdrant_manager = None


def get_qdrant_manager() -> QdrantManager:
    """获取全局 Qdrant 管理器单例"""
    global _qdrant_manager
    if _qdrant_manager is None:
        _qdrant_manager = QdrantManager()
    return _qdrant_manager
