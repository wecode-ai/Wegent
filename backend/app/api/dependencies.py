# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

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
