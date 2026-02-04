# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Windows PTY management implementation using pywinpty (ConPTY)."""

import os
import sys
from typing import Dict, List, Optional

from executor.platform.base import PtyManager, PtyProcess

# Import winpty only on Windows
if sys.platform == "win32":
    try:
        import winpty

        WINPTY_AVAILABLE = True
    except ImportError:
        WINPTY_AVAILABLE = False
else:
    WINPTY_AVAILABLE = False


class WindowsPtyProcess(PtyProcess):
    """Windows PTY process wrapper using pywinpty (ConPTY)."""

    def __init__(self, pty_process, rows: int = 24, cols: int = 80):
        """Initialize Windows PTY process.

        Args:
            pty_process: The winpty.PtyProcess instance.
            rows: Initial terminal rows.
            cols: Initial terminal columns.
        """
        self._pty = pty_process
        self._rows = rows
        self._cols = cols
        self._returncode: Optional[int] = None

    def read(self, size: int = 4096) -> bytes:
        """Read data from the PTY."""
        try:
            data = self._pty.read(size)
            if data:
                return data.encode("utf-8") if isinstance(data, str) else data
            return b""
        except Exception:
            return b""

    def write(self, data: bytes) -> int:
        """Write data to the PTY."""
        try:
            if isinstance(data, bytes):
                data = data.decode("utf-8", errors="replace")
            self._pty.write(data)
            return len(data)
        except Exception:
            return 0

    def resize(self, rows: int, cols: int) -> None:
        """Resize the PTY window."""
        self._rows = rows
        self._cols = cols
        try:
            self._pty.setwinsize(rows, cols)
        except Exception:
            pass

    def poll(self) -> Optional[int]:
        """Check if the process has terminated."""
        if not self._pty.isalive():
            if self._returncode is None:
                self._returncode = self._pty.exitstatus or 0
            return self._returncode
        return None

    def terminate(self, force: bool = False) -> None:
        """Terminate the process."""
        try:
            if force:
                self._pty.terminate()
            else:
                # Try graceful termination with Ctrl+C
                self._pty.write("\x03")
                # Give it a moment then terminate
                import time

                time.sleep(0.1)
                if self._pty.isalive():
                    self._pty.terminate()
        except Exception:
            pass

    def wait(self, timeout: Optional[float] = None) -> int:
        """Wait for the process to terminate."""
        import time

        start = time.time()
        while self._pty.isalive():
            if timeout is not None and (time.time() - start) > timeout:
                raise TimeoutError("Process did not terminate within timeout")
            time.sleep(0.1)

        self._returncode = self._pty.exitstatus or 0
        return self._returncode

    @property
    def pid(self) -> int:
        """Get the process ID."""
        return self._pty.pid

    @property
    def returncode(self) -> Optional[int]:
        """Get the return code."""
        if self._returncode is None:
            self.poll()
        return self._returncode

    @property
    def fd(self) -> int:
        """Get the file descriptor (not applicable on Windows)."""
        return -1

    def close(self) -> None:
        """Close the PTY process."""
        try:
            if self._pty.isalive():
                self._pty.terminate()
        except Exception:
            pass


class WindowsPtyManager(PtyManager):
    """Windows PTY manager using pywinpty (ConPTY)."""

    def __init__(self):
        """Initialize Windows PTY manager."""
        self._available = WINPTY_AVAILABLE

    def spawn(
        self,
        cmd: List[str],
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        rows: int = 24,
        cols: int = 80,
    ) -> WindowsPtyProcess:
        """Spawn a new process with a PTY using ConPTY."""
        if not self._available:
            raise RuntimeError(
                "pywinpty is not available. Install it with: pip install pywinpty"
            )

        # Build command string for Windows
        if len(cmd) == 1:
            cmd_str = cmd[0]
        else:
            # Quote arguments with spaces
            parts = []
            for arg in cmd:
                if " " in arg and not arg.startswith('"'):
                    parts.append(f'"{arg}"')
                else:
                    parts.append(arg)
            cmd_str = " ".join(parts)

        # Set up environment
        if env is None:
            env = os.environ.copy()

        # Spawn the process
        pty_process = winpty.PtyProcess.spawn(
            cmd_str,
            cwd=cwd,
            env=env,
            dimensions=(rows, cols),
        )

        return WindowsPtyProcess(pty_process, rows, cols)

    def is_available(self) -> bool:
        """Check if PTY support is available."""
        return self._available

    def set_nonblocking(self, fd: int) -> None:
        """No-op on Windows (not applicable)."""
        pass

    def read_available(self, fd: int, timeout: float = 0.5) -> Optional[bytes]:
        """Not applicable on Windows - use PtyProcess.read() instead."""
        return None
