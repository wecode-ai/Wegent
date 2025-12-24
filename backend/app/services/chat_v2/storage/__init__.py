# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Storage module for Chat Service.

Provides unified access to database and session storage.
"""

from .db import db_handler
from .proxy import StorageProxy
from .session import session_manager

# Global storage handler instance
storage_handler = StorageProxy()

__all__ = [
    "storage_handler",
    "StorageProxy",
    "db_handler",
    "session_manager",
]
