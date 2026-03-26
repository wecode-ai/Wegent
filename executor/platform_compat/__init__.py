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

import os
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


def sanitize_ld_library_path(env: dict) -> dict:
    """Sanitize LD_LIBRARY_PATH for subprocess environments in PyInstaller builds.

    PyInstaller's bootloader prepends its extraction directory (/tmp/_MEIxxxxxx) to
    LD_LIBRARY_PATH, which causes child processes to load wrong shared libraries.
    This function restores the original value or clears it.

    Only affects Linux. macOS is unaffected because PyInstaller rewrites library paths
    in binaries directly and does not modify DYLD_LIBRARY_PATH.

    See: https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html

    Args:
        env: Environment variables dict (will be modified in-place).

    Returns:
        The same env dict, for convenience.
    """
    if not getattr(sys, "frozen", False):
        return env

    # Read original value from os.environ (set by PyInstaller's bootloader),
    # not from the passed-in env dict which may be a partial options dict.
    ld_orig = os.environ.get("LD_LIBRARY_PATH_ORIG")
    if ld_orig is not None:
        env["LD_LIBRARY_PATH"] = ld_orig
    else:
        # No ORIG saved — clear LD_LIBRARY_PATH by setting it to empty string.
        # Using pop() would be insufficient when env is a partial options dict
        # that gets merged with os.environ (the polluted value would survive).
        env["LD_LIBRARY_PATH"] = ""

    return env


__all__ = [
    "IS_WINDOWS",
    "IS_MACOS",
    "IS_LINUX",
    "get_pty_manager",
    "get_permissions_manager",
    "get_signal_handler",
    "get_user_info_provider",
    "sanitize_ld_library_path",
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
