"""
模型管理器

负责模型的加载、卸载和生命周期管理。
支持串行加载，同时最多加载 1-2 个模型。
"""

import asyncio
import gc
import logging
import sqlite3
import time
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import Any, Callable, Optional, Dict

import psutil

logger = logging.getLogger(__name__)

DB_PATH = str(Path.home() / ".workbuddy" / "workbuddy.db")


def _available_mb() -> int:
    return int(psutil.virtual_memory().available / 1024 / 1024)


def _log_model_event(
    event_type: str,
    model_type: str,
    model_name: str,
    duration_ms: Optional[int] = None,
    memory_mb: Optional[int] = None,
    mem_before_mb: Optional[int] = None,
    mem_after_mb: Optional[int] = None,
    error_msg: Optional[str] = None,
    db_path: str = DB_PATH,
):
    """写入 model_events 表，失败不影响主流程"""
    try:
        conn = sqlite3.connect(db_path)
        conn.execute(
            """INSERT INTO model_events
               (ts, event_type, model_type, model_name, duration_ms,
                memory_mb, mem_before_mb, mem_after_mb, error_msg)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (
                int(time.time() * 1000),
                event_type, model_type, model_name,
                duration_ms, memory_mb, mem_before_mb, mem_after_mb, error_msg,
            ),
        )
        conn.commit()
        conn.close()
    except Exception as e:
        logger.warning(f"model_event 埋点失败: {e}")


class ModelType(Enum):
    """模型类型"""
    OCR = "ocr"
    EMBEDDING = "embedding"
    LLM = "llm"
    ASR = "asr"
    VLM = "vlm"


class ModelSlot:
    """单个模型的生命周期管理"""

    def __init__(
        self,
        name: str,
        model_type: ModelType,
        loader: Callable[[], Any],
        memory_mb: int,
        keep_loaded: bool = False,
    ):
        self.name = name
        self.model_type = model_type
        self._loader = loader
        self.memory_mb = memory_mb
        self.keep_loaded = keep_loaded

        self._model: Optional[Any] = None
        self._loading = False
        self._loaded_at: Optional[datetime] = None

    async def load(self) -> Any:
        """加载模型"""
        if self._model is not None:
            logger.debug("模型 %s 已加载，直接返回", self.name)
            return self._model

        if self._loading:
            raise RuntimeError(f"模型 {self.name} 正在加载中")

        self._loading = True
        mem_before = _available_mb()
        _log_model_event("load_start", self.model_type.value, self.name,
                         memory_mb=self.memory_mb, mem_before_mb=mem_before)
        try:
            logger.info("开始加载模型: %s (预计占用 %d MB)", self.name, self.memory_mb)
            start_ms = int(time.time() * 1000)

            # 在线程池中加载（避免阻塞事件循环）
            loop = asyncio.get_event_loop()
            self._model = await loop.run_in_executor(None, self._loader)

            duration_ms = int(time.time() * 1000) - start_ms
            self._loaded_at = datetime.now()
            mem_after = _available_mb()

            logger.info("模型加载完成: %s (耗时 %.1f 秒)", self.name, duration_ms / 1000)
            _log_model_event("load_done", self.model_type.value, self.name,
                             duration_ms=duration_ms, memory_mb=self.memory_mb,
                             mem_before_mb=mem_before, mem_after_mb=mem_after)
            return self._model

        except Exception as e:
            _log_model_event("load_failed", self.model_type.value, self.name,
                             memory_mb=self.memory_mb, mem_before_mb=mem_before,
                             error_msg=str(e))
            raise
        finally:
            self._loading = False

    def unload(self) -> None:
        """卸载模型"""
        if self._model is None:
            return

        if self.keep_loaded:
            logger.debug("模型 %s 设置为常驻，跳过卸载", self.name)
            return

        mem_before = _available_mb()
        logger.info("卸载模型: %s", self.name)
        del self._model
        self._model = None
        self._loaded_at = None

        # 强制垃圾回收
        gc.collect()
        mem_after = _available_mb()
        _log_model_event("unload", self.model_type.value, self.name,
                         memory_mb=self.memory_mb,
                         mem_before_mb=mem_before, mem_after_mb=mem_after)

    @property
    def is_loaded(self) -> bool:
        """模型是否已加载"""
        return self._model is not None

    def get_model(self) -> Optional[Any]:
        """获取已加载的模型（不触发加载）"""
        return self._model


class ModelManager:
    """模型管理器"""

    def __init__(self, max_concurrent_models: int = 2):
        self.max_concurrent_models = max_concurrent_models
        self._slots: Dict[ModelType, ModelSlot] = {}
        self._load_lock = asyncio.Lock()

    # ── 模型注册 ──────────────────────────────────────────────────────

    def register(
        self,
        model_type: ModelType,
        name: str,
        loader: Callable[[], Any],
        memory_mb: int,
        keep_loaded: bool = False,
    ) -> None:
        """
        注册模型。

        Args:
            model_type: 模型类型
            name: 模型名称
            loader: 模型加载函数
            memory_mb: 预计内存占用（MB）
            keep_loaded: 是否常驻内存
        """
        slot = ModelSlot(name, model_type, loader, memory_mb, keep_loaded)
        self._slots[model_type] = slot
        logger.info(
            "注册模型: %s (%s, %d MB, 常驻=%s)",
            name,
            model_type.value,
            memory_mb,
            keep_loaded
        )

    # ── 模型加载/卸载 ─────────────────────────────────────────────────

    async def load_model(self, model_type: ModelType) -> Any:
        """
        加载模型（带并发控制）。

        Args:
            model_type: 模型类型

        Returns:
            加载的模型对象
        """
        if model_type not in self._slots:
            raise KeyError(f"未注册的模型类型: {model_type}")

        slot = self._slots[model_type]

        # 如果已加载，直接返回
        if slot.is_loaded:
            return slot.get_model()

        # 加载前检查并发数
        async with self._load_lock:
            # 检查当前加载的模型数量
            loaded_count = self._get_loaded_count()

            if loaded_count >= self.max_concurrent_models:
                # 需要卸载一个非常驻模型
                logger.info(
                    "已加载 %d 个模型，达到上限，需要卸载",
                    loaded_count
                )
                self._unload_one_model(exclude=model_type)

            # 加载模型
            return await slot.load()

    def unload_model(self, model_type: ModelType) -> None:
        """卸载指定模型"""
        if model_type not in self._slots:
            return

        slot = self._slots[model_type]
        slot.unload()

    def unload_all(self, force: bool = False) -> None:
        """
        卸载所有模型。

        Args:
            force: 是否强制卸载常驻模型
        """
        for slot in self._slots.values():
            if force or not slot.keep_loaded:
                slot.unload()

        logger.info("已卸载所有模型 (force=%s)", force)

    # ── 内部方法 ──────────────────────────────────────────────────────

    def _get_loaded_count(self) -> int:
        """获取当前已加载的模型数量"""
        return sum(1 for slot in self._slots.values() if slot.is_loaded)

    def _unload_one_model(self, exclude: Optional[ModelType] = None) -> None:
        """
        卸载一个非常驻模型（优先卸载最早加载的）。

        Args:
            exclude: 排除的模型类型（不卸载）
        """
        # 找到所有可卸载的模型（非常驻 + 非排除）
        candidates = [
            slot for slot in self._slots.values()
            if slot.is_loaded
            and not slot.keep_loaded
            and slot.model_type != exclude
        ]

        if not candidates:
            logger.warning("没有可卸载的模型")
            return

        # 按加载时间排序，卸载最早的
        candidates.sort(key=lambda s: s._loaded_at or datetime.min)
        slot_to_unload = candidates[0]

        logger.info("卸载模型以释放空间: %s", slot_to_unload.name)
        slot_to_unload.unload()

    # ── 状态查询 ──────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """获取模型管理器状态"""
        models_status = {}
        total_memory = 0

        for model_type, slot in self._slots.items():
            models_status[model_type.value] = {
                "name": slot.name,
                "loaded": slot.is_loaded,
                "memory_mb": slot.memory_mb,
                "keep_loaded": slot.keep_loaded,
            }
            if slot.is_loaded:
                total_memory += slot.memory_mb

        return {
            "loaded_count": self._get_loaded_count(),
            "max_concurrent": self.max_concurrent_models,
            "total_memory_mb": total_memory,
            "models": models_status,
        }

    def is_model_loaded(self, model_type: ModelType) -> bool:
        """检查模型是否已加载"""
        if model_type not in self._slots:
            return False
        return self._slots[model_type].is_loaded

    def get_model(self, model_type: ModelType) -> Optional[Any]:
        """获取已加载的模型（不触发加载）"""
        if model_type not in self._slots:
            return None
        return self._slots[model_type].get_model()
