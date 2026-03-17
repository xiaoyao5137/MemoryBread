"""
系统资源采样器

每 30 秒采样一次 CPU、内存、磁盘 IO，写入 system_metrics 表。
在闲时计算期间加密采样（每 10 秒一次），便于定位卡顿原因。
"""

import asyncio
import logging
import os
import sqlite3
import time
from pathlib import Path
from typing import Optional

import psutil

logger = logging.getLogger(__name__)

DB_PATH = str(Path.home() / ".workbuddy" / "workbuddy.db")

# 进程自身的 psutil 对象
_PROCESS = psutil.Process(os.getpid())


def _get_available_mb() -> int:
    """获取系统当前可用内存 MB"""
    return int(psutil.virtual_memory().available / 1024 / 1024)


def _sample_once(
    db_path: str,
    context: Optional[str],
    prev_disk_counters,
) -> tuple:
    """
    采样一次系统资源并写入数据库。
    返回 (当前磁盘计数器) 供下次计算增量。
    """
    try:
        # CPU
        cpu_total   = psutil.cpu_percent(interval=None)
        cpu_process = _PROCESS.cpu_percent(interval=None)

        # 内存
        vm = psutil.virtual_memory()
        mem_total_mb   = int(vm.total   / 1024 / 1024)
        mem_used_mb    = int(vm.used    / 1024 / 1024)
        mem_percent    = vm.percent
        mem_process_mb = int(_PROCESS.memory_info().rss / 1024 / 1024)

        # 磁盘 IO 增量
        curr_disk = psutil.disk_io_counters()
        disk_read_mb  = 0.0
        disk_write_mb = 0.0
        if prev_disk_counters and curr_disk:
            disk_read_mb  = (curr_disk.read_bytes  - prev_disk_counters.read_bytes)  / 1024 / 1024
            disk_write_mb = (curr_disk.write_bytes - prev_disk_counters.write_bytes) / 1024 / 1024

        ts = int(time.time() * 1000)
        conn = sqlite3.connect(db_path)
        conn.execute(
            """INSERT INTO system_metrics
               (ts, cpu_total, cpu_process, mem_total_mb, mem_used_mb, mem_percent,
                mem_process_mb, disk_read_mb, disk_write_mb, context)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (ts, cpu_total, cpu_process, mem_total_mb, mem_used_mb, mem_percent,
             mem_process_mb, disk_read_mb, disk_write_mb, context),
        )
        conn.commit()
        conn.close()

        return curr_disk

    except Exception as e:
        logger.warning(f"资源采样失败: {e}")
        return prev_disk_counters


class SystemMetricsSampler:
    """
    系统资源采样器。

    正常模式：每 30 秒采样一次
    闲时计算模式：每 10 秒采样一次（更密集，便于定位卡顿）
    """

    NORMAL_INTERVAL   = 30   # 秒
    IDLE_INTERVAL     = 10   # 秒（闲时计算期间）

    def __init__(self, db_path: str = DB_PATH):
        self.db_path = db_path
        self._running = False
        self._idle_mode = False
        self._task: Optional[asyncio.Task] = None
        self._prev_disk = None

    def set_idle_mode(self, active: bool):
        """切换闲时计算模式（更密集采样）"""
        self._idle_mode = active
        logger.info(f"资源采样模式: {'闲时（10s）' if active else '正常（30s）'}")

    async def start(self):
        self._running = True
        # 初始化 CPU 百分比基准（第一次调用返回 0，需要预热）
        psutil.cpu_percent(interval=None)
        _PROCESS.cpu_percent(interval=None)
        self._prev_disk = psutil.disk_io_counters()
        self._task = asyncio.create_task(self._loop())
        logger.info("系统资源采样器已启动")

    async def stop(self):
        self._running = False
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass

    async def _loop(self):
        while self._running:
            interval = self.IDLE_INTERVAL if self._idle_mode else self.NORMAL_INTERVAL
            await asyncio.sleep(interval)
            context = "idle_compute" if self._idle_mode else "normal"
            self._prev_disk = _sample_once(self.db_path, context, self._prev_disk)


# ── 单次快照（供 IdleComputeEngine 在关键节点调用）────────────────────────────

def snapshot(db_path: str = DB_PATH, context: str = "snapshot"):
    """立即采样一次（同步，用于关键节点打点）"""
    prev = psutil.disk_io_counters()
    _sample_once(db_path, context, prev)


def get_available_mb() -> int:
    return _get_available_mb()
