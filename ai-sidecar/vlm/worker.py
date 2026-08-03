"""
VlmWorker — IPC 视觉理解任务处理器

接收来自 Rust Core Engine 的 VlmRequest，
将截图通过 VlmModel 分析，返回 IpcResponse。
"""

from __future__ import annotations

import asyncio
import logging
import os
import time

from memory_bread_ipc         import IpcRequest, IpcResponse
from memory_bread_ipc.message import VlmResult, SceneType as IpcSceneType

from .backend import SceneType
from .model   import VlmModel

logger = logging.getLogger(__name__)

# 场景类型映射（VlmBackend → IpcSceneType）
_SCENE_MAP: dict[SceneType, IpcSceneType] = {
    SceneType.DOC_WRITING:   IpcSceneType.DOC_WRITING,
    SceneType.IM_CHAT:       IpcSceneType.IM_CHAT,
    SceneType.BROWSING:      IpcSceneType.BROWSING,
    SceneType.CODING:        IpcSceneType.CODING,
    SceneType.SPREADSHEET:   IpcSceneType.SPREADSHEET,
    SceneType.VIDEO_MEETING: IpcSceneType.VIDEO_MEETING,
    SceneType.IDLE:          IpcSceneType.IDLE,
    SceneType.UNKNOWN:       IpcSceneType.UNKNOWN,
}


class VlmWorker:
    """异步 VLM 截图分析任务 Worker"""

    def __init__(self, model: Optional[VlmModel] = None) -> None:
        self._model = model or VlmModel.create_default()

    async def handle(self, req: IpcRequest) -> IpcResponse:
        """处理一个 VlmRequest，返回 VlmResult 或错误响应"""
        t0   = time.monotonic()
        task = req.task

        # 文件预检
        if not os.path.exists(task.screenshot_path):
            latency_ms = int((time.monotonic() - t0) * 1000)
            return IpcResponse.make_error(
                req.id, "FILE_NOT_FOUND",
                f"截图文件不存在: {task.screenshot_path}",
                latency_ms,
            )

        loop = asyncio.get_running_loop()
        try:
            output = await loop.run_in_executor(
                None,
                lambda: self._model.analyze(task.screenshot_path, task.prompt),
            )

            latency_ms  = int((time.monotonic() - t0) * 1000)
            ipc_scene   = _SCENE_MAP.get(output.scene_type, IpcSceneType.UNKNOWN)

            result = VlmResult(
                description = output.description,
                scene_type  = ipc_scene,
                tags        = output.tags,
            )
            return IpcResponse.make_ok(req.id, result, latency_ms)

        except RuntimeError as exc:
            latency_ms = int((time.monotonic() - t0) * 1000)
            logger.error("VLM 失败 id=%s: %s", req.id, exc)
            return IpcResponse.make_error(req.id, "VLM_FAILED", str(exc), latency_ms)

        except Exception as exc:
            latency_ms = int((time.monotonic() - t0) * 1000)
            logger.exception("VlmWorker 意外异常 id=%s: %s", req.id, exc)
            return IpcResponse.make_error(req.id, "INTERNAL_ERROR", str(exc), latency_ms)
