"""
Dispatcher — IPC 任务分发器（集成闲时计算）

将来自 Rust Core Engine 的请求按 task.type 路由到对应的 Worker：
    ping      → 内置响应（不需要 Worker）
    ocr       → OcrWorker（实时处理）
    embed     → 闲时队列（批量处理）
    asr       → 闲时队列（批量处理）
    vlm       → 闲时队列（批量处理）
    rag       → RagWorker（按需处理）
    pii_scrub → (待实现)

设计原则：
- OCR：实时处理，常驻内存
- Embedding/ASR/VLM：提交到闲时队列，批量处理
- RAG：按需加载 LLM，2 分钟后卸载
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid

from memory_bread_ipc import IpcRequest, IpcResponse, PingResult

from idle_compute import (
    IdleDetector,
    TaskScheduler,
    ModelManager,
    IdleComputeEngine,
    Task,
    TaskType,
    TaskPriority,
    ModelType,
)

logger = logging.getLogger(__name__)


class Dispatcher:
    """将 IPC 请求路由到对应 Worker 的分发器（集成闲时计算）"""

    def __init__(self, ocr_worker: object | None = None) -> None:
        # 传统 Worker（懒加载）
        self._ocr_worker: object | None = ocr_worker   # 实时处理；主进程可注入共享单例
        self._rag_worker: object | None = None   # 按需处理

        # 闲时计算系统
        self._idle_detector: IdleDetector | None = None
        self._task_scheduler: TaskScheduler | None = None
        self._model_manager: ModelManager | None = None
        self._idle_engine: IdleComputeEngine | None = None
        self._idle_engine_started = False

        # 任务结果缓存（用于异步任务）
        self._task_results: dict[str, IpcResponse] = {}

    # ── 初始化 ────────────────────────────────────────────────────────────

    async def initialize(self) -> None:
        """初始化闲时计算系统"""
        if self._idle_engine_started:
            return

        logger.info("初始化闲时计算系统...")

        # 1. 创建闲时检测器
        self._idle_detector = IdleDetector(
            cpu_threshold=20.0,
            memory_threshold=70.0,
            stable_duration=60,
            min_interval=3600,  # 1 小时
            require_power=True,
        )

        # 2. 创建任务调度器
        self._task_scheduler = TaskScheduler(max_queue_size=1000)

        # 3. 创建模型管理器
        self._model_manager = ModelManager(max_concurrent_models=2)

        # 4. 注册模型
        self._register_models()

        # 5. 创建闲时计算引擎
        self._idle_engine = IdleComputeEngine(
            idle_detector=self._idle_detector,
            task_scheduler=self._task_scheduler,
            model_manager=self._model_manager,
        )

        # 6. 启动引擎
        await self._idle_engine.start()
        self._idle_engine_started = True

        logger.info("✓ 闲时计算系统已启动")

    def _register_models(self) -> None:
        """注册所有模型"""
        # OCR 模型（常驻内存）
        self._model_manager.register(
            ModelType.OCR,
            name="PaddleOCR-INT8",
            loader=self._load_ocr_model,
            memory_mb=50,
            keep_loaded=True,
        )

        # Embedding 模型（闲时加载）
        self._model_manager.register(
            ModelType.EMBEDDING,
            name="BGE-M3-INT8",
            loader=self._load_embedding_model,
            memory_mb=650,
            keep_loaded=False,
        )

        # LLM 模型（按需加载）
        self._model_manager.register(
            ModelType.LLM,
            name="Qwen2.5-3B",
            loader=self._load_llm_model,
            memory_mb=2500,
            keep_loaded=False,
        )

        # ASR 模型（闲时加载）
        self._model_manager.register(
            ModelType.ASR,
            name="Whisper-Tiny-Q5",
            loader=self._load_asr_model,
            memory_mb=80,
            keep_loaded=False,
        )

        # VLM 模型（闲时加载）
        self._model_manager.register(
            ModelType.VLM,
            name="MiniCPM-V-Q2",
            loader=self._load_vlm_model,
            memory_mb=3000,
            keep_loaded=False,
        )

        logger.info("✓ 已注册 5 个模型")

    # ── 模型加载函数 ──────────────────────────────────────────────────────

    def _load_ocr_model(self):
        """加载 OCR 模型"""
        from ocr.engine import OcrEngine
        return OcrEngine.create_default()

    def _load_embedding_model(self):
        """加载 Embedding 模型（使用全局共享实例）"""
        from model_registry_global import get_shared_embedding
        return get_shared_embedding()

    def _load_llm_model(self):
        """加载 LLM 模型（通过 Ollama）"""
        # LLM 通过 Ollama HTTP API 调用，使用全局统一的模型名
        from model_registry_global import get_active_ollama_model
        return {"type": "llm", "model": get_active_ollama_model()}

    def _load_asr_model(self):
        """加载 ASR 模型"""
        from asr.model import AsrModel
        return AsrModel.create_default()

    def _load_vlm_model(self):
        """加载 VLM 模型"""
        from vlm.model import VlmModel
        return VlmModel.create_default()

    # ── 公共接口 ──────────────────────────────────────────────────────────────

    async def dispatch(self, req: IpcRequest) -> IpcResponse:
        """根据 task.type 分派请求"""
        # 确保闲时计算系统已初始化
        if not self._idle_engine_started:
            await self.initialize()

        t0 = time.monotonic()
        task_type = req.task.type

        logger.debug("收到任务 id=%s type=%s", req.id, task_type)

        # Ping（内置响应）
        if task_type == "ping":
            latency_ms = int((time.monotonic() - t0) * 1000)
            return IpcResponse.make_ok(req.id, PingResult(), latency_ms)

        # OCR（实时处理）
        if task_type == "ocr":
            return await self._handle_ocr(req)

        # Embedding（闲时队列）
        if task_type == "embed":
            return await self._handle_embed(req)

        # ASR（闲时队列）
        if task_type == "asr":
            return await self._handle_asr(req)

        # VLM（闲时队列）
        if task_type == "vlm":
            return await self._handle_vlm(req)

        # RAG（按需处理）
        if task_type == "rag":
            return await self._handle_rag(req)

        # 未实现的任务类型
        latency_ms = int((time.monotonic() - t0) * 1000)
        logger.warning("未实现的任务类型: %s", task_type)
        return IpcResponse.make_error(
            req.id,
            "NOT_IMPLEMENTED",
            f"任务类型 '{task_type}' 尚未实现",
            latency_ms,
        )

    # ── 任务处理 ──────────────────────────────────────────────────────────

    async def _handle_ocr(self, req: IpcRequest) -> IpcResponse:
        """处理 OCR 任务（实时）"""
        # 获取 OCR Worker
        if self._ocr_worker is None:
            from ocr.worker import OcrWorker
            # 从模型管理器获取已加载的 OCR 模型
            ocr_engine = await self._model_manager.load_model(ModelType.OCR)
            self._ocr_worker = OcrWorker(engine=ocr_engine)
            logger.info("OcrWorker 已初始化")

        # 实时处理
        return await self._ocr_worker.handle(req)

    async def _handle_embed(self, req: IpcRequest) -> IpcResponse:
        """处理 Embedding 任务（闲时队列）"""
        # 提交到闲时队列
        task = Task(
            task_id=req.id,
            task_type=TaskType.EMBEDDING,
            priority=TaskPriority.IDLE_HIGH,
            payload={
                "capture_id": req.task.capture_id,
                "texts": req.task.texts,
            }
        )

        success = self._task_scheduler.submit_task(task)

        if success:
            logger.info("Embedding 任务已提交到闲时队列: %s", req.id)
            # 返回异步响应
            return IpcResponse.make_ok(
                req.id,
                {"status": "queued", "message": "任务已提交到闲时队列"},
                0
            )
        else:
            return IpcResponse.make_error(
                req.id,
                "QUEUE_FULL",
                "任务队列已满",
                0
            )

    async def _handle_asr(self, req: IpcRequest) -> IpcResponse:
        """处理 ASR 任务（闲时队列）"""
        task = Task(
            task_id=req.id,
            task_type=TaskType.ASR,
            priority=TaskPriority.IDLE_LOW,
            payload={
                "capture_id": req.task.capture_id,
                "audio_path": req.task.audio_path,
            }
        )

        success = self._task_scheduler.submit_task(task)

        if success:
            logger.info("ASR 任务已提交到闲时队列: %s", req.id)
            return IpcResponse.make_ok(
                req.id,
                {"status": "queued", "message": "任务已提交到闲时队列"},
                0
            )
        else:
            return IpcResponse.make_error(
                req.id,
                "QUEUE_FULL",
                "任务队列已满",
                0
            )

    async def _handle_vlm(self, req: IpcRequest) -> IpcResponse:
        """处理 VLM 任务（闲时队列）"""
        task = Task(
            task_id=req.id,
            task_type=TaskType.VLM,
            priority=TaskPriority.IDLE_LOW,
            payload={
                "capture_id": req.task.capture_id,
                "image_path": req.task.image_path,
                "question": req.task.question,
            }
        )

        success = self._task_scheduler.submit_task(task)

        if success:
            logger.info("VLM 任务已提交到闲时队列: %s", req.id)
            return IpcResponse.make_ok(
                req.id,
                {"status": "queued", "message": "任务已提交到闲时队列"},
                0
            )
        else:
            return IpcResponse.make_error(
                req.id,
                "QUEUE_FULL",
                "任务队列已满",
                0
            )

    async def _handle_rag(self, req: IpcRequest) -> IpcResponse:
        """处理 RAG 任务（按需加载 LLM）"""
        # 获取 RAG Worker
        if self._rag_worker is None:
            from rag.worker import RagWorker
            self._rag_worker = RagWorker()
            logger.info("RagWorker 已初始化")

        # 加载 LLM 模型（按需）
        await self._model_manager.load_model(ModelType.LLM)

        try:
            # 处理 RAG 请求
            response = await self._rag_worker.handle(req)
            return response
        finally:
            # 2 分钟后自动卸载（通过 Ollama 的 keep_alive 机制）
            pass

    # ── 状态查询 ──────────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """获取 Dispatcher 状态"""
        if not self._idle_engine_started:
            return {"status": "not_initialized"}

        return {
            "idle_detector": self._idle_detector.get_status(),
            "task_scheduler": self._task_scheduler.get_stats(),
            "model_manager": self._model_manager.get_status(),
        }

    async def shutdown(self) -> None:
        """关闭 Dispatcher"""
        if self._idle_engine:
            await self._idle_engine.stop()
        logger.info("Dispatcher 已关闭")
