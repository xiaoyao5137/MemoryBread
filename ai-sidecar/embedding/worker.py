"""
EmbedWorker — IPC 向量化任务处理器

接收来自 Rust Core Engine 的 EmbedRequest，
将文本列表通过 EmbeddingModel 编码为向量，返回 IpcResponse。
"""

from __future__ import annotations

import asyncio
import logging
import time

from memory_bread_ipc         import IpcRequest, IpcResponse
from memory_bread_ipc.message import EmbedResult

from .model import EmbeddingModel

logger = logging.getLogger(__name__)


class EmbedWorker:
    """异步 Embedding 任务 Worker"""

    def __init__(self, model: Optional[EmbeddingModel] = None) -> None:
        self._model = model or EmbeddingModel.create_default()

    async def handle(self, req: IpcRequest) -> IpcResponse:
        """处理一个 EmbedRequest，返回 EmbedResult 或错误响应"""
        t0   = time.monotonic()
        task = req.task

        loop = asyncio.get_running_loop()
        try:
            # 同步模型推理包装为异步（避免阻塞事件循环）
            vectors_data = await loop.run_in_executor(
                None, self._model.encode, task.texts
            )

            latency_ms = int((time.monotonic() - t0) * 1000)

            result = EmbedResult(
                vectors   = [v.vector for v in vectors_data],
                dimension = self._model.dimension if vectors_data else 0,
                model     = self._model.model_name,
            )
            return IpcResponse.make_ok(req.id, result, latency_ms)

        except RuntimeError as exc:
            latency_ms = int((time.monotonic() - t0) * 1000)
            logger.error("Embedding 失败 id=%s: %s", req.id, exc)
            return IpcResponse.make_error(req.id, "EMBED_FAILED", str(exc), latency_ms)

        except Exception as exc:
            latency_ms = int((time.monotonic() - t0) * 1000)
            logger.exception("EmbedWorker 意外异常 id=%s: %s", req.id, exc)
            return IpcResponse.make_error(req.id, "INTERNAL_ERROR", str(exc), latency_ms)
