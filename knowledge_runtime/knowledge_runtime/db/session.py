# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SQLAlchemy session management for knowledge_runtime."""

from __future__ import annotations

import logging
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

logger = logging.getLogger(__name__)

_engine = None
_session_factory: sessionmaker | None = None


def init_db(database_url: str) -> None:
    """Initialize the database engine and session factory."""
    global _engine, _session_factory

    # SQLite does not support pool_size / max_overflow; omit them
    is_sqlite = database_url.startswith("sqlite")

    engine_kwargs: dict = {}
    if not is_sqlite:
        engine_kwargs.update(
            pool_size=5,
            max_overflow=10,
            pool_pre_ping=True,
        )

    _engine = create_engine(database_url, **engine_kwargs)
    _session_factory = sessionmaker(bind=_engine)
    logger.info("Database engine initialized")


def get_db() -> Generator[Session, None, None]:
    """FastAPI dependency that yields a DB session and ensures cleanup.

    Usage in endpoints::

        @router.post("/index")
        async def index_document(request, db: Session = Depends(get_db)):
            ...
    """
    if _session_factory is None:
        raise RuntimeError("Database not initialized. Call init_db() first.")
    session = _session_factory()
    try:
        yield session
    finally:
        session.close()


def is_db_initialized() -> bool:
    """Check if the database has been initialized."""
    return _session_factory is not None
