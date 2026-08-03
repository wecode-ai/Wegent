# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Statistics database session factory.

Provides a separate database connection for KB statistics tables.
Configuration via environment variables (priority order):
1. KNOWLEDGE_STAT_DATABASE_URL - dedicated stat database
2. KNOWLEDGE_RUNTIME_DATABASE_URL - runtime database (fallback)
3. DATABASE_URL - main database (fallback)

Only initialized in knowledge_runtime process; backend never imports this module.
"""

import os
from typing import Optional

from sqlalchemy import create_engine, event
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker


class StatDbNotConfiguredError(RuntimeError):
    """Raised when no stat database URL is configured for kb_stat.

    Mapped to HTTP 503 by the knowledge_runtime app so that a missing stat
    database degrades gracefully instead of surfacing as a 500.
    """


# Module-level engine and session factory (lazily initialized)
_engine: Optional[Engine] = None
_SessionLocal: Optional[sessionmaker] = None


def resolve_stat_database_url() -> str:
    """Resolve stat database URL with priority fallback chain."""
    return (
        os.getenv("KNOWLEDGE_STAT_DATABASE_URL")
        or os.getenv("KNOWLEDGE_RUNTIME_DATABASE_URL")
        or os.getenv("DATABASE_URL")
        or ""
    )


def init_stat_db(database_url: Optional[str] = None) -> None:
    """Initialize the stat database engine and session factory."""
    global _engine, _SessionLocal

    url = database_url or resolve_stat_database_url()
    if not url:
        raise StatDbNotConfiguredError("No database URL resolved for kb_stat")

    _engine = create_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args={"charset": "utf8mb4"},
    )

    # Force UTC on every connection so that naive datetimes returned by
    # MySQL are always UTC regardless of the server OS timezone. Without
    # this, changing the server timezone (e.g. to Asia/Shanghai) would
    # silently shift all stored datetimes, breaking _iso() which assumes
    # "MySQL stores UTC".
    @event.listens_for(_engine, "connect")
    def _force_utc(dbapi_conn, _conn_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("SET time_zone = '+00:00'")
        cursor.close()

    _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)


def get_stat_engine() -> Engine:
    """Get the stat database engine, initializing if needed."""
    global _engine
    if _engine is None:
        init_stat_db()
    return _engine


def get_stat_session_factory() -> sessionmaker:
    """Get the stat session factory, initializing if needed."""
    global _SessionLocal
    if _SessionLocal is None:
        init_stat_db()
    return _SessionLocal


def get_stat_session() -> Session:
    """Create a new stat database session."""
    return get_stat_session_factory()()
