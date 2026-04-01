# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Generic PID file management (not update-specific).

Provides simple PID file read/write operations that can be used
across different modules for process tracking.
"""

import json
import logging
import os
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Optional

from executor.config.config import WEGENT_EXECUTOR_HOME
from executor.platform_compat import IS_WINDOWS

logger = logging.getLogger(__name__)


@dataclass
class PIDInfo:
    """Information stored in PID file about a process."""

    pid: int
    start_time: float
    version: str


class PIDManager:
    """Generic PID file management (not update-specific).

    Provides simple read/write operations for PID files used to
    track running processes.
    """

    def __init__(self, pid_dir: Optional[Path] = None):
        """Initialize PID manager.

        Args:
            pid_dir: Directory for PID files. Defaults to WEGENT_EXECUTOR_HOME
        """
        self.pid_dir = pid_dir or Path(WEGENT_EXECUTOR_HOME).expanduser()

    def write_pid_file(self, version: str) -> Path:
        """Write PID file with current process information.

        Args:
            version: Current process version

        Returns:
            Path to the written PID file
        """
        import time

        self.pid_dir.mkdir(parents=True, exist_ok=True)

        pid_file = self.pid_dir / "executor.pid"

        info = PIDInfo(
            pid=os.getpid(),
            start_time=time.time(),
            version=version,
        )

        # Write with restrictive permissions (owner only)
        pid_file.write_text(json.dumps(asdict(info)), encoding="utf-8")

        # Set owner-only permissions on Unix
        if not IS_WINDOWS:
            os.chmod(pid_file, 0o600)

        logger.debug(f"Wrote PID file: {pid_file} (pid={info.pid})")
        return pid_file

    def read_pid_file(self) -> Optional[PIDInfo]:
        """Read PID file and return process information.

        Returns:
            PIDInfo if PID file exists and is valid, None otherwise
        """
        pid_file = self.pid_dir / "executor.pid"

        try:
            if not pid_file.exists():
                return None

            data = json.loads(pid_file.read_text(encoding="utf-8"))
            return PIDInfo(**data)

        except (json.JSONDecodeError, TypeError, KeyError) as e:
            logger.warning(f"Invalid PID file format: {e}")
            # Remove corrupted PID file
            try:
                pid_file.unlink()
            except Exception:
                pass
            return None
        except Exception as e:
            logger.warning(f"Failed to read PID file: {e}")
            return None

    def remove_pid_file(self) -> bool:
        """Remove PID file.

        Returns:
            True if PID file was removed or didn't exist
        """
        pid_file = self.pid_dir / "executor.pid"

        try:
            if pid_file.exists():
                pid_file.unlink()
                logger.debug(f"Removed PID file: {pid_file}")
            return True
        except Exception as e:
            logger.warning(f"Failed to remove PID file: {e}")
            return False

    def is_process_running(self, pid: int) -> bool:
        """Check if a process with the given PID is actually running.

        Args:
            pid: Process ID to check

        Returns:
            True if process is running, False otherwise
        """
        try:
            if IS_WINDOWS:
                # On Windows, use ctypes to check if process exists
                import ctypes

                kernel32 = ctypes.windll.kernel32
                handle = kernel32.OpenProcess(1, False, pid)  # PROCESS_TERMINATE = 1
                if handle:
                    kernel32.CloseHandle(handle)
                    return True
                return False
            else:
                # On Unix, send signal 0 to check if process exists
                os.kill(pid, 0)
                return True

        except (OSError, ProcessLookupError):
            return False
