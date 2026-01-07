# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared database session factories for Wegent project.

Provides both synchronous and asynchronous session factories
that can be configured via environment variables.
"""

from .async_session import (AsyncSessionLocal, async_engine, get_async_db,
                            init_async_db)
from .sync_session import SessionLocal, engine, get_db, init_db

__all__ = [
    # Sync
    "engine",
    "SessionLocal",
    "get_db",
    "init_db",
    # Async
    "async_engine",
    "AsyncSessionLocal",
    "get_async_db",
    "init_async_db",
]
