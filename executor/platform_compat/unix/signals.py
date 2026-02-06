# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unix signal handling implementation."""

import os
import signal

from executor.platform_compat.base import SignalHandler


class UnixSignalHandler(SignalHandler):
    """Unix signal handler using POSIX signals."""

    def terminate_gracefully(self, pid: int) -> bool:
        """Send SIGTERM to a process."""
        try:
            os.kill(pid, signal.SIGTERM)
            return True
        except (OSError, ProcessLookupError):
            return False

    def terminate_forcefully(self, pid: int) -> bool:
        """Send SIGKILL to a process."""
        try:
            os.kill(pid, signal.SIGKILL)
            return True
        except (OSError, ProcessLookupError):
            return False

    def get_termination_signal(self) -> int:
        """Get SIGTERM signal number."""
        return signal.SIGTERM

    def get_kill_signal(self) -> int:
        """Get SIGKILL signal number."""
        return signal.SIGKILL
