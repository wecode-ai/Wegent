# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Windows file permissions management implementation using ACLs."""

import os
import sys
from typing import Optional

from executor.platform_compat.base import PermissionsManager

# Import win32 modules only on Windows
if sys.platform == "win32":
    try:
        import ntsecuritycon as con
        import win32api
        import win32security

        WIN32_AVAILABLE = True
    except ImportError:
        WIN32_AVAILABLE = False
else:
    WIN32_AVAILABLE = False


class WindowsPermissionsManager(PermissionsManager):
    """Windows permissions manager using ACLs via win32security."""

    def __init__(self):
        """Initialize Windows permissions manager."""
        self._available = WIN32_AVAILABLE
        self._current_user_sid: Optional[object] = None

    def _get_current_user_sid(self):
        """Get the SID of the current user (cached)."""
        if self._current_user_sid is None and self._available:
            try:
                token = win32security.OpenProcessToken(
                    win32api.GetCurrentProcess(), win32security.TOKEN_QUERY
                )
                self._current_user_sid = win32security.GetTokenInformation(
                    token, win32security.TokenUser
                )[0]
            except Exception:
                pass
        return self._current_user_sid

    def set_owner_only(self, path: str, is_directory: bool = False) -> None:
        """Set file/directory permissions to owner-only access using Windows ACLs.

        Creates a DACL that grants FULL_CONTROL only to the current user,
        removing all inherited permissions.

        Args:
            path: Path to the file or directory.
            is_directory: True if path is a directory.
        """
        if not self._available:
            # Fallback: just ensure file exists
            return

        try:
            user_sid = self._get_current_user_sid()
            if user_sid is None:
                return

            # Create a new DACL with only current user having full control
            dacl = win32security.ACL()
            dacl.AddAccessAllowedAce(
                win32security.ACL_REVISION, con.FILE_ALL_ACCESS, user_sid
            )

            # Get or create a security descriptor
            sd = win32security.GetFileSecurity(
                path, win32security.DACL_SECURITY_INFORMATION
            )

            # Set the new DACL (not inherited)
            sd.SetSecurityDescriptorDacl(True, dacl, False)

            # Apply the security descriptor
            win32security.SetFileSecurity(
                path, win32security.DACL_SECURITY_INFORMATION, sd
            )
        except Exception:
            # Silently fail - permissions may not be critical
            pass

    def set_mode(self, path: str, mode: int) -> None:
        """Set file permissions - best effort translation from Unix mode.

        Windows doesn't have the same permission model as Unix, so this
        does a rough translation:
        - If mode has no user read (0o400), remove read permission
        - If mode has no user write (0o200), set read-only attribute
        - If mode has no other access (mode & 0o077 == 0), set owner-only ACL

        Args:
            path: Path to the file.
            mode: Unix permission mode (e.g., 0o755).
        """
        if not self._available:
            return

        try:
            # Check if owner-only (no group/other permissions)
            if (mode & 0o077) == 0:
                self.set_owner_only(path, os.path.isdir(path))
            # Handle read-only
            elif not (mode & 0o200):
                # Set read-only attribute
                import stat

                current_mode = os.stat(path).st_mode
                os.chmod(path, current_mode & ~stat.S_IWRITE)
        except Exception:
            pass

    def get_mode(self, path: str) -> int:
        """Get file permissions as Unix-style mode approximation.

        This returns an approximation based on:
        - Read-only attribute maps to 0o444 vs 0o644
        - Owner-only ACL maps to 0o600/0o700

        Args:
            path: Path to the file.

        Returns:
            Approximate Unix permission mode.
        """
        import stat

        try:
            st = os.stat(path)
            mode = stat.S_IMODE(st.st_mode)

            # On Windows, this typically returns 0o666 for files, 0o777 for dirs
            # Adjust based on read-only attribute
            if not (st.st_mode & stat.S_IWRITE):
                if stat.S_ISDIR(st.st_mode):
                    mode = 0o555
                else:
                    mode = 0o444

            return mode
        except Exception:
            return 0o644
