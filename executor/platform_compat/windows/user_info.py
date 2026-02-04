# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Windows user/group information implementation."""

import os
import sys
from typing import Optional

from executor.platform_compat.base import UserInfoProvider

# Import win32 modules only on Windows
if sys.platform == "win32":
    try:
        import win32security

        WIN32_AVAILABLE = True
    except ImportError:
        WIN32_AVAILABLE = False
else:
    WIN32_AVAILABLE = False


class WindowsUserInfoProvider(UserInfoProvider):
    """Windows user info provider using win32security."""

    def __init__(self):
        """Initialize Windows user info provider."""
        self._available = WIN32_AVAILABLE

    def get_owner_name(self, uid: int) -> str:
        """Get the username for a user ID.

        On Windows, UIDs are not used the same way as Unix.
        This method is provided for API compatibility but returns
        the current username or the UID as string.

        Args:
            uid: User ID (not used on Windows).

        Returns:
            Current username or UID as string.
        """
        try:
            return os.getlogin()
        except Exception:
            try:
                return os.environ.get("USERNAME", str(uid))
            except Exception:
                return str(uid)

    def get_group_name(self, gid: int) -> str:
        """Get the group name for a group ID.

        Windows doesn't have the same group concept as Unix.
        Returns the GID as string for API compatibility.

        Args:
            gid: Group ID (not used on Windows).

        Returns:
            Empty string or GID as string.
        """
        # Windows doesn't have Unix-style groups
        return ""

    def get_owner_name_from_path(self, path: str) -> str:
        """Get the owner name for a file path.

        Args:
            path: File path.

        Returns:
            Owner name string (DOMAIN\\username format on Windows).
        """
        if not self._available:
            return self.get_owner_name(0)

        try:
            sd = win32security.GetFileSecurity(
                path, win32security.OWNER_SECURITY_INFORMATION
            )
            owner_sid = sd.GetSecurityDescriptorOwner()
            name, domain, _ = win32security.LookupAccountSid(None, owner_sid)
            if domain:
                return f"{domain}\\{name}"
            return name
        except Exception:
            return self.get_owner_name(0)

    def get_group_name_from_path(self, path: str) -> str:
        """Get the group name for a file path.

        On Windows, files don't have the same group concept as Unix.
        This returns the primary group of the file owner if available.

        Args:
            path: File path.

        Returns:
            Group name string (often empty on Windows).
        """
        if not self._available:
            return ""

        try:
            sd = win32security.GetFileSecurity(
                path, win32security.GROUP_SECURITY_INFORMATION
            )
            group_sid = sd.GetSecurityDescriptorGroup()
            if group_sid:
                name, domain, _ = win32security.LookupAccountSid(None, group_sid)
                if domain:
                    return f"{domain}\\{name}"
                return name
        except Exception:
            pass

        return ""
