"""分级 LLM 推理任务队列。

设计目标：
- ai-sidecar 进程内所有 LLM 推理（RAG /query, /knowledge/extract, /bake/extract,
  background_processor 主循环）通过统一队列调度，避免无控制地抢 GPU/Ollama/内存。
- 优先级 P0/P1/P2：
    P0 — 用户在线咨询与创作（立即抢占后台推理）
    P1 — 时间线提炼（Timeline Extraction）
    P2 — bake 提炼大批量
- 推理并发由供电状态自动决定：外接电源为 3，使用电池为 1。
  P0 保留快速通道，P1/P2 后台 lane 不占满全部并发。
- 同优先级内 FIFO；高优先级整体先于低优先级出队，阻塞 lane 不影响同优先级其他 lane。
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


class InferencePreemptedError(QueueEvictedError):
    """后台推理因在线咨询或创作到达而主动让出。"""


@dataclass
class _Task:
    priority: Priority
    seq: int
    fn: Callable[[], Any]
    lane: str
    future: concurrent.futures.Future = field(repr=False)
    enqueued_at: float = field(default_factory=time.monotonic)
    global_slot_handle: Any = field(default=None, repr=False)
    interactive_demand_handle: Any = field(default=None, repr=False)
    preempt_event: threading.Event = field(default_factory=threading.Event, repr=False)
    preempt_callbacks: list[Callable[[], None]] = field(default_factory=list, repr=False)
    preempt_lock: threading.Lock = field(default_factory=threading.Lock, repr=False)

    def request_preempt(self) -> list[Callable[[], None]]:
        with self.preempt_lock:
            if self.preempt_event.is_set():
                return []
            self.preempt_event.set()
            return list(self.preempt_callbacks)

    def register_preempt_callback(self, callback: Callable[[], None]) -> bool:
        with self.preempt_lock:
            if self.preempt_event.is_set():
                return False
            self.preempt_callbacks.append(callback)
            return True

    def unregister_preempt_callback(self, callback: Callable[[], None]) -> None:
        with self.preempt_lock:
            try:
                self.preempt_callbacks.remove(callback)
            except ValueError:
                pass


LANE_P0_QUERY = "p0_query"
LANE_P0_CREATION = "p0_creation"
LANE_P1_CAPTURE = "p1_capture"
LANE_P1_PREEXTRACT = "p1_preextract"
LANE_P2_BAKE = "p2_bake"
LANE_P2_DIARY = "p2_diary"

_DEFAULT_PER_PRIORITY_LIMIT = 32
_DEFAULT_TOTAL_LIMIT = 64
_LOW_MEMORY_THRESHOLD_MB = 500
_MEMORY_RECHECK_INTERVAL = 2.0
# 内存不足持续超过此秒数时，evict 所有 P2 任务，防止 worker 无限空转
_MEMORY_PRESSURE_EVICT_SECS = 30.0
_MAX_CONCURRENCY_CAP = 3
_DEFAULT_MAX_CONCURRENCY = 1
_POWER_STATE_REFRESH_SECS = 5.0
_BACKGROUND_PREEMPT_COOLDOWN_SECS = 120.0
_GLOBAL_SLOT_PREFIX = "/tmp/memory-bread-inference-slot"
_INTERACTIVE_DEMAND_LOCK_FILE = "/tmp/memory-bread-interactive-demand.lock"
_PREEMPT_POLL_INTERVAL_SECS = 0.05


class InferenceQueue:
    def __init__(
        self,
        per_priority_limit: int = _DEFAULT_PER_PRIORITY_LIMIT,
        total_limit: int = _DEFAULT_TOTAL_LIMIT,
        low_memory_threshold_mb: int = _LOW_MEMORY_THRESHOLD_MB,
        max_concurrency: Optional[int] = None,
        lane_limits: Optional[dict[str, int]] = None,
        power_provider: Optional[Callable[[], object]] = None,
        global_slot_prefix: Optional[str] = None,
    ):
        self._per_priority_limit = per_priority_limit
        self._total_limit = total_limit
        self._low_mem_mb = low_memory_threshold_mb
        self._power_provider = power_provider or psutil.sensors_battery
        self._power_aware = max_concurrency is None
        # 固定并发只用于内部测试；真实的供电感知队列通过 flock 在 main.py 与
        # model_api_server.py 两个进程之间共享整机并发槽。
        self._global_slot_prefix = (
            global_slot_prefix or _GLOBAL_SLOT_PREFIX
            if self._power_aware
            else None
        )
        self._last_power_state_refresh = 0.0
        self._last_background_preempted_at = 0.0
        self._on_external_power: Optional[bool] = None
        if self._power_aware:
            self._max_concurrency = self._power_aware_max_concurrency()
        else:
            self._max_concurrency = self._normalize_max_concurrency(max_concurrency)
        self._lane_limits = {
            LANE_P0_QUERY: _MAX_CONCURRENCY_CAP,
            LANE_P0_CREATION: _MAX_CONCURRENCY_CAP,
            LANE_P1_CAPTURE: 1,
            LANE_P1_PREEXTRACT: 1,
            LANE_P2_BAKE: self._background_concurrency_limit(),
            LANE_P2_DIARY: 1,
        }
        if lane_limits:
            self._lane_limits.update({k: max(1, int(v)) for k, v in lane_limits.items()})
        self._active_total = 0
        self._active_by_lane: dict[str, int] = collections.defaultdict(int)
        self._active_by_priority: dict[Priority, int] = collections.defaultdict(int)
        self._active_tasks: dict[int, _Task] = {}
        self._queues: dict[Priority, collections.deque[_Task]] = {
            p: collections.deque() for p in Priority
        }
        self._cv = threading.Condition()
        self._seq = 0
        self._shutdown = False
        self._stats = {
            p.name: {
                "submitted": 0,
                "completed": 0,
                "evicted": 0,
                "preempted": 0,
                "failed": 0,
            }
            for p in Priority
        }
        # P0 (RAG 查询) 执行时持有此文件锁，让 extractor_v2._rag_is_active() 能正确检测
        self._rag_lock_file = "/tmp/memory-bread-rag.lock"
        self._rag_lock_owner_file = "/tmp/memory-bread-rag-owner.txt"
        self._worker_threads = [
            threading.Thread(
                target=self._worker_loop,
                name=f"InferenceQueueWorker-{i + 1}",
                daemon=True,
            )
            for i in range(_MAX_CONCURRENCY_CAP)
        ]
        for worker in self._worker_threads:
            worker.start()
        logger.info(
            "InferenceQueue 启动 per_priority_limit=%d total_limit=%d low_mem_mb=%d max_concurrency=%d",
            per_priority_limit, total_limit, low_memory_threshold_mb, self._max_concurrency,
        )

    # ── 公共接口 ──────────────────────────────────────────────────────────

    def submit(
        self,
        priority: Priority,
        fn: Callable[[], Any],
        lane: Optional[str] = None,
    ) -> concurrent.futures.Future:
        """非阻塞提交：返回 Future，调用方自行 .result()。"""
        if self._shutdown:
            raise QueueShutdownError("InferenceQueue 已关闭")
        future: concurrent.futures.Future = concurrent.futures.Future()
        callbacks: list[Callable[[], None]] = []
        with self._cv:
            self._refresh_power_state_locked()
            self._seq += 1
            task = _Task(
                priority=priority,
                seq=self._seq,
                fn=fn,
                future=future,
                lane=lane or self._default_lane(priority),
            )
            if priority == Priority.P0:
                task.interactive_demand_handle = _acquire_interactive_demand()
                callbacks = self._request_background_preemption_locked()
            self._queues[priority].append(task)
            self._stats[priority.name]["submitted"] += 1
            self._evict_if_needed_locked()
            self._cv.notify_all()
        _invoke_preempt_callbacks(callbacks)
        return future

    def submit_sync(
        self,
        priority: Priority,
        fn: Callable[[], Any],
        timeout: Optional[float] = None,
        lane: Optional[str] = None,
    ) -> Any:
        """阻塞提交：内部 await future.result(timeout)。"""
        if getattr(_WORKER_STATE, "queue", None) is self:
            logger.debug("InferenceQueue reentrant submit_sync，直接执行 %s", priority.name)
            return fn()
        future = self.submit(priority, fn, lane=lane)
        return future.result(timeout=timeout)

    def stats(self) -> dict[str, Any]:
        with self._cv:
            self._refresh_power_state_locked()
            return self._stats_locked()

    def is_idle(self) -> bool:
        """True when no inference task is queued or running in this process."""
        with self._cv:
            return self._active_total == 0 and all(not q for q in self._queues.values())

    def _stats_locked(self) -> dict[str, Any]:
        now = time.monotonic()
        oldest_wait_ms_by_priority = {
            p.name: (
                max(0, int((now - q[0].enqueued_at) * 1000))
                if q
                else 0
            )
            for p, q in self._queues.items()
        }
        background_retry_after_ms = (
            max(
                0,
                int(
                    (
                        _BACKGROUND_PREEMPT_COOLDOWN_SECS
                        - (now - self._last_background_preempted_at)
                    )
                    * 1000
                ),
            )
            if self._last_background_preempted_at > 0
            else 0
        )
        return {
            "queue_lengths": {p.name: len(q) for p, q in self._queues.items()},
            "queue_lengths_by_lane": self._queue_lengths_by_lane_locked(),
            "oldest_wait_ms_by_priority": oldest_wait_ms_by_priority,
            "oldest_wait_ms": max(oldest_wait_ms_by_priority.values(), default=0),
            "running_total": self._active_total,
            "running_by_lane": dict(self._active_by_lane),
            "running_by_priority": {
                priority.name: self._active_by_priority.get(priority, 0)
                for priority in Priority
            },
            "max_concurrency": self._max_concurrency,
            "concurrency_mode": "power_aware" if self._power_aware else "fixed",
            "on_external_power": self._on_external_power,
            "cross_process_limit": self._max_concurrency if self._global_slot_prefix else None,
            "interactive_demand_active": interactive_demand_active(),
            "background_retry_after_ms": background_retry_after_ms,
            "lane_limits": dict(self._lane_limits),
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
                    _release_interactive_demand(task)
                    if not task.future.done():
                        task.future.set_exception(QueueShutdownError("队列已关闭"))

    # ── 内部 ──────────────────────────────────────────────────────────────

    def _evict_if_needed_locked(self) -> None:
        # 1) 同优先级队列超 limit：FIFO 丢最老
        for p, q in self._queues.items():
            while len(q) > self._per_priority_limit:
                victim = q.popleft()
                _release_interactive_demand(victim)
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
                    _release_interactive_demand(victim)
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
            q = self._queues[p]
            for idx, task in enumerate(q):
                if self._can_run_locked(task) and self._try_acquire_global_slot_locked(task):
                    del q[idx]
                    self._active_total += 1
                    self._active_by_lane[task.lane] += 1
                    self._active_by_priority[task.priority] += 1
                    self._active_tasks[task.seq] = task
                    return task
        return None

    def _request_background_preemption_locked(self) -> list[Callable[[], None]]:
        callbacks: list[Callable[[], None]] = []
        for task in self._active_tasks.values():
            if task.priority == Priority.P0:
                continue
            callbacks.extend(task.request_preempt())
            logger.info(
                "InferenceQueue preempt request %s seq=%d for interactive P0",
                task.priority.name,
                task.seq,
            )
        return callbacks

    def _available_mb(self) -> int:
        try:
            return int(psutil.virtual_memory().available / 1024 / 1024)
        except Exception:
            return 1 << 30  # 拿不到就当作"内存充足"，fail-open

    def _worker_loop(self) -> None:
        _low_mem_since: float | None = None
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
                    if _low_mem_since is None:
                        _low_mem_since = time.monotonic()
                    logger.warning(
                        "InferenceQueue 内存门禁 avail=%dMB < %dMB，暂停 worker %.1fs",
                        avail, self._low_mem_mb, _MEMORY_RECHECK_INTERVAL,
                    )
                    # 内存持续不足超过阈值时，evict 所有 P2 任务，防止 worker 无限空转
                    if time.monotonic() - _low_mem_since >= _MEMORY_PRESSURE_EVICT_SECS:
                        q2 = self._queues[Priority.P2]
                        while q2:
                            victim = q2.popleft()
                            self._stats[Priority.P2.name]["evicted"] += 1
                            if not victim.future.done():
                                victim.future.set_exception(
                                    QueueEvictedError(
                                        f"内存持续不足 {_MEMORY_PRESSURE_EVICT_SECS:.0f}s，P2 任务被强制淘汰"
                                    )
                                )
                        logger.error(
                            "InferenceQueue 内存压力超 %.0fs，P2 全部 evict",
                            _MEMORY_PRESSURE_EVICT_SECS,
                        )
                        _low_mem_since = None  # 重置计时，下一轮压力重新计
                    self._cv.wait(timeout=_MEMORY_RECHECK_INTERVAL)
                    continue
                _low_mem_since = None  # 内存恢复正常，重置计时
                self._refresh_power_state_locked()
                task = self._pop_highest_locked()
                if task is None:
                    self._cv.wait(timeout=0.1)
                    continue

            if task is None:
                continue

            preempt_watch_stop = threading.Event()
            preempt_watcher = None
            if task.priority != Priority.P0:
                preempt_watcher = threading.Thread(
                    target=self._watch_external_preemption,
                    args=(task, preempt_watch_stop),
                    name=f"InferencePreemptWatcher-{task.seq}",
                    daemon=True,
                )
                preempt_watcher.start()

            wait_ms = int((time.monotonic() - task.enqueued_at) * 1000)
            logger.info(
                "InferenceQueue exec %s seq=%d wait_ms=%d",
                task.priority.name, task.seq, wait_ms,
            )

            # P0 (RAG 查询) 执行时持有 RAG 文件锁
            # 这样 extractor_v2._rag_is_active() 能正确检测到 RAG 正在占用 Ollama
            rag_lock_fd = None
            if task.priority == Priority.P0:
                try:
                    import fcntl
                    rag_lock_fd = open(self._rag_lock_file, "w")
                    fcntl.flock(rag_lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    try:
                        with open(self._rag_lock_owner_file, "w") as f:
                            f.write("query")
                    except Exception:
                        pass
                    logger.debug("InferenceQueue P0 获取 RAG 锁成功")
                except (IOError, OSError):
                    # 拿不到锁说明 RAG 已被其他进程持有，继续执行（队列已保证串行）
                    logger.debug("InferenceQueue P0 RAG 锁已被占用，继续执行")
                    if rag_lock_fd:
                        rag_lock_fd.close()
                        rag_lock_fd = None

            t0 = time.monotonic()
            try:
                _WORKER_STATE.queue = self
                _WORKER_STATE.task = task
                raise_if_preempted()
                result = task.fn()
                raise_if_preempted()
                if not task.future.done():
                    task.future.set_result(result)
                with self._cv:
                    self._stats[task.priority.name]["completed"] += 1
            except InferencePreemptedError as exc:
                logger.info(
                    "InferenceQueue task 已让出 %s seq=%d",
                    task.priority.name,
                    task.seq,
                )
                if not task.future.done():
                    task.future.set_exception(exc)
                with self._cv:
                    self._stats[task.priority.name]["preempted"] += 1
                    self._last_background_preempted_at = time.monotonic()
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
                _WORKER_STATE.queue = None
                _WORKER_STATE.task = None
                preempt_watch_stop.set()
                exec_ms = int((time.monotonic() - t0) * 1000)
                logger.info(
                    "InferenceQueue done %s seq=%d exec_ms=%d",
                    task.priority.name, task.seq, exec_ms,
                )
                # 释放 RAG 锁
                if rag_lock_fd is not None:
                    try:
                        import fcntl
                        fcntl.flock(rag_lock_fd, fcntl.LOCK_UN)
                    except Exception:
                        pass
                    finally:
                        rag_lock_fd.close()
                with self._cv:
                    self._active_total = max(0, self._active_total - 1)
                    self._active_tasks.pop(task.seq, None)
                    if self._active_by_lane.get(task.lane, 0) <= 1:
                        self._active_by_lane.pop(task.lane, None)
                    else:
                        self._active_by_lane[task.lane] -= 1
                    if self._active_by_priority.get(task.priority, 0) <= 1:
                        self._active_by_priority.pop(task.priority, None)
                    else:
                        self._active_by_priority[task.priority] -= 1
                    self._release_global_slot(task)
                    _release_interactive_demand(task)
                    self._cv.notify_all()

    @staticmethod
    def _watch_external_preemption(task: _Task, stop_event: threading.Event) -> None:
        while not stop_event.wait(_PREEMPT_POLL_INTERVAL_SECS):
            if not interactive_demand_active():
                continue
            callbacks = task.request_preempt()
            if callbacks:
                logger.info(
                    "InferenceQueue cross-process preempt %s seq=%d",
                    task.priority.name,
                    task.seq,
                )
                _invoke_preempt_callbacks(callbacks)
            return

    @staticmethod
    def _normalize_max_concurrency(value: int) -> int:
        try:
            parsed = int(value)
        except (TypeError, ValueError):
            parsed = _DEFAULT_MAX_CONCURRENCY
        return max(1, min(_MAX_CONCURRENCY_CAP, parsed))

    @staticmethod
    def _default_lane(priority: Priority) -> str:
        if priority == Priority.P0:
            return LANE_P0_QUERY
        if priority == Priority.P1:
            return LANE_P1_CAPTURE
        return LANE_P2_BAKE

    def _can_run_locked(self, task: _Task) -> bool:
        if self._active_total >= self._max_concurrency:
            return False
        lane_limit = self._lane_limits.get(task.lane, 1)
        if self._active_by_lane.get(task.lane, 0) >= lane_limit:
            return False
        if task.priority != Priority.P0:
            background_limit = (
                self._max_concurrency
                if self._max_concurrency <= 1
                else self._max_concurrency - 1
            )
            if self._active_total >= background_limit:
                return False
        return True

    def _background_concurrency_limit(self) -> int:
        if self._max_concurrency <= 1:
            return 1
        return self._max_concurrency - 1

    def _try_acquire_global_slot_locked(self, task: _Task) -> bool:
        """跨进程获取整机推理槽；P1/P2 在三并发时最多使用前两个槽。

        第三个槽只允许 P0 使用，从而即使 main.py 与 model_api_server.py
        同时有后台积压，也不会把在线咨询完全堵住。
        """
        if not self._global_slot_prefix:
            return True
        if task.global_slot_handle is not None:
            return True

        try:
            import fcntl
        except ImportError:
            # 非 Unix 平台无法使用 flock；保留进程内限制。
            return True

        slot_count = (
            self._max_concurrency
            if task.priority == Priority.P0 or self._max_concurrency <= 1
            else self._max_concurrency - 1
        )
        for slot_index in range(slot_count):
            path = f"{self._global_slot_prefix}-{slot_index}.lock"
            handle = None
            try:
                handle = open(path, "a+")
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                task.global_slot_handle = handle
                return True
            except (IOError, OSError):
                if handle is not None:
                    handle.close()
        return False

    @staticmethod
    def _release_global_slot(task: _Task) -> None:
        handle = task.global_slot_handle
        if handle is None:
            return
        try:
            import fcntl
            fcntl.flock(handle, fcntl.LOCK_UN)
        except (ImportError, IOError, OSError):
            pass
        finally:
            handle.close()
            task.global_slot_handle = None

    def _power_aware_max_concurrency(self) -> int:
        """外接电源用 3 路；电池或传感器异常时用 1 路。

        无电池设备（例如台式机）会返回 None，按外接电源处理。
        读取异常选择 1 路，避免移动设备在状态未知时意外拉高功耗。
        """
        try:
            battery = self._power_provider()
        except Exception as exc:
            logger.warning("读取推理队列供电状态失败，降级为单并发: %s", exc)
            self._on_external_power = False
            return 1
        if battery is None:
            self._on_external_power = True
            return _MAX_CONCURRENCY_CAP
        self._on_external_power = bool(getattr(battery, "power_plugged", False))
        return _MAX_CONCURRENCY_CAP if self._on_external_power else 1

    def _refresh_power_state_locked(self, *, force: bool = False) -> None:
        if not self._power_aware:
            return
        now = time.monotonic()
        if not force and now - self._last_power_state_refresh < _POWER_STATE_REFRESH_SECS:
            return
        self._last_power_state_refresh = now
        next_concurrency = self._power_aware_max_concurrency()
        if next_concurrency == self._max_concurrency:
            return
        previous = self._max_concurrency
        self._max_concurrency = next_concurrency
        self._lane_limits[LANE_P2_BAKE] = self._background_concurrency_limit()
        logger.info(
            "InferenceQueue 供电状态切换 max_concurrency=%d->%d plugged=%s",
            previous,
            next_concurrency,
            self._on_external_power,
        )
        self._cv.notify_all()

    def _queue_lengths_by_lane_locked(self) -> dict[str, int]:
        result: dict[str, int] = {}
        for q in self._queues.values():
            for task in q:
                result[task.lane] = result.get(task.lane, 0) + 1
        return result


def _acquire_interactive_demand():
    """P0 从提交到完成持有共享锁，跨进程通知后台推理立即让出。"""
    try:
        import fcntl
        handle = open(_INTERACTIVE_DEMAND_LOCK_FILE, "a+")
        fcntl.flock(handle, fcntl.LOCK_SH)
        return handle
    except (ImportError, IOError, OSError) as exc:
        logger.warning("获取在线任务抢占锁失败，降级为进程内抢占: %s", exc)
        return None


def _release_interactive_demand(task: _Task) -> None:
    handle = task.interactive_demand_handle
    if handle is None:
        return
    try:
        import fcntl
        fcntl.flock(handle, fcntl.LOCK_UN)
    except (ImportError, IOError, OSError):
        pass
    finally:
        handle.close()
        task.interactive_demand_handle = None


def interactive_demand_active() -> bool:
    """检测其他进程是否有已提交或正在运行的咨询/创作 P0。"""
    try:
        import fcntl
        handle = open(_INTERACTIVE_DEMAND_LOCK_FILE, "a+")
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
            fcntl.flock(handle, fcntl.LOCK_UN)
            return False
        except (IOError, OSError):
            return True
        finally:
            handle.close()
    except (ImportError, IOError, OSError):
        return False


def _invoke_preempt_callbacks(callbacks: list[Callable[[], None]]) -> None:
    for callback in callbacks:
        try:
            callback()
        except Exception as exc:
            logger.debug("执行推理抢占回调失败: %s", exc)


def current_task_preempt_requested() -> bool:
    task = getattr(_WORKER_STATE, "task", None)
    if task is None or task.priority == Priority.P0:
        return False
    if not task.preempt_event.is_set() and interactive_demand_active():
        _invoke_preempt_callbacks(task.request_preempt())
    return task.preempt_event.is_set()


def raise_if_preempted() -> None:
    if current_task_preempt_requested():
        raise InferencePreemptedError("后台推理已让出在线咨询或创作任务")


def register_current_preempt_callback(
    callback: Callable[[], None],
) -> Callable[[], None]:
    """注册当前后台任务的中断回调；P0 或非队列线程中为空操作。"""
    task = getattr(_WORKER_STATE, "task", None)
    if task is None or task.priority == Priority.P0:
        return lambda: None
    if not task.register_preempt_callback(callback):
        _invoke_preempt_callbacks([callback])
        return lambda: None
    return lambda: task.unregister_preempt_callback(callback)


# ── 模块级单例（model_api_server.py 启动时引用）──────────────────────────────

_GLOBAL: Optional[InferenceQueue] = None
_GLOBAL_LOCK = threading.Lock()
_WORKER_STATE = threading.local()


def get_global_queue() -> InferenceQueue:
    """获取进程级供电感知单例队列，惰性创建。"""
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = InferenceQueue()
    return _GLOBAL
