# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from contextlib import contextmanager
from typing import Generator

from sqlalchemy.orm import Session

from app.db.session import SessionLocal


def get_db() -> Generator[Session, None, None]:
    """
    Database session dependency
    Creates a new session for each request and automatically closes it after the request ends
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


@contextmanager
def get_db_context() -> Generator[Session, None, None]:
    """
    Database session context manager for use outside of FastAPI dependency injection.
    Use this when you need a database session in async functions or background tasks.
    """
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
