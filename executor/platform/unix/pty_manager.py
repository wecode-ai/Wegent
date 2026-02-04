# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unix PTY management implementation."""

import fcntl
import os
import pty
import select
import struct
import subprocess
import termios
from typing import Dict, List, Optional

from executor.platform.base import PtyManager, PtyProcess


class UnixPtyProcess(PtyProcess):
    """Unix PTY process wrapper using pty module."""

    def __init__(
        self,
        master_fd: int,
        slave_fd: int,
        process: subprocess.Popen,
        rows: int = 24,
        cols: int = 80,
    ):
        """Initialize Unix PTY process.

        Args:
            master_fd: Master file descriptor.
            slave_fd: Slave file descriptor.
            process: The subprocess.Popen instance.
            rows: Initial terminal rows.
            cols: Initial terminal columns.
        """
        self._master_fd = master_fd
        self._slave_fd = slave_fd
        self._process = process
        self._rows = rows
        self._cols = cols

        # Set initial window size
        self.resize(rows, cols)

    def read(self, size: int = 4096) -> bytes:
        """Read data from the PTY master."""
        try:
            return os.read(self._master_fd, size)
        except OSError:
            return b""

    def write(self, data: bytes) -> int:
        """Write data to the PTY master."""
        return os.write(self._master_fd, data)

    def resize(self, rows: int, cols: int) -> None:
        """Resize the PTY window using TIOCSWINSZ."""
        self._rows = rows
        self._cols = cols
        winsize = struct.pack("HHHH", rows, cols, 0, 0)
        try:
            fcntl.ioctl(self._master_fd, termios.TIOCSWINSZ, winsize)
        except OSError:
            pass

    def poll(self) -> Optional[int]:
        """Check if the process has terminated."""
        return self._process.poll()

    def terminate(self, force: bool = False) -> None:
        """Terminate the process."""
        if force:
            self._process.kill()
        else:
            self._process.terminate()

    def wait(self, timeout: Optional[float] = None) -> int:
        """Wait for the process to terminate."""
        return self._process.wait(timeout=timeout)

    @property
    def pid(self) -> int:
        """Get the process ID."""
        return self._process.pid

    @property
    def returncode(self) -> Optional[int]:
        """Get the return code."""
        return self._process.returncode

    @property
    def fd(self) -> int:
        """Get the master file descriptor."""
        return self._master_fd

    def close(self) -> None:
        """Close file descriptors and wait for process."""
        try:
            os.close(self._master_fd)
        except OSError:
            pass
        try:
            os.close(self._slave_fd)
        except OSError:
            pass
        try:
            self._process.wait(timeout=1)
        except subprocess.TimeoutExpired:
            self._process.kill()
            self._process.wait()


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
        # Create pseudo-terminal pair
        master_fd, slave_fd = pty.openpty()

        # Set up environment
        if env is None:
            env = os.environ.copy()
        env["TERM"] = env.get("TERM", "xterm-256color")

        # Spawn process
        process = subprocess.Popen(
            cmd,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            cwd=cwd,
            env=env,
            preexec_fn=os.setsid,
            start_new_session=True,
        )

        return UnixPtyProcess(master_fd, slave_fd, process, rows, cols)

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
