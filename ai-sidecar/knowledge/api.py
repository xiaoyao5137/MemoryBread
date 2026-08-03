"""
知识库 REST API - 提供知识条目的 HTTP 接口
"""

from __future__ import annotations

from fastapi import FastAPI, HTTPException, Query
from pydantic import BaseModel
from typing import List, Optional, Dict, Any
import logging

from .manager import KnowledgeManager
from .extractor import KnowledgeExtractor

logger = logging.getLogger(__name__)

# 初始化
knowledge_manager = KnowledgeManager()
knowledge_extractor = KnowledgeExtractor()


# Pydantic 模型
class KnowledgeEntry(BaseModel):
    id: int
    capture_id: int
    summary: str
    entities: List[str]
    category: str
    importance: int
    user_verified: bool
    user_edited: bool
    created_at: str
    updated_at: str


class KnowledgeUpdate(BaseModel):
    summary: Optional[str] = None
    entities: Optional[List[str]] = None
    category: Optional[str] = None
    importance: Optional[int] = None


class ExtractRequest(BaseModel):
    capture_id: int


# 创建 FastAPI 应用
app = FastAPI(title="记忆面包 Knowledge API", version="1.0.0")


@app.get("/api/knowledge", response_model=Dict[str, Any])
async def get_episodic_memories(
    limit: int = Query(50, ge=1, le=100),
    offset: int = Query(0, ge=0),
    category: Optional[str] = None,
    verified_only: bool = False
):
    """
    获取知识条目列表

    Args:
        limit: 返回数量限制（1-100）
        offset: 偏移量
        category: 分类筛选（会议/文档/代码/聊天/其他）
        verified_only: 只返回已验证的条目

    Returns:
        {
            "entries": [...],
            "total": 100,
            "limit": 50,
            "offset": 0
        }
    """
    try:
        entries = knowledge_manager.get_entries(
            limit=limit,
            offset=offset,
            category=category,
            verified_only=verified_only
        )

        total = knowledge_manager.count_entries(category=category, verified_only=verified_only)

        return {
            "entries": entries,
            "total": total,
            "limit": limit,
            "offset": offset
        }
    except Exception as e:
        logger.error(f"获取知识条目失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/knowledge/{entry_id}", response_model=KnowledgeEntry)
async def get_knowledge_entry(entry_id: int):
    """获取单个知识条目"""
    try:
        entry = knowledge_manager.get_entry(entry_id)
        if not entry:
            raise HTTPException(status_code=404, detail="知识条目不存在")
        return entry
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"获取知识条目失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.put("/api/knowledge/{entry_id}")
async def update_knowledge_entry(entry_id: int, update: KnowledgeUpdate):
    """
    更新知识条目

    Args:
        entry_id: 条目 ID
        update: 更新内容

    Returns:
        {"success": true, "message": "更新成功"}
    """
    try:
        updates = update.dict(exclude_unset=True)
        if not updates:
            raise HTTPException(status_code=400, detail="没有提供更新内容")

        # 标记为用户编辑
        updates['user_edited'] = True

        success = knowledge_manager.update_entry(entry_id, updates)
        if not success:
            raise HTTPException(status_code=404, detail="知识条目不存在")

        return {"success": True, "message": "更新成功"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"更新知识条目失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/knowledge/{entry_id}")
async def delete_knowledge_entry(entry_id: int):
    """
    删除知识条目

    Args:
        entry_id: 条目 ID

    Returns:
        {"success": true, "message": "删除成功"}
    """
    try:
        success = knowledge_manager.delete_entry(entry_id)
        if not success:
            raise HTTPException(status_code=404, detail="知识条目不存在")

        return {"success": True, "message": "删除成功"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"删除知识条目失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/knowledge/{entry_id}/verify")
async def verify_knowledge_entry(entry_id: int):
    """
    验证知识条目（标记为已验证）

    Args:
        entry_id: 条目 ID

    Returns:
        {"success": true, "message": "验证成功"}
    """
    try:
        success = knowledge_manager.update_entry(entry_id, {"user_verified": True})
        if not success:
            raise HTTPException(status_code=404, detail="知识条目不存在")

        return {"success": True, "message": "验证成功"}
    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"验证知识条目失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/knowledge/search")
async def search_knowledge(
    q: str = Query(..., min_length=1),
    limit: int = Query(20, ge=1, le=100)
):
    """
    搜索知识条目（全文搜索）

    Args:
        q: 搜索关键词
        limit: 返回数量限制

    Returns:
        {
            "results": [...],
            "query": "关键词",
            "total": 10
        }
    """
    try:
        results = knowledge_manager.search_entries(q, limit=limit)
        return {
            "results": results,
            "query": q,
            "total": len(results)
        }
    except Exception as e:
        logger.error(f"搜索知识条目失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/api/knowledge/extract")
async def extract_knowledge(request: ExtractRequest):
    """
    从采集记录中提炼知识

    Args:
        request: {"capture_id": 123}

    Returns:
        {"success": true, "entry_id": 456, "message": "提炼成功"}
    """
    try:
        # 1. 获取采集记录
        import sqlite3
        from pathlib import Path

        db_path = str(Path.home() / ".memory-bread" / "memory-bread.db")
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute("""
            SELECT id, app_name, window_title, timestamp, ocr_text
            FROM captures WHERE id = ?
        """, (request.capture_id,))

        row = cursor.fetchone()
        conn.close()

        if not row:
            raise HTTPException(status_code=404, detail="采集记录不存在")

        capture_data = dict(row)

        # 2. 提炼知识
        knowledge = knowledge_extractor.extract_sync(capture_data)

        if not knowledge:
            return {
                "success": False,
                "message": "该采集记录无价值内容，已跳过"
            }

        # 3. 保存到数据库
        entry_id = knowledge_manager.add_entry(knowledge)

        return {
            "success": True,
            "entry_id": entry_id,
            "message": "提炼成功"
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"提炼知识失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/knowledge/stats")
async def get_knowledge_stats():
    """
    获取知识库统计信息

    Returns:
        {
            "total": 100,
            "by_category": {"会议": 30, "文档": 40, ...},
            "verified": 50,
            "unverified": 50
        }
    """
    try:
        stats = knowledge_manager.get_stats()
        return stats
    except Exception as e:
        logger.error(f"获取统计信息失败: {e}")
        raise HTTPException(status_code=500, detail=str(e))


# 健康检查
@app.get("/health")
async def health_check():
    """健康检查"""
    return {"status": "ok", "service": "knowledge-api"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=7071)
