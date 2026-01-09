# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
User reader - read-only queries with optional caching.

Note: All queries include inactive users. Callers should check
user.is_active if they need to filter by active status.

Usage:
    from app.services.readers.users import userReader

    user = userReader.get_by_id(db, user_id)
    user = userReader.get_by_name(db, "admin")
    if user and user.is_active:
        # handle active user
"""

import logging
from abc import ABC, abstractmethod
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.user import User

logger = logging.getLogger(__name__)


# =============================================================================
# Interface
# =============================================================================


class IUserReader(ABC):
    """
    Abstract interface for User reader.

    Note: All queries include inactive users. Callers should check
    user.is_active if they need to filter by active status.
    """

    @abstractmethod
    def get_by_id(self, db: Session, user_id: int) -> Optional[User]:
        """Get user by ID (includes inactive users)."""
        pass

    @abstractmethod
    def get_by_name(self, db: Session, user_name: str) -> Optional[User]:
        """Get user by username (includes inactive users)."""
        pass

    @abstractmethod
    def get_all(self, db: Session) -> List[User]:
        """Get all users (includes inactive users)."""
        pass

    @abstractmethod
    def on_change(self, user_id: int, user_name: str) -> None:
        """Handle user change event."""
        pass


# =============================================================================
# Implementation
# =============================================================================


class UserReader(IUserReader):
    """User reader with direct database queries."""

    def get_by_id(self, db: Session, user_id: int) -> Optional[User]:
        return (
            db.query(User)
            .filter(
                User.id == user_id,
            )
            .first()
        )

    def get_by_name(self, db: Session, user_name: str) -> Optional[User]:
        return (
            db.query(User)
            .filter(
                User.user_name == user_name,
            )
            .first()
        )

    def get_all(self, db: Session) -> List[User]:
        return db.query(User).all()

    def on_change(self, user_id: int, user_name: str) -> None:
        pass


# =============================================================================
# Lazy Singleton
# =============================================================================


def _create_reader() -> IUserReader:
    """Create and initialize the reader."""
    from app.core.config import settings

    base = UserReader()

    if settings.SERVICE_EXTENSION:
        try:
            import importlib

            ext = importlib.import_module(f"{settings.SERVICE_EXTENSION}.users")
            result = ext.wrap(base)
            if result:
                logger.info("User reader extension loaded")
                return result
        except Exception as e:
            logger.warning(f"Failed to load user reader extension: {e}")

    return base


class _LazyReader:
    """Lazy-loaded reader proxy that delegates to the actual reader instance."""

    _instance: IUserReader | None = None

    def _get(self) -> IUserReader:
        if self._instance is None:
            self._instance = _create_reader()
        return self._instance

    def __getattr__(self, name):
        return getattr(self._get(), name)


# =============================================================================
# Export
# =============================================================================

userReader: IUserReader = _LazyReader()  # type: ignore
