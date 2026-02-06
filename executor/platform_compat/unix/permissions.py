# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unix file permissions management implementation."""

import os
import stat

from executor.platform_compat.base import PermissionsManager


class UnixPermissionsManager(PermissionsManager):
    """Unix permissions manager using chmod."""

    def set_owner_only(self, path: str, is_directory: bool = False) -> None:
        """Set file/directory permissions to owner-only access.

        Args:
            path: Path to the file or directory.
            is_directory: True if path is a directory.
        """
        if is_directory:
            # rwx------ for directories
            os.chmod(path, 0o700)
        else:
            # rw------- for files
            os.chmod(path, 0o600)

    def set_mode(self, path: str, mode: int) -> None:
        """Set file permissions using Unix-style mode.

        Args:
            path: Path to the file.
            mode: Unix permission mode (e.g., 0o755).
        """
        os.chmod(path, mode)

    def get_mode(self, path: str) -> int:
        """Get file permissions as Unix-style mode.

        Args:
            path: Path to the file.

        Returns:
            Unix permission mode.
        """
        return stat.S_IMODE(os.stat(path).st_mode)
