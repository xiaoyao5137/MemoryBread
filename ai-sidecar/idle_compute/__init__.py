"""
闲时计算模块初始化
"""

from __future__ import annotations

from .idle_detector import IdleDetector
from .task_scheduler import TaskScheduler, Task, TaskType, TaskPriority
from .model_manager import ModelManager, ModelType
from .engine import IdleComputeEngine

__all__ = [
    "IdleDetector",
    "TaskScheduler",
    "Task",
    "TaskType",
    "TaskPriority",
    "ModelManager",
    "ModelType",
    "IdleComputeEngine",
]
