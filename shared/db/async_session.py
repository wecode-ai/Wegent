# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Asynchronous database session factory.

Uses asyncmy driver for async MySQL connections.
Configuration via environment variables:
- DATABASE_URL: Full database URL (takes precedence, will convert to async)
- DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME: Individual settings
"""

import os
from typing import AsyncGenerator, Optional

from sqlalchemy.ext.asyncio import (AsyncEngine, AsyncSession,
                                    create_async_engine)
from sqlalchemy.orm import sessionmaker

# Module-level async engine and session factory (lazily initialized)
_async_engine: Optional[AsyncEngine] = None
_AsyncSessionLocal: Optional[sessionmaker] = None


def get_async_database_url() -> str:
    """
    Get async database URL from environment variables.

    Priority:
    1. DATABASE_URL environment variable (converted to async driver)
    2. Construct from individual DB_* variables
    """
    # Check for full URL first
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        # Convert sync URL to async URL
        # mysql+pymysql:// -> mysql+asyncmy://
        # mysql:// -> mysql+asyncmy://
        if "pymysql" in database_url:
            return database_url.replace("pymysql", "asyncmy")
        elif database_url.startswith("mysql://"):
            return database_url.replace("mysql://", "mysql+asyncmy://")
        elif "asyncmy" in database_url:
            return database_url
        else:
            # Default: assume it's a mysql URL and add asyncmy
            return database_url.replace("mysql+", "mysql+asyncmy+", 1)

    # Construct from individual settings
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "3306")
    user = os.getenv("DB_USER", "root")
    password = os.getenv("DB_PASSWORD", "")
    database = os.getenv("DB_NAME", "wegent")

    return f"mysql+asyncmy://{user}:{password}@{host}:{port}/{database}"


def init_async_db(database_url: Optional[str] = None) -> None:
    """
    Initialize the async database engine and session factory.

    Args:
        database_url: Optional database URL. If not provided, reads from environment.
    """
    global _async_engine, _AsyncSessionLocal

    url = database_url or get_async_database_url()

    _async_engine = create_async_engine(
        url,
        pool_pre_ping=True,
        echo=False,
    )

    _AsyncSessionLocal = sessionmaker(
        bind=_async_engine,
        class_=AsyncSession,
        autocommit=False,
        autoflush=False,
        expire_on_commit=False,
    )


def get_async_engine() -> AsyncEngine:
    """Get the async database engine, initializing if needed."""
    global _async_engine
    if _async_engine is None:
        init_async_db()
    return _async_engine


def get_async_session_factory() -> sessionmaker:
    """Get the async session factory, initializing if needed."""
    global _AsyncSessionLocal
    if _AsyncSessionLocal is None:
        init_async_db()
    return _AsyncSessionLocal


# Make async_engine and AsyncSessionLocal accessible as module attributes
def __getattr__(name: str):
    """Lazy initialization of module-level attributes."""
    if name == "async_engine":
        return get_async_engine()
    elif name == "AsyncSessionLocal":
        return get_async_session_factory()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


async def get_async_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Async database session dependency for FastAPI.

    Usage:
        @app.get("/items")
        async def get_items(db: AsyncSession = Depends(get_async_db)):
            ...
    """
    session_factory = get_async_session_factory()
    async with session_factory() as session:
        try:
            yield session
        finally:
            await session.close()
