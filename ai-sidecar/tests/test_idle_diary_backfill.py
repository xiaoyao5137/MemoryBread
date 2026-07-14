from idle_diary_backfill import IdleDiaryBackfillWorker


class _Queue:
    def __init__(self, idle: bool) -> None:
        self.idle = idle

    def is_idle(self) -> bool:
        return self.idle


class _Executor:
    def __init__(self) -> None:
        self.calls = 0

    def execute_idle_diary_backfill_once(self, lookback_days: int = 30):
        self.calls += 1
        return {
            "status": "success",
            "diary_date": "2026-07-08",
            "source_count": 1,
            "lookback_days": lookback_days,
        }


def test_idle_worker_does_not_run_when_queue_busy():
    queue = _Queue(idle=False)
    executor = _Executor()
    worker = IdleDiaryBackfillWorker(
        db_path=":memory:",
        executor=executor,
        queue_provider=lambda: queue,
        enabled=True,
        stable_idle_secs=0,
        cooldown_secs=0,
        lookback_days=7,
    )

    assert worker.tick(now=100) == {"status": "busy"}
    assert executor.calls == 0


def test_idle_worker_runs_after_stable_idle_window():
    queue = _Queue(idle=True)
    executor = _Executor()
    worker = IdleDiaryBackfillWorker(
        db_path=":memory:",
        executor=executor,
        queue_provider=lambda: queue,
        enabled=True,
        stable_idle_secs=10,
        cooldown_secs=0,
        lookback_days=7,
    )

    assert worker.tick(now=100)["status"] == "warming_idle"
    assert worker.tick(now=105)["status"] == "warming_idle"
    result = worker.tick(now=111)

    assert result["status"] == "success"
    assert result["diary_date"] == "2026-07-08"
    assert result["lookback_days"] == 7
    assert executor.calls == 1


def test_idle_worker_respects_cooldown():
    queue = _Queue(idle=True)
    executor = _Executor()
    worker = IdleDiaryBackfillWorker(
        db_path=":memory:",
        executor=executor,
        queue_provider=lambda: queue,
        enabled=True,
        stable_idle_secs=0,
        cooldown_secs=60,
    )

    worker.tick(now=100)
    assert worker.tick(now=101)["status"] == "success"
    worker.tick(now=102)
    assert worker.tick(now=103)["status"] == "cooldown"
    assert executor.calls == 1
