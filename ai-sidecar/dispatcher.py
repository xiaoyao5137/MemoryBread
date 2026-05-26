"""
Dispatcher — IPC 任务分发器

将来自 Rust Core Engine 的请求按 task.type 路由到对应的 Worker：
    ping      → 内置响应（不需要 Worker）
    ocr       → OcrWorker
    embed     → EmbedWorker
    asr       → AsrWorker
    vlm       → VlmWorker
    rag       → RagWorker
    pii_scrub → (待实现)

设计原则：
- 懒加载：Worker 在第一次使用时才初始化（延迟模型加载）
- 未实现的任务类型返回 NOT_IMPLEMENTED 错误响应，而非抛异常
"""

from __future__ import annotations

import logging
import time

from memory_bread_ipc import IpcRequest, IpcResponse, PingResult

logger = logging.getLogger(__name__)


class Dispatcher:
    """将 IPC 请求路由到对应 Worker 的分发器"""

    def __init__(self) -> None:
        self._ocr_worker:   object | None = None   # 懒加载
        self._embed_worker: object | None = None   # 懒加载
        self._asr_worker:   object | None = None   # 懒加载
        self._vlm_worker:   object | None = None   # 懒加载
        self._rag_worker:   object | None = None   # 懒加载

    # ── 公共接口 ──────────────────────────────────────────────────────────────

    async def dispatch(self, req: IpcRequest) -> IpcResponse:
        """根据 task.type 分派请求"""
        t0        = time.monotonic()
        task_type = req.task.type

        logger.debug("收到任务 id=%s type=%s", req.id, task_type)

        if task_type == "ping":
            latency_ms = int((time.monotonic() - t0) * 1000)
            return IpcResponse.make_ok(req.id, PingResult(), latency_ms)

        if task_type == "ocr":
            worker = self._get_ocr_worker()
            return await worker.handle(req)

        if task_type == "embed":
            worker = self._get_embed_worker()
            return await worker.handle(req)

        if task_type == "asr":
            worker = self._get_asr_worker()
            return await worker.handle(req)

        if task_type == "vlm":
            worker = self._get_vlm_worker()
            return await worker.handle(req)

        if task_type == "rag":
            worker = self._get_rag_worker()
            return await worker.handle(req)

        # 其他任务类型（pii_scrub）待后续迭代实现
        latency_ms = int((time.monotonic() - t0) * 1000)
        logger.warning("未实现的任务类型: %s", task_type)
        return IpcResponse.make_error(
            req.id,
            "NOT_IMPLEMENTED",
            f"任务类型 '{task_type}' 尚未实现",
            latency_ms,
        )

    # ── 内部 ──────────────────────────────────────────────────────────────────

    def _get_ocr_worker(self):
        """懒加载 OcrWorker（首次调用时初始化引擎）"""
        if self._ocr_worker is None:
            from ocr.worker import OcrWorker
            from ocr.engine import OcrEngine
            self._ocr_worker = OcrWorker(engine=OcrEngine.create_default())
            logger.info("OcrWorker 已初始化")
        return self._ocr_worker

    def _get_embed_worker(self):
        """懒加载 EmbedWorker（首次调用时初始化模型，使用全局共享 Embedding）"""
        if self._embed_worker is None:
            from embedding.worker import EmbedWorker
            from model_registry_global import get_shared_embedding
            self._embed_worker = EmbedWorker(model=get_shared_embedding())
            logger.info("EmbedWorker 已初始化（使用共享 Embedding）")
        return self._embed_worker

    def _get_asr_worker(self):
        """懒加载 AsrWorker（首次调用时初始化模型）"""
        if self._asr_worker is None:
            from asr.worker import AsrWorker
            from asr.model  import AsrModel
            self._asr_worker = AsrWorker(model=AsrModel.create_default())
            logger.info("AsrWorker 已初始化")
        return self._asr_worker

    def _get_vlm_worker(self):
        """懒加载 VlmWorker（首次调用时初始化模型）"""
        if self._vlm_worker is None:
            from vlm.worker import VlmWorker
            from vlm.model  import VlmModel
            self._vlm_worker = VlmWorker(model=VlmModel.create_default())
            logger.info("VlmWorker 已初始化")
        return self._vlm_worker

    def _get_rag_worker(self):
        """懒加载 RagWorker（首次调用时初始化 RAG pipeline）"""
        if self._rag_worker is None:
            from rag.worker import RagWorker
            self._rag_worker = RagWorker()
            logger.info("RagWorker 已初始化")
        return self._rag_worker
