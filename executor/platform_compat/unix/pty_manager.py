# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unix PTY management implementation."""

import fcntl
import os
import select
import subprocess
import time
from typing import Dict, List, Optional

from ptyprocess import PtyProcess as RawPtyProcess

from executor.platform_compat.base import PtyManager, PtyProcess


class UnixPtyProcess(PtyProcess):
    """Unix PTY process wrapper backed by ptyprocess."""

    def __init__(
        self,
        process: RawPtyProcess,
    ):
        self._process = process
        self.stdin = None

    def read(self, size: int = 4096) -> bytes:
        """Read data from the PTY master."""
        try:
            return self._process.read(size)
        except (EOFError, OSError):
            return b""

    def write(self, data: bytes) -> int:
        """Write data to the PTY master."""
        return self._process.write(data)

    def resize(self, rows: int, cols: int) -> None:
        """Resize the PTY window."""
        self._process.setwinsize(rows, cols)

    def poll(self) -> Optional[int]:
        """Check if the process has terminated."""
        if self._process.isalive():
            return None
        return self.returncode

    def terminate(self, force: bool = False) -> None:
        """Terminate the process."""
        self._process.terminate(force=force)

    def kill(self) -> None:
        """Forcefully terminate the process."""
        self._process.terminate(force=True)

    def send_signal(self, signal: int) -> None:
        """Send a signal to the process."""
        self._process.kill(signal)

    def wait(self, timeout: Optional[float] = None) -> int:
        """Wait for the process to terminate."""
        if timeout is None:
            self._process.wait()
            return self.returncode or 0

        deadline = time.monotonic() + timeout
        while self._process.isalive():
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(self._process.pid, timeout)
            time.sleep(0.05)
        return self.returncode or 0

    @property
    def pid(self) -> int:
        """Get the process ID."""
        return int(self._process.pid)

    @property
    def returncode(self) -> Optional[int]:
        """Get the return code."""
        exit_status = getattr(self._process, "exitstatus", None)
        if exit_status is not None:
            return int(exit_status)
        signal_status = getattr(self._process, "signalstatus", None)
        if signal_status is not None:
            return -int(signal_status)
        return None

    @property
    def fd(self) -> int:
        """Get the master file descriptor."""
        return int(self._process.fd)

    def close(self) -> None:
        """Close the PTY process."""
        self._process.close(force=True)


class UnixPtyManager(PtyManager):
    """Unix PTY manager using pty module."""

    def spawn(
        self,
        cmd: List[str],
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        rows: int = 24,
        cols: int = 80,
    ) -> UnixPtyProcess:
        """Spawn a new process with a PTY."""
        if env is None:
            env = os.environ.copy()
        env["TERM"] = env.get("TERM", "xterm-256color")

        process = RawPtyProcess.spawn(
            cmd,
            cwd=cwd,
            env=env,
            dimensions=(rows, cols),
        )

        return UnixPtyProcess(process)

    def is_available(self) -> bool:
        """Check if PTY support is available."""
        return True

    def set_nonblocking(self, fd: int) -> None:
        """Set a file descriptor to non-blocking mode."""
        flags = fcntl.fcntl(fd, fcntl.F_GETFL)
        fcntl.fcntl(fd, fcntl.F_SETFL, flags | os.O_NONBLOCK)

    def read_available(self, fd: int, timeout: float = 0.5) -> Optional[bytes]:
        """Read available data from file descriptor with timeout."""
        ready, _, _ = select.select([fd], [], [], timeout)
        if ready:
            try:
                return os.read(fd, 4096)
            except OSError:
                return None
        return None
