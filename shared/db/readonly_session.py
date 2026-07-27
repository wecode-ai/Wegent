# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Read-only database session factory for business database queries.

Collector queries run against a read replica to avoid impacting
the primary database's online traffic (especially subtask_contexts
which is latency-sensitive for chat).

Configuration via environment variables (priority order):
1. DATABASE_READONLY_URL - read replica
2. DATABASE_URL - primary database (fallback)

Only initialized in knowledge_runtime process; backend never imports this module.
"""

import os
from typing import Optional

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

# Module-level engine and session factory (lazily initialized)
_engine: Optional[Engine] = None
_SessionLocal: Optional[sessionmaker] = None


def resolve_readonly_database_url() -> str:
    """Resolve read-only database URL, falling back to primary."""
    return os.getenv("DATABASE_READONLY_URL") or os.getenv("DATABASE_URL") or ""


def init_readonly_db(database_url: Optional[str] = None) -> None:
    """Initialize the read-only database engine and session factory."""
    global _engine, _SessionLocal

    url = database_url or resolve_readonly_database_url()
    if not url:
        raise RuntimeError("No database URL resolved for readonly")

    _engine = create_engine(
        url,
        pool_pre_ping=True,
        pool_recycle=1800,
        connect_args={"charset": "utf8mb4"},
    )

    _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)


def get_readonly_engine() -> Engine:
    """Get the read-only database engine, initializing if needed."""
    global _engine
    if _engine is None:
        init_readonly_db()
    return _engine


def get_readonly_session_factory() -> sessionmaker:
    """Get the read-only session factory, initializing if needed."""
    global _SessionLocal
    if _SessionLocal is None:
        init_readonly_db()
    return _SessionLocal


def get_readonly_session() -> Session:
    """Create a new read-only database session."""
    return get_readonly_session_factory()()
