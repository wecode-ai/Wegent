# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Windows signal handling implementation."""

import ctypes
import signal
import sys
from typing import Optional

from executor.platform.base import SignalHandler

# Import win32 modules only on Windows
if sys.platform == "win32":
    try:
        import win32api
        import win32con
        import win32process

        WIN32_AVAILABLE = True
    except ImportError:
        WIN32_AVAILABLE = False
else:
    WIN32_AVAILABLE = False

# Windows signal approximations
# These are not real signals but we use them for API compatibility
WINDOWS_SIGTERM = 15  # Same number as Unix SIGTERM
WINDOWS_SIGKILL = 9  # Same number as Unix SIGKILL


class WindowsSignalHandler(SignalHandler):
    """Windows signal handler using Win32 API."""

    def __init__(self):
        """Initialize Windows signal handler."""
        self._available = WIN32_AVAILABLE

    def terminate_gracefully(self, pid: int) -> bool:
        """Send a graceful termination signal to a process.

        On Windows, this tries:
        1. GenerateConsoleCtrlEvent (CTRL_BREAK_EVENT) for console apps
        2. If that fails, terminates the process

        Args:
            pid: Process ID to signal.

        Returns:
            True if signal was sent successfully.
        """
        try:
            # Try to send CTRL_BREAK_EVENT first
            # This works for console applications
            kernel32 = ctypes.windll.kernel32
            result = kernel32.GenerateConsoleCtrlEvent(
                win32con.CTRL_BREAK_EVENT if self._available else 1, pid
            )
            if result:
                return True
        except Exception:
            pass

        # Fallback: Try to terminate via Win32 API
        if self._available:
            try:
                handle = win32api.OpenProcess(win32con.PROCESS_TERMINATE, False, pid)
                if handle:
                    # Give a brief moment for cleanup
                    import time

                    time.sleep(0.1)
                    win32api.TerminateProcess(handle, 1)
                    win32api.CloseHandle(handle)
                    return True
            except Exception:
                pass

        # Last resort: os.kill with SIGTERM
        try:
            import os

            os.kill(pid, signal.SIGTERM)
            return True
        except (OSError, ProcessLookupError):
            return False

    def terminate_forcefully(self, pid: int) -> bool:
        """Forcefully terminate a process using TerminateProcess.

        Args:
            pid: Process ID to terminate.

        Returns:
            True if process was terminated successfully.
        """
        if self._available:
            try:
                handle = win32api.OpenProcess(win32con.PROCESS_TERMINATE, False, pid)
                if handle:
                    win32api.TerminateProcess(handle, 1)
                    win32api.CloseHandle(handle)
                    return True
            except Exception:
                pass

        # Fallback using ctypes
        try:
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x0001, False, pid)  # PROCESS_TERMINATE
            if handle:
                result = kernel32.TerminateProcess(handle, 1)
                kernel32.CloseHandle(handle)
                return result != 0
        except Exception:
            pass

        return False

    def get_termination_signal(self) -> int:
        """Get the signal number for graceful termination.

        Returns the standard SIGTERM value for API compatibility.
        """
        return WINDOWS_SIGTERM

    def get_kill_signal(self) -> int:
        """Get the signal number for forceful termination.

        Returns the standard SIGKILL value for API compatibility.
        Note: On Windows, we use TerminateProcess instead of signals.
        """
        return WINDOWS_SIGKILL
