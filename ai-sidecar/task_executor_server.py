"""
定时任务执行 API Server（端口 7071）

Rust 调度器通过 HTTP POST /tasks/execute 触发任务执行。
"""

import logging
import os
from pathlib import Path

import psutil
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from scheduled_task_executor import TaskExecutor

# 资源瓶颈阈值：任一超过时拒绝执行提炼任务
_CPU_THRESHOLD = float(os.getenv("BAKE_CPU_THRESHOLD", "85"))   # %
_MEM_THRESHOLD = float(os.getenv("BAKE_MEM_THRESHOLD", "90"))   # %


def _check_resources() -> tuple[bool, str]:
    """返回 (资源充足, 原因描述)"""
    cpu = psutil.cpu_percent(interval=0.5)
    mem = psutil.virtual_memory().percent
    if cpu >= _CPU_THRESHOLD:
        return False, f"CPU 使用率 {cpu:.1f}% >= {_CPU_THRESHOLD}%"
    if mem >= _MEM_THRESHOLD:
        return False, f"内存使用率 {mem:.1f}% >= {_MEM_THRESHOLD}%"
    return True, ""

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="记忆面包 Task Executor", version="1.0.0")

DB_PATH = str(Path.home() / ".memory-bread" / "memory-bread.db")
executor = TaskExecutor(db_path=DB_PATH)


class ExecuteRequest(BaseModel):
    task_id: int


@app.post("/tasks/execute")
def execute_task(req: ExecuteRequest):
    """Rust 调度器调用此接口触发任务执行"""
    ok, reason = _check_resources()
    if not ok:
        logger.warning(f"系统资源不足，跳过任务 {req.task_id}: {reason}")
        raise HTTPException(status_code=503, detail=f"系统资源不足，稍后重试: {reason}")

    logger.info(f"收到任务执行请求: task_id={req.task_id}")
    result = executor.execute_task(req.task_id)
    if result["status"] == "deferred":
        raise HTTPException(status_code=503, detail=result)
    if result["status"] == "failed":
        raise HTTPException(status_code=500, detail=result.get("error", "执行失败"))
    return result


@app.get("/health")
def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=7071, log_level="info")
