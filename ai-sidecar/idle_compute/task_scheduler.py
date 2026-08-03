"""
任务调度器

负责管理闲时任务队列，按优先级调度任务。
"""

from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from typing import List, Optional
from collections import deque

logger = logging.getLogger(__name__)


class TaskPriority(Enum):
    """任务优先级"""
    REALTIME = 0  # 实时任务（OCR）
    ON_DEMAND = 1  # 按需任务（LLM）
    IDLE_HIGH = 2  # 闲时高优先级（Embedding）
    IDLE_LOW = 3   # 闲时低优先级（VLM, ASR）


class TaskType(Enum):
    """任务类型"""
    OCR = "ocr"
    EMBEDDING = "embedding"
    VLM = "vlm"
    ASR = "asr"
    LLM = "llm"


@dataclass
class Task:
    """任务定义"""
    task_id: str
    task_type: TaskType
    priority: TaskPriority
    payload: dict
    created_at: datetime = field(default_factory=datetime.now)
    retries: int = 0
    max_retries: int = 3

    def __lt__(self, other):
        """优先级比较（数字越小优先级越高）"""
        return self.priority.value < other.priority.value


class TaskScheduler:
    """任务调度器"""

    def __init__(self, max_queue_size: int = 1000):
        self.max_queue_size = max_queue_size

        # 按优先级分类的任务队列
        self._realtime_queue: deque = deque()  # 实时任务
        self._on_demand_queue: deque = deque()  # 按需任务
        self._idle_queue: deque = deque()  # 闲时任务

        # 统计信息
        self._total_tasks = 0
        self._completed_tasks = 0
        self._failed_tasks = 0

    # ── 任务提交 ──────────────────────────────────────────────────────

    def submit_task(self, task: Task) -> bool:
        """
        提交任务到队列。

        Args:
            task: 任务对象

        Returns:
            True: 提交成功
            False: 队列已满
        """
        # 检查队列大小
        if self.get_total_pending() >= self.max_queue_size:
            logger.warning("任务队列已满，拒绝任务: %s", task.task_id)
            return False

        # 根据优先级分配到不同队列
        if task.priority == TaskPriority.REALTIME:
            self._realtime_queue.append(task)
            logger.debug("实时任务入队: %s (%s)", task.task_id, task.task_type.value)

        elif task.priority == TaskPriority.ON_DEMAND:
            self._on_demand_queue.append(task)
            logger.debug("按需任务入队: %s (%s)", task.task_id, task.task_type.value)

        else:  # IDLE_HIGH or IDLE_LOW
            self._idle_queue.append(task)
            logger.debug("闲时任务入队: %s (%s)", task.task_id, task.task_type.value)

        self._total_tasks += 1
        return True

    # ── 任务获取 ──────────────────────────────────────────────────────

    def get_next_realtime_task(self) -> Optional[Task]:
        """获取下一个实时任务（OCR）"""
        if self._realtime_queue:
            return self._realtime_queue.popleft()
        return None

    def get_next_on_demand_task(self) -> Optional[Task]:
        """获取下一个按需任务（LLM）"""
        if self._on_demand_queue:
            return self._on_demand_queue.popleft()
        return None

    def get_next_idle_task(self) -> Optional[Task]:
        """获取下一个闲时任务（按优先级排序）"""
        if not self._idle_queue:
            return None

        # 按优先级排序（IDLE_HIGH 优先）
        sorted_tasks = sorted(self._idle_queue, key=lambda t: t.priority.value)
        task = sorted_tasks[0]
        self._idle_queue.remove(task)
        return task

    def get_idle_tasks_by_type(self, task_type: TaskType, limit: int = 100) -> List[Task]:
        """
        获取指定类型的闲时任务（批量处理）。

        Args:
            task_type: 任务类型
            limit: 最多获取数量

        Returns:
            任务列表
        """
        tasks = []
        remaining = deque()

        while self._idle_queue and len(tasks) < limit:
            task = self._idle_queue.popleft()
            if task.task_type == task_type:
                tasks.append(task)
            else:
                remaining.append(task)

        # 将未匹配的任务放回队列
        self._idle_queue.extendleft(remaining)

        logger.info("批量获取 %s 任务: %d 个", task_type.value, len(tasks))
        return tasks

    # ── 任务完成/失败 ─────────────────────────────────────────────────

    def mark_completed(self, task: Task) -> None:
        """标记任务完成"""
        self._completed_tasks += 1
        logger.debug("任务完成: %s (%s)", task.task_id, task.task_type.value)

    def mark_failed(self, task: Task, error: str) -> None:
        """标记任务失败（支持重试）"""
        task.retries += 1

        if task.retries < task.max_retries:
            # 重新入队
            logger.warning(
                "任务失败，重试 %d/%d: %s - %s",
                task.retries,
                task.max_retries,
                task.task_id,
                error
            )
            self.submit_task(task)
        else:
            # 超过最大重试次数
            self._failed_tasks += 1
            logger.error(
                "任务失败，已达最大重试次数: %s - %s",
                task.task_id,
                error
            )

    # ── 队列状态 ──────────────────────────────────────────────────────

    def get_total_pending(self) -> int:
        """获取待处理任务总数"""
        return (
            len(self._realtime_queue) +
            len(self._on_demand_queue) +
            len(self._idle_queue)
        )

    def get_idle_pending(self) -> int:
        """获取闲时任务数量"""
        return len(self._idle_queue)

    def get_stats(self) -> dict:
        """获取统计信息"""
        return {
            "total_submitted": self._total_tasks,
            "completed": self._completed_tasks,
            "failed": self._failed_tasks,
            "pending_realtime": len(self._realtime_queue),
            "pending_on_demand": len(self._on_demand_queue),
            "pending_idle": len(self._idle_queue),
            "total_pending": self.get_total_pending(),
        }

    def clear_idle_queue(self) -> int:
        """清空闲时任务队列（用于紧急情况）"""
        count = len(self._idle_queue)
        self._idle_queue.clear()
        logger.warning("已清空闲时任务队列: %d 个任务", count)
        return count
