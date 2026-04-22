# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import asynccontextmanager, contextmanager
from typing import AsyncGenerator, Generator, Optional

from sqlalchemy import create_engine
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, create_async_engine
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

# Async database support (lazily initialized)
_async_engine: Optional[AsyncEngine] = None
_AsyncSessionLocal: Optional[sessionmaker] = None


def _get_async_database_url() -> str:
    """Convert sync DATABASE_URL to async driver URL."""
    url = SQLALCHEMY_DATABASE_URL
    if "pymysql" in url:
        return url.replace("pymysql", "asyncmy")
    elif url.startswith("mysql://"):
        return url.replace("mysql://", "mysql+asyncmy://")
    elif "asyncmy" in url:
        return url
    elif url.startswith("sqlite"):
        return url.replace("sqlite://", "sqlite+aiosqlite://")
    return url.replace("mysql+", "mysql+asyncmy+", 1)


def _create_async_engine() -> AsyncEngine:
    """Create async database engine."""
    async_url = _get_async_database_url()
    if async_url.startswith("sqlite"):
        return create_async_engine(async_url, pool_pre_ping=True)
    return create_async_engine(
        async_url,
        pool_pre_ping=True,
        pool_size=10,
        max_overflow=20,
        pool_timeout=30,
        pool_recycle=3600,
    )


def get_async_engine() -> AsyncEngine:
    """Get the async database engine, initializing if needed."""
    global _async_engine
    if _async_engine is None:
        _async_engine = _create_async_engine()
    return _async_engine


def get_async_session_factory() -> sessionmaker:
    """Get the async session factory, initializing if needed."""
    global _AsyncSessionLocal
    if _AsyncSessionLocal is None:
        _AsyncSessionLocal = sessionmaker(
            bind=get_async_engine(),
            class_=AsyncSession,
            autocommit=False,
            autoflush=False,
            expire_on_commit=False,
        )
    return _AsyncSessionLocal


# Convenience alias for direct use
def AsyncSessionLocal() -> AsyncSession:
    """Create a new async session."""
    factory = get_async_session_factory()
    return factory()


async def get_async_db() -> AsyncGenerator[AsyncSession, None]:
    """Async database session dependency for FastAPI."""
    session = AsyncSessionLocal()
    try:
        yield session
    finally:
        await session.close()


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
