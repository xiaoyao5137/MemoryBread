"""
ai-sidecar OCR 模块

对外暴露：
- OcrEngine : 引擎编排器（带 primary/fallback 后端）
- OcrWorker : IPC 任务处理器
- OcrBackend, OcrBox, OcrOutput : 后端接口与数据类型
"""

from __future__ import annotations

from .engine          import OcrEngine
from .worker          import OcrWorker
from .backends.base   import OcrBackend, OcrBox, OcrOutput
from .backends.paddle import PaddleBackend
from .backends.vision import AppleVisionBackend

__all__ = [
    "OcrEngine",
    "OcrWorker",
    "OcrBackend",
    "OcrBox",
    "OcrOutput",
    "PaddleBackend",
    "AppleVisionBackend",
]
