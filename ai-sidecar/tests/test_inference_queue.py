"""inference_queue 的功能测试。"""
import time
from unittest import mock

import pytest

from inference_queue import (
    InferenceQueue,
    LANE_P0_QUERY,
    LANE_P1_CAPTURE,
    LANE_P1_PREEXTRACT,
    LANE_P2_BAKE,
    Priority,
    QueueEvictedError,
)


@pytest.fixture
def small_queue():
    q = InferenceQueue(per_priority_limit=3, total_limit=10, low_memory_threshold_mb=10)
    yield q
    q.shutdown()


def _delayed_factory(order: list, label: str, delay: float = 0.02):
    def fn():
        time.sleep(delay)
        order.append(label)
        return label
    return fn


def test_priority_order_p0_beats_p2(small_queue):
    """正在执行的 P2 完成后，P0 应在 P1 之前出队。"""
    order: list[str] = []
    # 卡住 worker 一段时间
    long_fut = small_queue.submit(Priority.P2, _delayed_factory(order, "P2-long", 0.3))
    time.sleep(0.05)
    p0_futs = [
        small_queue.submit(Priority.P0, _delayed_factory(order, f"P0-{i}", 0.01))
        for i in range(3)
    ]
    p1_fut = small_queue.submit(Priority.P1, _delayed_factory(order, "P1-x", 0.01))

    long_fut.result(timeout=5)
    for f in p0_futs:
        f.result(timeout=5)
    p1_fut.result(timeout=5)

    assert order[0] == "P2-long"
    assert order[1:4] == ["P0-0", "P0-1", "P0-2"]
    assert order[4] == "P1-x"


def test_is_idle_tracks_queued_and_running_tasks(small_queue):
    assert small_queue.is_idle() is True

    fut = small_queue.submit(Priority.P2, _delayed_factory([], "work", 0.1))
    assert small_queue.is_idle() is False

    fut.result(timeout=5)
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if small_queue.is_idle():
            break
        time.sleep(0.01)

    assert small_queue.is_idle() is True


def test_per_priority_eviction_drops_oldest(small_queue):
    """同优先级超过 per_priority_limit 时，丢最老。"""
    order: list[str] = []
    block_fut = small_queue.submit(Priority.P0, _delayed_factory(order, "block", 1.0))
    time.sleep(0.05)
    # per_priority_limit=3，提交 5 个 → 淘汰头 2 个
    p2_futs = [
        small_queue.submit(Priority.P2, _delayed_factory(order, f"P2-{i}", 0.01))
        for i in range(5)
    ]

    # 等头 2 个 future 报错
    deadline = time.monotonic() + 1.0
    while time.monotonic() < deadline:
        if all(p2_futs[i].done() for i in range(2)):
            break
        time.sleep(0.02)

    assert isinstance(p2_futs[0].exception(timeout=0.5), QueueEvictedError)
    assert isinstance(p2_futs[1].exception(timeout=0.5), QueueEvictedError)

    block_fut.result(timeout=5)
    for f in p2_futs[2:]:
        assert f.result(timeout=5).startswith("P2-")


def test_total_limit_keeps_only_p0():
    """总队列超 total_limit 时，按 P2→P1 顺序丢最老，直到队列长度 ≤ total_limit。"""
    q = InferenceQueue(per_priority_limit=20, total_limit=4, low_memory_threshold_mb=10)
    try:
        order: list[str] = []
        block = q.submit(Priority.P0, _delayed_factory(order, "block", 1.0))
        time.sleep(0.05)

        # 3 P0 + 3 P2 = 6，超 total=4 → 丢头 2 个 P2，剩 3 P0 + 1 P2
        p0s = [q.submit(Priority.P0, _delayed_factory(order, f"P0-{i}", 0.01)) for i in range(3)]
        p2s = [q.submit(Priority.P2, _delayed_factory(order, f"P2-{i}", 0.01)) for i in range(3)]

        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            if p2s[0].done() and p2s[1].done():
                break
            time.sleep(0.02)

        # 头 2 个 P2 被淘汰
        assert isinstance(p2s[0].exception(timeout=0.5), QueueEvictedError)
        assert isinstance(p2s[1].exception(timeout=0.5), QueueEvictedError)

        # block 完成后剩余 P0 + 末尾 P2 都应正常完成
        block.result(timeout=5)
        for f in p0s:
            assert f.result(timeout=5).startswith("P0-")
        assert p2s[2].result(timeout=5) == "P2-2"
    finally:
        q.shutdown()


def test_low_memory_blocks_worker():
    """可用内存低于阈值时，worker 不取任务。"""
    q = InferenceQueue(per_priority_limit=8, total_limit=16, low_memory_threshold_mb=999_999)
    try:
        order: list[str] = []
        # 阈值离谱地高，所有任务都该被门禁挡住
        fut = q.submit(Priority.P0, _delayed_factory(order, "should-not-run", 0.01))
        time.sleep(0.5)
        assert not fut.done()
        assert order == []
    finally:
        q.shutdown()


def test_max_concurrency_reserves_p0_lane():
    """max_concurrency=3 时，后台最多占 2 路，P0 仍可立即获得第 3 路。"""
    q = InferenceQueue(per_priority_limit=8, total_limit=16, low_memory_threshold_mb=10, max_concurrency=3)
    try:
        order: list[str] = []
        capture = q.submit(Priority.P1, _delayed_factory(order, "capture", 0.2), lane=LANE_P1_CAPTURE)
        pre = q.submit(Priority.P1, _delayed_factory(order, "pre", 0.2), lane=LANE_P1_PREEXTRACT)
        bake = q.submit(Priority.P2, _delayed_factory(order, "bake", 0.2), lane=LANE_P2_BAKE)
        time.sleep(0.05)

        stats = q.stats()
        assert stats["running_total"] <= 2

        p0 = q.submit(Priority.P0, _delayed_factory(order, "p0", 0.01), lane=LANE_P0_QUERY)
        assert p0.result(timeout=5) == "p0"
        for f in (capture, pre, bake):
            f.result(timeout=5)
    finally:
        q.shutdown()
