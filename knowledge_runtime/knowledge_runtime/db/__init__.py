# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database connection module for Knowledge Runtime.

Provides database session management for resolving CRD configurations
from the database when using reference mode.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from knowledge_runtime.config import get_settings

logger = logging.getLogger(__name__)

_engine = None
_SessionLocal = None


def init_db() -> None:
    """Initialize database connection.

    Must be called at application startup before using reference mode.
    Raises ValueError if DATABASE_URL is not configured.
    """
    global _engine, _SessionLocal

    settings = get_settings()
    if not settings.DATABASE_URL:
        raise ValueError(
            "DATABASE_URL is required for reference mode. "
            "Set KNOWLEDGE_RUNTIME_DATABASE_URL or DATABASE_URL environment variable."
        )

    logger.info("Initializing database connection for Knowledge Runtime")
    _engine = create_engine(
        settings.DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=3600,
        echo=False,
    )
    _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)
    logger.info("Database connection initialized successfully")


def get_db() -> Generator[Session, None, None]:
    """Get database session.

    Yields:
        Session: SQLAlchemy database session.

    Raises:
        RuntimeError: If database is not initialized.
    """
    if _SessionLocal is None:
        init_db()

    db = _SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_session() -> Generator[Session, None, None]:
    """Context manager for database session.

    Usage:
        with get_db_session() as db:
            result = db.query(Kind).first()

    Yields:
        Session: SQLAlchemy database session.
    """
    yield from get_db()


def is_db_initialized() -> bool:
    """Check if database connection is initialized.

    Returns:
        bool: True if database is initialized, False otherwise.
    """
    return _SessionLocal is not None


def reset_db() -> None:
    """Reset database connection (useful for testing)."""
    global _engine, _SessionLocal
    _engine = None
    _SessionLocal = None
