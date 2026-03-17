"""
闲时计算引擎

协调闲时检测器、任务调度器和模型管理器，实现完整的闲时计算流程。
"""

import asyncio
import logging
from typing import Optional

from .idle_detector import IdleDetector
from .task_scheduler import TaskScheduler, Task, TaskType, TaskPriority
from .model_manager import ModelManager, ModelType
from monitor.system_sampler import SystemMetricsSampler, snapshot

logger = logging.getLogger(__name__)


class IdleComputeEngine:
    """闲时计算引擎"""

    def __init__(
        self,
        idle_detector: IdleDetector,
        task_scheduler: TaskScheduler,
        model_manager: ModelManager,
        metrics_sampler: Optional[SystemMetricsSampler] = None,
    ):
        self.idle_detector = idle_detector
        self.task_scheduler = task_scheduler
        self.model_manager = model_manager
        self._sampler = metrics_sampler or SystemMetricsSampler()

        self._running = False
        self._idle_worker_task: Optional[asyncio.Task] = None

    # ── 启动/停止 ─────────────────────────────────────────────────────

    async def start(self) -> None:
        """启动闲时计算引擎"""
        if self._running:
            logger.warning("闲时计算引擎已在运行")
            return

        self._running = True
        await self._sampler.start()
        logger.info("闲时计算引擎已启动")

        # 启动闲时工作线程
        self._idle_worker_task = asyncio.create_task(self._idle_worker())

    async def stop(self) -> None:
        """停止闲时计算引擎"""
        if not self._running:
            return

        self._running = False
        logger.info("正在停止闲时计算引擎...")

        # 等待工作线程结束
        if self._idle_worker_task:
            self._idle_worker_task.cancel()
            try:
                await self._idle_worker_task
            except asyncio.CancelledError:
                pass

        # 卸载所有模型
        self.model_manager.unload_all()
        await self._sampler.stop()

        logger.info("闲时计算引擎已停止")

    # ── 闲时工作线程 ──────────────────────────────────────────────────

    async def _idle_worker(self) -> None:
        """闲时任务处理工作线程"""
        logger.info("闲时工作线程已启动")

        while self._running:
            try:
                # 每 10 秒检查一次
                await asyncio.sleep(10)

                # 检查是否满足闲时条件
                if not self.idle_detector.is_idle():
                    continue

                # 进入闲时模式
                logger.info("=" * 60)
                logger.info("进入闲时模式，开始批量处理任务")
                logger.info("=" * 60)

                self._sampler.set_idle_mode(True)
                snapshot(context="idle_start")

                # 串行处理闲时任务
                await self._process_idle_tasks()

                snapshot(context="idle_end")
                self._sampler.set_idle_mode(False)

                # 标记执行完成
                self.idle_detector.mark_execution()

                logger.info("=" * 60)
                logger.info("闲时任务处理完成")
                logger.info("下次执行: %d 秒后", self.idle_detector.get_time_until_next_execution())
                logger.info("=" * 60)

            except Exception as e:
                logger.error("闲时工作线程异常: %s", e, exc_info=True)
                await asyncio.sleep(60)  # 出错后等待 1 分钟

    async def _process_idle_tasks(self) -> None:
        """处理闲时任务（串行加载模型）"""
        # 1. 处理 Embedding 任务（高优先级）
        await self._process_embedding_tasks()

        # 2. 处理 VLM 任务（低优先级）
        await self._process_vlm_tasks()

        # 3. 处理 ASR 任务（低优先级）
        await self._process_asr_tasks()

    # ── 各类型任务处理 ────────────────────────────────────────────────

    async def _process_embedding_tasks(self) -> None:
        """批量处理 Embedding 任务"""
        # 获取所有 Embedding 任务
        tasks = self.task_scheduler.get_idle_tasks_by_type(
            TaskType.EMBEDDING,
            limit=100  # 每次最多处理 100 个
        )

        if not tasks:
            logger.debug("没有待处理的 Embedding 任务")
            return

        logger.info("开始处理 %d 个 Embedding 任务", len(tasks))

        try:
            # 加载 Embedding 模型
            model = await self.model_manager.load_model(ModelType.EMBEDDING)

            # 批量处理
            for task in tasks:
                try:
                    await self._execute_embedding_task(model, task)
                    self.task_scheduler.mark_completed(task)
                except Exception as e:
                    logger.error("Embedding 任务失败: %s - %s", task.task_id, e)
                    self.task_scheduler.mark_failed(task, str(e))

            logger.info("Embedding 任务处理完成: %d 个", len(tasks))

        finally:
            # 卸载模型
            self.model_manager.unload_model(ModelType.EMBEDDING)

    async def _process_vlm_tasks(self) -> None:
        """批量处理 VLM 任务"""
        tasks = self.task_scheduler.get_idle_tasks_by_type(
            TaskType.VLM,
            limit=10  # VLM 较慢，每次处理 10 个
        )

        if not tasks:
            logger.debug("没有待处理的 VLM 任务")
            return

        logger.info("开始处理 %d 个 VLM 任务", len(tasks))

        try:
            # 加载 VLM 模型
            model = await self.model_manager.load_model(ModelType.VLM)

            # 逐个处理
            for task in tasks:
                try:
                    await self._execute_vlm_task(model, task)
                    self.task_scheduler.mark_completed(task)
                except Exception as e:
                    logger.error("VLM 任务失败: %s - %s", task.task_id, e)
                    self.task_scheduler.mark_failed(task, str(e))

            logger.info("VLM 任务处理完成: %d 个", len(tasks))

        finally:
            # 卸载模型
            self.model_manager.unload_model(ModelType.VLM)

    async def _process_asr_tasks(self) -> None:
        """批量处理 ASR 任务"""
        tasks = self.task_scheduler.get_idle_tasks_by_type(
            TaskType.ASR,
            limit=20
        )

        if not tasks:
            logger.debug("没有待处理的 ASR 任务")
            return

        logger.info("开始处理 %d 个 ASR 任务", len(tasks))

        try:
            # 加载 ASR 模型
            model = await self.model_manager.load_model(ModelType.ASR)

            # 批量处理
            for task in tasks:
                try:
                    await self._execute_asr_task(model, task)
                    self.task_scheduler.mark_completed(task)
                except Exception as e:
                    logger.error("ASR 任务失败: %s - %s", task.task_id, e)
                    self.task_scheduler.mark_failed(task, str(e))

            logger.info("ASR 任务处理完成: %d 个", len(tasks))

        finally:
            # 卸载模型
            self.model_manager.unload_model(ModelType.ASR)

    # ── 任务执行 ──────────────────────────────────────────────────────

    async def _execute_embedding_task(self, model: any, task: Task) -> None:
        """执行 Embedding 任务"""
        texts = task.payload.get("texts", [])
        capture_id = task.payload.get("capture_id")

        logger.debug("执行 Embedding: capture_id=%s, texts=%d", capture_id, len(texts))

        # 调用模型
        loop = asyncio.get_event_loop()
        vectors = await loop.run_in_executor(None, model.encode, texts)

        # 存储向量（这里需要调用 vector_storage）
        # TODO: 集成 vector_storage
        logger.debug("Embedding 完成: %d 个向量", len(vectors))

    async def _execute_vlm_task(self, model: any, task: Task) -> None:
        """执行 VLM 任务"""
        image_path = task.payload.get("image_path")
        question = task.payload.get("question", "描述这张图片")

        logger.debug("执行 VLM: image=%s", image_path)

        # 调用模型
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, model.process, image_path, question)

        logger.debug("VLM 完成: %s", result[:100])

    async def _execute_asr_task(self, model: any, task: Task) -> None:
        """执行 ASR 任务"""
        audio_path = task.payload.get("audio_path")

        logger.debug("执行 ASR: audio=%s", audio_path)

        # 调用模型
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(None, model.transcribe, audio_path)

        logger.debug("ASR 完成: %s", result.get("text", "")[:100])

    # ── 状态查询 ──────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """获取引擎状态"""
        return {
            "running": self._running,
            "idle_detector": self.idle_detector.get_status(),
            "task_scheduler": self.task_scheduler.get_stats(),
            "model_manager": self.model_manager.get_status(),
        }
