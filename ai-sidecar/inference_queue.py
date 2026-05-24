"""分级 LLM 推理任务队列。

设计目标：
- ai-sidecar 进程内所有 LLM 推理（RAG /query, /knowledge/extract, /bake/extract,
  background_processor 主循环）通过单一 worker 串行执行，避免多路并发抢
  GPU/Ollama/内存。
- 优先级 P0/P1/P2：
    P0 — 用户在线 RAG 查询（必须快速响应）
    P1 — knowledge 提炼
    P2 — bake 提炼大批量
- 同优先级内 FIFO；高优先级整体先于低优先级出队。
- 长度淘汰：
    单优先级队列 > 32：丢最老（FIFO），future.set_exception(QueueEvictedError)
    总队列 > 64：只保留 P0，P1/P2 全部 evict
- 内存门禁：可用内存 < 500MB 时 worker 暂停取任务，每 2s 重试。
- 接口：`submit_sync(priority, fn, timeout=...)` 给 Flask 同步路由用；
       内部维护 daemon 线程跑独立 asyncio event loop。
"""
from __future__ import annotations

import collections
import concurrent.futures
import enum
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

import psutil

logger = logging.getLogger(__name__)


class Priority(enum.IntEnum):
    P0 = 0
    P1 = 1
    P2 = 2


class QueueEvictedError(RuntimeError):
    """任务因队列过载被淘汰。"""


class QueueShutdownError(RuntimeError):
    """队列已关闭。"""


@dataclass
class _Task:
    priority: Priority
    seq: int
    fn: Callable[[], Any]
    future: concurrent.futures.Future = field(repr=False)
    enqueued_at: float = field(default_factory=time.monotonic)


_DEFAULT_PER_PRIORITY_LIMIT = 32
_DEFAULT_TOTAL_LIMIT = 64
_LOW_MEMORY_THRESHOLD_MB = 500
_MEMORY_RECHECK_INTERVAL = 2.0


