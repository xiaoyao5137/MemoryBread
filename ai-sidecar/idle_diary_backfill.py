"""Idle diary backfill worker.

When the local inference queue has no queued or running work, this worker asks
TaskExecutor to generate one missing historical daily diary. It deliberately
processes one date per idle window so RAG/query work can reclaim the model
quickly.
"""

from __future__ import annotations

import logging
import os
import threading
import time
from typing import Callable, Optional

from scheduled_task_executor import (
    IDLE_DIARY_BACKFILL_LOOKBACK_DAYS,
    TaskExecutor,
)

logger = logging.getLogger(__name__)


def _env_bool(name: str, default: bool = True) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off"}


class IdleDiaryBackfillWorker:
    def __init__(
        self,
        db_path: str,
        *,
        executor: Optional[TaskExecutor] = None,
        queue_provider: Optional[Callable[[], object]] = None,
        enabled: Optional[bool] = None,
        interval_secs: Optional[float] = None,
        stable_idle_secs: Optional[float] = None,
        cooldown_secs: Optional[float] = None,
        lookback_days: Optional[int] = None,
    ) -> None:
        self.db_path = db_path
        self.executor = executor or TaskExecutor(db_path=db_path)
        self.queue_provider = queue_provider or self._default_queue_provider
        self.enabled = _env_bool("DIARY_IDLE_BACKFILL_ENABLED", True) if enabled is None else enabled
        self.interval_secs = interval_secs if interval_secs is not None else float(
            os.getenv("DIARY_IDLE_BACKFILL_CHECK_SECS", "60")
        )
        self.stable_idle_secs = stable_idle_secs if stable_idle_secs is not None else float(
            os.getenv("DIARY_IDLE_BACKFILL_STABLE_SECS", "60")
        )
        self.cooldown_secs = cooldown_secs if cooldown_secs is not None else float(
            os.getenv("DIARY_IDLE_BACKFILL_COOLDOWN_SECS", "300")
        )
        self.lookback_days = lookback_days if lookback_days is not None else IDLE_DIARY_BACKFILL_LOOKBACK_DAYS
        self._running = False
        self._thread: Optional[threading.Thread] = None
        self._idle_since: Optional[float] = None
        self._last_attempt_at: Optional[float] = None

    def start(self) -> None:
        if not self.enabled:
            logger.info("闲时历史日记补齐已禁用")
            return
        if self._thread and self._thread.is_alive():
            return

        self._running = True
        self._thread = threading.Thread(
            target=self._run,
            name="idle-diary-backfill",
            daemon=True,
        )
        self._thread.start()
        logger.info(
            "闲时历史日记补齐 worker 已启动: interval=%ss stable=%ss cooldown=%ss lookback=%sd",
            self.interval_secs,
            self.stable_idle_secs,
            self.cooldown_secs,
            self.lookback_days,
        )

    def stop(self) -> None:
        self._running = False

    def tick(self, now: Optional[float] = None) -> dict:
        """Run one polling tick. Exposed for tests."""
        if not self.enabled:
            return {"status": "disabled"}

        now = now if now is not None else time.monotonic()
        if not self._queue_is_idle():
            self._idle_since = None
            return {"status": "busy"}

        if self._idle_since is None:
            self._idle_since = now
            return {"status": "warming_idle"}

        if now - self._idle_since < self.stable_idle_secs:
            return {
                "status": "warming_idle",
                "idle_elapsed_secs": now - self._idle_since,
            }

        if self._last_attempt_at is not None and now - self._last_attempt_at < self.cooldown_secs:
            return {
                "status": "cooldown",
                "remaining_secs": self.cooldown_secs - (now - self._last_attempt_at),
            }

        self._last_attempt_at = now
        result = self.executor.execute_idle_diary_backfill_once(
            lookback_days=self.lookback_days,
        )
        if result.get("status") == "success":
            self._idle_since = None
            logger.info(
                "闲时历史日记补齐完成: date=%s source_count=%s",
                result.get("diary_date"),
                result.get("source_count"),
            )
        elif result.get("status") == "failed":
            logger.warning("闲时历史日记补齐失败: %s", result.get("error"))
        return result

    def _run(self) -> None:
        while self._running:
            try:
                time.sleep(max(1.0, self.interval_secs))
                self.tick()
            except Exception as exc:
                logger.warning("闲时历史日记补齐 tick 异常: %s", exc, exc_info=True)
                time.sleep(max(5.0, self.interval_secs))

    def _queue_is_idle(self) -> bool:
        try:
            queue = self.queue_provider()
            if hasattr(queue, "is_idle"):
                return bool(queue.is_idle())
            stats = queue.stats()
            return (
                int(stats.get("running_total") or 0) == 0
                and all(int(value or 0) == 0 for value in stats.get("queue_lengths", {}).values())
            )
        except Exception as exc:
            logger.debug("读取推理队列空闲状态失败: %s", exc)
            return False

    @staticmethod
    def _default_queue_provider() -> object:
        from inference_queue import get_global_queue

        return get_global_queue()
