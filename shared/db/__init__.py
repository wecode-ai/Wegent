# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared database session factories for Wegent project.

Provides both synchronous and asynchronous session factories
that can be configured via environment variables.
"""

from typing import Any

from .async_session import get_async_db, init_async_db
from .sync_session import get_db, init_db


def __getattr__(name: str) -> Any:
    """Initialize database resources only when callers explicitly request them."""
    if name == "engine":
        from .sync_session import get_engine

        return get_engine()
    if name == "SessionLocal":
        from .sync_session import get_session_factory

        return get_session_factory()
    if name == "async_engine":
        from .async_session import get_async_engine

        return get_async_engine()
    if name == "AsyncSessionLocal":
        from .async_session import get_async_session_factory

        return get_async_session_factory()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


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
