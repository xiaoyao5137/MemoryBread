"""
AsrWorker — IPC 语音转录任务处理器

接收来自 Rust Core Engine 的 AsrRequest，
将音频文件通过 AsrModel 转录，返回 IpcResponse。
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

from memory_bread_ipc         import IpcRequest, IpcResponse
from memory_bread_ipc.message import AsrResult, AsrSegment as IpcAsrSegment

from .model import AsrModel

logger = logging.getLogger(__name__)


class AsrWorker:
    """异步 ASR 转录任务 Worker"""

    def __init__(self, model: Optional[AsrModel] = None) -> None:
        self._model = model or AsrModel.create_default()

    async def handle(self, req: IpcRequest) -> IpcResponse:
        """处理一个 AsrRequest，返回 AsrResult 或错误响应"""
        t0   = time.monotonic()
        task = req.task

        # 文件预检
        if not os.path.exists(task.audio_path):
            latency_ms = int((time.monotonic() - t0) * 1000)
            return IpcResponse.make_error(
                req.id, "FILE_NOT_FOUND",
                f"音频文件不存在: {task.audio_path}",
                latency_ms,
            )

        loop = asyncio.get_running_loop()
        try:
            output = await loop.run_in_executor(
                None,
                lambda: self._model.transcribe(task.audio_path, task.language),
            )

            latency_ms = int((time.monotonic() - t0) * 1000)

            result = AsrResult(
                text     = output.text,
                language = output.language,
                segments = [
                    IpcAsrSegment(
                        start_sec = seg.start_sec,
                        end_sec   = seg.end_sec,
                        text      = seg.text,
                    )
                    for seg in output.segments
                ],
            )
            return IpcResponse.make_ok(req.id, result, latency_ms)

        except RuntimeError as exc:
            latency_ms = int((time.monotonic() - t0) * 1000)
            logger.error("ASR 失败 id=%s: %s", req.id, exc)
            return IpcResponse.make_error(req.id, "ASR_FAILED", str(exc), latency_ms)

        except Exception as exc:
            latency_ms = int((time.monotonic() - t0) * 1000)
            logger.exception("AsrWorker 意外异常 id=%s: %s", req.id, exc)
            return IpcResponse.make_error(req.id, "INTERNAL_ERROR", str(exc), latency_ms)
