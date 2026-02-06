# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Windows platform implementations for PTY, permissions, and signals."""

from executor.platform_compat.windows.permissions import WindowsPermissionsManager
from executor.platform_compat.windows.pty_manager import (
    WindowsPtyManager,
    WindowsPtyProcess,
)
from executor.platform_compat.windows.signals import WindowsSignalHandler
from executor.platform_compat.windows.user_info import WindowsUserInfoProvider

__all__ = [
    "WindowsPtyManager",
    "WindowsPtyProcess",
    "WindowsPermissionsManager",
    "WindowsSignalHandler",
    "WindowsUserInfoProvider",
]
