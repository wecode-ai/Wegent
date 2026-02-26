# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from typing import Generator

from sqlalchemy import create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import settings

# Database connection URL (using sync driver)
SQLALCHEMY_DATABASE_URL = settings.DATABASE_URL


def _create_engine():
    """
    Create database engine based on DATABASE_URL prefix.

    Automatically selects appropriate configuration for SQLite or MySQL.
    """
    if SQLALCHEMY_DATABASE_URL.startswith("sqlite"):
        # SQLite configuration
        # - check_same_thread=False: Required for SQLite to work with multiple threads
        # - SQLite doesn't support connection pooling parameters like pool_size
        return create_engine(
            SQLALCHEMY_DATABASE_URL,
            connect_args={"check_same_thread": False},
            pool_pre_ping=True,
        )
    else:
        # MySQL configuration
        # Increase pool size to handle concurrent requests in E2E tests and production
        # Default SQLAlchemy: pool_size=5, max_overflow=10 (total 15 connections)
        # New settings: pool_size=10, max_overflow=20 (total 30 connections)
        return create_engine(
            SQLALCHEMY_DATABASE_URL,
            pool_pre_ping=True,
            pool_size=10,
            max_overflow=20,
            pool_timeout=30,
            pool_recycle=3600,  # Recycle connections after 1 hour to avoid stale connections
            connect_args={
                "charset": "utf8mb4",
                "init_command": "SET time_zone = '+08:00'",
            },
        )


engine = _create_engine()

# Sync session factory
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

# Import Base from shared package for consistency
# All models should use the same Base for proper relationship resolution
from app.db.base import Base

# Wiki tables now use the main database (Base)
# Alias for backward compatibility
WikiBase = Base


@contextmanager
def get_db_session() -> Generator[Session, None, None]:
    """
    Context manager for database sessions.

    Provides a clean way to manage database sessions with proper cleanup.
    Use this instead of manually creating SessionLocal() and closing.

    Usage:
        with get_db_session() as db:
            # use db...
            pass
        # session is automatically closed

    Yields:
        Database session
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def get_wiki_db():
    """
    Wiki database session dependency
    Now uses main database session for wiki tables
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
