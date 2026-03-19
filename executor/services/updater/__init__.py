# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Updater service for executor self-update functionality.

Provides automated self-update capabilities for the wegent-executor binary,
including version checking, downloading, and atomic binary replacement.
"""

from .updater_service import UpdateResult, UpdaterService, setup_upgrade_logging
from .version_checker import UpdateInfo, VersionChecker

__all__ = [
    "UpdaterService",
    "UpdateResult",
    "VersionChecker",
    "UpdateInfo",
    "setup_upgrade_logging",
]
