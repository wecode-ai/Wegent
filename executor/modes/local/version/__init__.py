# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Version management for local executor mode.

This package provides version reporting and upgrade checking.
"""

from executor.modes.local.version.version_reporter import (
    VersionReporter,
    get_executor_version,
)

__all__ = ["VersionReporter", "get_executor_version"]
