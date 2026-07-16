from __future__ import annotations

import pytest

from runtime_lock import SidecarAlreadyRunningError, SidecarInstanceLock


def test_sidecar_instance_lock_rejects_second_owner(tmp_path):
    path = tmp_path / "sidecar.lock"
    first = SidecarInstanceLock(path)
    second = SidecarInstanceLock(path)

    first.acquire()
    try:
        with pytest.raises(SidecarAlreadyRunningError):
            second.acquire()
    finally:
        first.release()


def test_sidecar_instance_lock_can_be_reacquired_after_release(tmp_path):
    path = tmp_path / "sidecar.lock"
    first = SidecarInstanceLock(path)
    second = SidecarInstanceLock(path)

    first.acquire()
    first.release()
    second.acquire()
    second.release()
