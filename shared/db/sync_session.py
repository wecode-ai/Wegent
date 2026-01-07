# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Synchronous database session factory.

Uses PyMySQL driver for MySQL connections.
Configuration via environment variables:
- DATABASE_URL: Full database URL (takes precedence)
- DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME: Individual settings
"""

import os
from typing import Generator, Optional

from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.orm import Session, sessionmaker

# Module-level engine and session factory (lazily initialized)
_engine: Optional[Engine] = None
_SessionLocal: Optional[sessionmaker] = None


def get_database_url() -> str:
    """
    Get database URL from environment variables.

    Priority:
    1. DATABASE_URL environment variable
    2. Construct from individual DB_* variables
    """
    # Check for full URL first
    database_url = os.getenv("DATABASE_URL")
    if database_url:
        return database_url

    # Construct from individual settings
    host = os.getenv("DB_HOST", "localhost")
    port = os.getenv("DB_PORT", "3306")
    user = os.getenv("DB_USER", "root")
    password = os.getenv("DB_PASSWORD", "")
    database = os.getenv("DB_NAME", "wegent")

    return f"mysql+pymysql://{user}:{password}@{host}:{port}/{database}"


def init_db(database_url: Optional[str] = None) -> None:
    """
    Initialize the database engine and session factory.

    Args:
        database_url: Optional database URL. If not provided, reads from environment.
    """
    global _engine, _SessionLocal

    url = database_url or get_database_url()

    _engine = create_engine(
        url,
        pool_pre_ping=True,
        connect_args={"charset": "utf8mb4", "init_command": "SET time_zone = '+08:00'"},
    )

    _SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=_engine)


def get_engine() -> Engine:
    """Get the database engine, initializing if needed."""
    global _engine
    if _engine is None:
        init_db()
    return _engine


def get_session_factory() -> sessionmaker:
    """Get the session factory, initializing if needed."""
    global _SessionLocal
    if _SessionLocal is None:
        init_db()
    return _SessionLocal


# Convenience properties for direct access
@property
def engine() -> Engine:
    """Database engine instance."""
    return get_engine()


@property
def SessionLocal() -> sessionmaker:
    """Session factory instance."""
    return get_session_factory()


# Make engine and SessionLocal accessible as module attributes
def __getattr__(name: str):
    """Lazy initialization of module-level attributes."""
    if name == "engine":
        return get_engine()
    elif name == "SessionLocal":
        return get_session_factory()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def get_db() -> Generator[Session, None, None]:
    """
    Database session dependency for FastAPI.

    Usage:
        @app.get("/items")
        def get_items(db: Session = Depends(get_db)):
            ...
    """
    session_factory = get_session_factory()
    db = session_factory()
    try:
        yield db
    finally:
        db.close()
