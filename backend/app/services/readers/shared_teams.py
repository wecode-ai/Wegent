# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
SharedTeam reader - read-only queries with optional extension.

Usage:
    from app.services.readers.shared_teams import sharedTeamReader

    # Check if team is shared to user
    is_shared = sharedTeamReader.is_shared_to_user(db, team_id, user_id)

    # Get all team_ids shared to user
    team_ids = sharedTeamReader.get_shared_team_ids(db, user_id)
"""

import logging
from abc import ABC, abstractmethod
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.shared_team import SharedTeam

logger = logging.getLogger(__name__)


# =============================================================================
# Interface
# =============================================================================


class ISharedTeamReader(ABC):
    """Abstract interface for SharedTeam reader."""

    @abstractmethod
    def is_shared_to_user(self, db: Session, team_id: int, user_id: int) -> bool:
        """Check if team is shared to user."""
        pass

    @abstractmethod
    def get_shared_team_ids(self, db: Session, user_id: int) -> List[int]:
        """Get all team_ids shared to user."""
        pass

    @abstractmethod
    def get_by_team_and_user(
        self, db: Session, team_id: int, user_id: int
    ) -> Optional[SharedTeam]:
        """Get SharedTeam record by team_id and user_id."""
        pass

    @abstractmethod
    def on_change(self, team_id: int, user_id: int) -> None:
        """Handle change event."""
        pass


# =============================================================================
# Implementation
# =============================================================================


class SharedTeamReader(ISharedTeamReader):
    """SharedTeam reader with direct database queries."""

    def is_shared_to_user(self, db: Session, team_id: int, user_id: int) -> bool:
        return (
            db.query(SharedTeam)
            .filter(
                SharedTeam.team_id == team_id,
                SharedTeam.user_id == user_id,
                SharedTeam.is_active == True,
            )
            .first()
            is not None
        )

    def get_shared_team_ids(self, db: Session, user_id: int) -> List[int]:
        results = (
            db.query(SharedTeam.team_id)
            .filter(
                SharedTeam.user_id == user_id,
                SharedTeam.is_active == True,
            )
            .all()
        )
        return [r[0] for r in results]

    def get_by_team_and_user(
        self, db: Session, team_id: int, user_id: int
    ) -> Optional[SharedTeam]:
        return (
            db.query(SharedTeam)
            .filter(
                SharedTeam.team_id == team_id,
                SharedTeam.user_id == user_id,
                SharedTeam.is_active == True,
            )
            .first()
        )

    def on_change(self, team_id: int, user_id: int) -> None:
        pass


# =============================================================================
# Lazy Singleton
# =============================================================================


def _create_reader() -> ISharedTeamReader:
    """Create and initialize the reader."""
    from app.core.config import settings

    base = SharedTeamReader()

    if settings.SERVICE_EXTENSION:
        try:
            import importlib

            ext = importlib.import_module(f"{settings.SERVICE_EXTENSION}.shared_teams")
            result = ext.wrap(base)
            if result:
                logger.info("SharedTeam reader extension loaded")
                return result
        except Exception as e:
            logger.warning(f"Failed to load shared_team reader extension: {e}")

    return base


class _LazyReader:
    """Lazy-loaded reader proxy that delegates to the actual reader instance."""

    _instance: ISharedTeamReader | None = None

    def _get(self) -> ISharedTeamReader:
        if self._instance is None:
            self._instance = _create_reader()
        return self._instance

    def __getattr__(self, name):
        return getattr(self._get(), name)


# =============================================================================
# Export
# =============================================================================

sharedTeamReader: ISharedTeamReader = _LazyReader()  # type: ignore
