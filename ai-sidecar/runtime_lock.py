"""AI Sidecar 进程级单实例锁。"""

from __future__ import annotations

import errno
import os
from pathlib import Path
from typing import TextIO


class SidecarAlreadyRunningError(RuntimeError):
    """同一用户已有 Sidecar 持有实例锁。"""


class SidecarInstanceLock:
    """持有到进程退出的跨平台文件锁。

    锁文件本身会保留；真正的所有权由内核文件锁表示，进程异常退出时也会自动释放。
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        self._handle: TextIO | None = None

    def acquire(self) -> None:
        if self._handle is not None:
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+", encoding="utf-8")
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                if handle.read(1) == "":
                    handle.write("\0")
                    handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            if exc.errno in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                raise SidecarAlreadyRunningError(
                    f"AI Sidecar 已在运行（实例锁: {self.path}）"
                ) from exc
            raise

        handle.seek(0)
        handle.truncate()
        handle.write(str(os.getpid()))
        handle.flush()
        self._handle = handle

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            if os.name == "nt":
                import msvcrt

                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        finally:
            handle.close()

    def __enter__(self) -> "SidecarInstanceLock":
        self.acquire()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.release()
