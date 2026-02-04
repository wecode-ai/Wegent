# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Windows platform implementations for PTY, permissions, and signals."""

from executor.platform.windows.permissions import WindowsPermissionsManager
from executor.platform.windows.pty_manager import WindowsPtyManager, WindowsPtyProcess
from executor.platform.windows.signals import WindowsSignalHandler
from executor.platform.windows.user_info import WindowsUserInfoProvider

__all__ = [
    "WindowsPtyManager",
    "WindowsPtyProcess",
    "WindowsPermissionsManager",
    "WindowsSignalHandler",
    "WindowsUserInfoProvider",
]
