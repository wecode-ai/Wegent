# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Platform abstraction layer for cross-platform executor support.

This module provides unified interfaces for platform-specific operations:
- PTY (pseudo-terminal) management
- File permissions
- Process signals
- User/group information

Usage:
    from executor.platform_compat import (
        get_pty_manager,
        get_permissions_manager,
        get_signal_handler,
        get_user_info_provider,
    )

    # All functions return platform-appropriate implementations
    pty_manager = get_pty_manager()
    permissions = get_permissions_manager()
"""

import sys

# Detect platform once at import time
IS_WINDOWS = sys.platform == "win32"
IS_MACOS = sys.platform == "darwin"
IS_LINUX = sys.platform.startswith("linux")

if IS_WINDOWS:
    from executor.platform_compat.windows import (
        WindowsPermissionsManager as _PermissionsManager,
    )
    from executor.platform_compat.windows import WindowsPtyManager as _PtyManager
    from executor.platform_compat.windows import WindowsSignalHandler as _SignalHandler
    from executor.platform_compat.windows import (
        WindowsUserInfoProvider as _UserInfoProvider,
    )
else:
    from executor.platform_compat.unix import (
        UnixPermissionsManager as _PermissionsManager,
    )
    from executor.platform_compat.unix import UnixPtyManager as _PtyManager
    from executor.platform_compat.unix import UnixSignalHandler as _SignalHandler
    from executor.platform_compat.unix import UnixUserInfoProvider as _UserInfoProvider

# Singleton instances
_pty_manager_instance = None
_permissions_manager_instance = None
_signal_handler_instance = None
_user_info_provider_instance = None


def get_pty_manager():
    """Get the platform-specific PTY manager.

    Returns:
        PtyManager implementation for the current platform.
    """
    global _pty_manager_instance
    if _pty_manager_instance is None:
        _pty_manager_instance = _PtyManager()
    return _pty_manager_instance


def get_permissions_manager():
    """Get the platform-specific permissions manager.

    Returns:
        PermissionsManager implementation for the current platform.
    """
    global _permissions_manager_instance
    if _permissions_manager_instance is None:
        _permissions_manager_instance = _PermissionsManager()
    return _permissions_manager_instance


def get_signal_handler():
    """Get the platform-specific signal handler.

    Returns:
        SignalHandler implementation for the current platform.
    """
    global _signal_handler_instance
    if _signal_handler_instance is None:
        _signal_handler_instance = _SignalHandler()
    return _signal_handler_instance


def get_user_info_provider():
    """Get the platform-specific user info provider.

    Returns:
        UserInfoProvider implementation for the current platform.
    """
    global _user_info_provider_instance
    if _user_info_provider_instance is None:
        _user_info_provider_instance = _UserInfoProvider()
    return _user_info_provider_instance


__all__ = [
    "IS_WINDOWS",
    "IS_MACOS",
    "IS_LINUX",
    "get_pty_manager",
    "get_permissions_manager",
    "get_signal_handler",
    "get_user_info_provider",
    # Command line utilities
    "prepare_options_for_windows",
    "write_json_config",
    "get_safe_path_name",
]

# Import command line utilities
from executor.platform_compat.cmdline import (
    get_safe_path_name,
    prepare_options_for_windows,
    write_json_config,
)
