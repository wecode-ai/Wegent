# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Unix user/group information implementation."""

import grp
import os
import pwd

from executor.platform.base import UserInfoProvider


class UnixUserInfoProvider(UserInfoProvider):
    """Unix user info provider using pwd and grp modules."""

    def get_owner_name(self, uid: int) -> str:
        """Get the username for a user ID."""
        try:
            return pwd.getpwuid(uid).pw_name
        except KeyError:
            return str(uid)

    def get_group_name(self, gid: int) -> str:
        """Get the group name for a group ID."""
        try:
            return grp.getgrgid(gid).gr_name
        except KeyError:
            return str(gid)

    def get_owner_name_from_path(self, path: str) -> str:
        """Get the owner name for a file path."""
        stat_info = os.stat(path)
        return self.get_owner_name(stat_info.st_uid)

    def get_group_name_from_path(self, path: str) -> str:
        """Get the group name for a file path."""
        stat_info = os.stat(path)
        return self.get_group_name(stat_info.st_gid)