class InferenceQueue:
    def __init__(
        self,
        per_priority_limit: int = _DEFAULT_PER_PRIORITY_LIMIT,
        total_limit: int = _DEFAULT_TOTAL_LIMIT,
        low_memory_threshold_mb: int = _LOW_MEMORY_THRESHOLD_MB,
    ):
        self._per_priority_limit = per_priority_limit
        self._total_limit = total_limit
        self._low_mem_mb = low_memory_threshold_mb
        self._queues: dict[Priority, collections.deque[_Task]] = {
            p: collections.deque() for p in Priority
        }
        self._cv = threading.Condition()
        self._seq = 0
        self._shutdown = False
        self._stats = {
            p.name: {"submitted": 0, "completed": 0, "evicted": 0, "failed": 0}
            for p in Priority
        }
        self._worker_thread = threading.Thread(
            target=self._worker_loop, name="InferenceQueueWorker", daemon=True
        )
        self._worker_thread.start()
        logger.info(
            "InferenceQueue 启动 per_priority_limit=%d total_limit=%d low_mem_mb=%d",
            per_priority_limit, total_limit, low_memory_threshold_mb,
        )

    # ── 公共接口 ──────────────────────────────────────────────────────────

    def submit(self, priority: Priority, fn: Callable[[], Any]) -> concurrent.futures.Future:
        """非阻塞提交：返回 Future，调用方自行 .result()。"""
        if self._shutdown:
            raise QueueShutdownError("InferenceQueue 已关闭")
        future: concurrent.futures.Future = concurrent.futures.Future()
        with self._cv:
            self._seq += 1
            task = _Task(priority=priority, seq=self._seq, fn=fn, future=future)
            self._queues[priority].append(task)
            self._stats[priority.name]["submitted"] += 1
            self._evict_if_needed_locked()
            self._cv.notify_all()
        return future

    def submit_sync(
        self, priority: Priority, fn: Callable[[], Any], timeout: Optional[float] = None
    ) -> Any:
        """阻塞提交：内部 await future.result(timeout)。"""
        future = self.submit(priority, fn)
        return future.result(timeout=timeout)

    def stats(self) -> dict[str, Any]:
        with self._cv:
            return {
                "queue_lengths": {p.name: len(q) for p, q in self._queues.items()},
                "totals": dict(self._stats),
                "available_mb": self._available_mb(),
            }

    def shutdown(self) -> None:
        with self._cv:
            self._shutdown = True
            self._cv.notify_all()
            for q in self._queues.values():
                while q:
                    task = q.popleft()
                    if not task.future.done():
                        task.future.set_exception(QueueShutdownError("队列已关闭"))

    # ── 内部 ──────────────────────────────────────────────────────────────

    def _evict_if_needed_locked(self) -> None:
        # 1) 同优先级队列超 limit：FIFO 丢最老
        for p, q in self._queues.items():
            while len(q) > self._per_priority_limit:
                victim = q.popleft()
                self._stats[p.name]["evicted"] += 1
                if not victim.future.done():
                    victim.future.set_exception(
                        QueueEvictedError(
                            f"{p.name} 队列超 {self._per_priority_limit}，最老任务被淘汰"
                        )
                    )
                logger.warning(
                    "InferenceQueue evict %s seq=%d 等待时长=%.2fs",
                    p.name, victim.seq, time.monotonic() - victim.enqueued_at,
                )

        # 2) 总队列超 total_limit：保留 P0，丢 P1/P2 最老
        total = sum(len(q) for q in self._queues.values())
        while total > self._total_limit:
            evicted = False
            for p in (Priority.P2, Priority.P1):
                if self._queues[p]:
                    victim = self._queues[p].popleft()
                    self._stats[p.name]["evicted"] += 1
                    if not victim.future.done():
                        victim.future.set_exception(
                            QueueEvictedError(
                                f"总队列超 {self._total_limit}，{p.name} 任务被让位 P0"
                            )
                        )
                    logger.warning(
                        "InferenceQueue overflow evict %s seq=%d total_was=%d",
                        p.name, victim.seq, total,
                    )
                    total -= 1
                    evicted = True
                    break
            if not evicted:
                break  # 全是 P0，无法再淘汰

    def _pop_highest_locked(self) -> Optional[_Task]:
        for p in Priority:  # IntEnum 自然顺序 P0 < P1 < P2
            if self._queues[p]:
                return self._queues[p].popleft()
        return None

    def _available_mb(self) -> int:
        try:
            return int(psutil.virtual_memory().available / 1024 / 1024)
        except Exception:
            return 1 << 30  # 拿不到就当作"内存充足"，fail-open

    def _worker_loop(self) -> None:
        while True:
            task: Optional[_Task] = None
            with self._cv:
                # 等待非空 / 关闭
                while not self._shutdown and all(
                    not q for q in self._queues.values()
                ):
                    self._cv.wait()
                if self._shutdown:
                    return
                # 内存门禁：内存不足时不取任务，2s 后再检查
                avail = self._available_mb()
                if avail < self._low_mem_mb:
                    logger.warning(
                        "InferenceQueue 内存门禁 avail=%dMB < %dMB，暂停 worker %.1fs",
                        avail, self._low_mem_mb, _MEMORY_RECHECK_INTERVAL,
                    )
                    self._cv.wait(timeout=_MEMORY_RECHECK_INTERVAL)
                    continue
                task = self._pop_highest_locked()

            if task is None:
                continue

            wait_ms = int((time.monotonic() - task.enqueued_at) * 1000)
            logger.info(
                "InferenceQueue exec %s seq=%d wait_ms=%d",
                task.priority.name, task.seq, wait_ms,
            )
            t0 = time.monotonic()
            try:
                result = task.fn()
                if not task.future.done():
                    task.future.set_result(result)
                with self._cv:
                    self._stats[task.priority.name]["completed"] += 1
            except Exception as exc:  # noqa: BLE001
                logger.exception(
                    "InferenceQueue task 失败 %s seq=%d",
                    task.priority.name, task.seq,
                )
                if not task.future.done():
                    task.future.set_exception(exc)
                with self._cv:
                    self._stats[task.priority.name]["failed"] += 1
            finally:
                exec_ms = int((time.monotonic() - t0) * 1000)
                logger.info(
                    "InferenceQueue done %s seq=%d exec_ms=%d",
                    task.priority.name, task.seq, exec_ms,
                )


# ── 模块级单例（model_api_server.py 启动时引用）──────────────────────────────

_GLOBAL: Optional[InferenceQueue] = None
_GLOBAL_LOCK = threading.Lock()


def get_global_queue() -> InferenceQueue:
    """获取进程级单例队列，惰性创建。"""
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = InferenceQueue()
    return _GLOBAL
