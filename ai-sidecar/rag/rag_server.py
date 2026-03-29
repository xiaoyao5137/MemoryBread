"""
RAG HTTP 服务器

提供 HTTP API 供 core-engine 调用
端口：7071
"""

import logging
import os
from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import uvicorn

from .embedding import get_embedding_service
from .qdrant_manager import QdrantManager
from .retriever import HybridRetriever
from .llm_client import get_llm_client

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# 创建 FastAPI 应用
app = FastAPI(title="记忆面包 RAG Service", version="0.1.0")

# 全局服务实例
qdrant_manager: Optional[QdrantManager] = None
retriever: Optional[HybridRetriever] = None
llm_client = None


# ─────────────────────────────────────────────────────────────────────────────
# 请求/响应模型
# ─────────────────────────────────────────────────────────────────────────────

class QueryRequest(BaseModel):
    query: str
    top_k: int = 20


class RagContext(BaseModel):
    capture_id: int
    text: str
    score: float
    source: str
    app_name: Optional[str] = None


class QueryResponse(BaseModel):
    answer: str
    contexts: List[RagContext]
    model: str


# ─────────────────────────────────────────────────────────────────────────────
# 启动事件
# ─────────────────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    """服务启动时初始化"""
    global qdrant_manager, retriever, llm_client
    
    logger.info("正在启动 RAG 服务...")
    
    # 获取数据库路径
    db_path = os.getenv(
        "WORKBUDDY_DB_PATH",
        os.path.expanduser("~/.memory-bread/memory-bread.db"),
    )
    
    # 初始化 Qdrant
    qdrant_manager = QdrantManager(
        host=os.getenv("QDRANT_HOST", "localhost"),
        port=int(os.getenv("QDRANT_PORT", "6333")),
    )
    
    # 初始化检索器
    retriever = HybridRetriever(
        qdrant_manager=qdrant_manager,
        sqlite_db_path=db_path,
    )
    
    # 初始化 LLM 客户端
    llm_client = get_llm_client()
    
    # 预加载 Embedding 模型
    embedding_service = get_embedding_service()
    embedding_service.load_model()
    
    logger.info("RAG 服务启动完成")


# ─────────────────────────────────────────────────────────────────────────────
# API 端点
# ─────────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health_check():
    """健康检查"""
    return {"status": "ok", "service": "rag"}


@app.post("/query", response_model=QueryResponse)
async def rag_query(request: QueryRequest):
    """
    RAG 查询接口
    
    流程：
    1. 混合检索（向量 + 关键词）
    2. LLM 生成回答
    """
    try:
        logger.info(f"收到查询: {request.query[:50]}...")
        
        # 1. 混合检索
        contexts = retriever.retrieve(
            query=request.query,
            top_k=request.top_k,
        )
        
        if not contexts:
            return QueryResponse(
                answer=f"抱歉，我在工作记录中没有找到与「{request.query}」相关的信息。",
                contexts=[],
                model="none",
            )
        
        # 2. LLM 生成回答
        answer = llm_client.generate_with_context(
            query=request.query,
            contexts=contexts,
        )
        
        # 3. 转换为响应格式
        response_contexts = [
            RagContext(
                capture_id=ctx["capture_id"],
                text=ctx["text"],
                score=ctx["score"],
                source=ctx["source"],
                app_name=ctx.get("app_name"),
            )
            for ctx in contexts
        ]
        
        return QueryResponse(
            answer=answer,
            contexts=response_contexts,
            model=llm_client.model,
        )
    
    except Exception as e:
        logger.error(f"查询失败: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=str(e))


# ─────────────────────────────────────────────────────────────────────────────
# 主函数
# ─────────────────────────────────────────────────────────────────────────────

def main():
    """启动 RAG 服务器"""
    uvicorn.run(
        "rag.rag_server:app",
        host="127.0.0.1",
        port=7071,
        log_level="info",
    )


if __name__ == "__main__":
    main()
