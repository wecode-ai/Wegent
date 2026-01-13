# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Group reader - read-only queries with optional extension.

Note: The underlying table is 'namespace', but we use 'group' in code for clarity.

Usage:
    from app.services.readers.groups import groupReader

    # Get group by name
    group = groupReader.get_by_name(db, "group-name")

    # Check if group is public
    is_public = groupReader.is_public(db, "group-name")
"""

import logging
from abc import ABC, abstractmethod
from typing import Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace

logger = logging.getLogger(__name__)


# Visibility constants
VISIBILITY_PUBLIC = "public"
VISIBILITY_INTERNAL = "internal"
VISIBILITY_PRIVATE = "private"


# =============================================================================
# Interface
# =============================================================================


class IGroupReader(ABC):
    """Abstract interface for Group reader."""

    @abstractmethod
    def get_by_name(self, db: Session, name: str) -> Optional[Namespace]:
        """Get group by name."""
        pass

    @abstractmethod
    def get_visibility(self, db: Session, name: str) -> Optional[str]:
        """Get group visibility (public/internal/private)."""
        pass

    @abstractmethod
    def is_public(self, db: Session, name: str) -> bool:
        """Check if group is public."""
        pass

    @abstractmethod
    def on_change(self, name: str) -> None:
        """Handle change event."""
        pass


# =============================================================================
# Implementation
# =============================================================================


class GroupReader(IGroupReader):
    """Group reader with direct database queries."""

    def get_by_name(self, db: Session, name: str) -> Optional[Namespace]:
        return (
            db.query(Namespace)
            .filter(
                Namespace.name == name,
                Namespace.is_active == True,
            )
            .first()
        )

    def get_visibility(self, db: Session, name: str) -> Optional[str]:
        group = self.get_by_name(db, name)
        return group.visibility if group else None

    def is_public(self, db: Session, name: str) -> bool:
        visibility = self.get_visibility(db, name)
        return visibility == VISIBILITY_PUBLIC

    def on_change(self, name: str) -> None:
        pass


# =============================================================================
# Lazy Singleton
# =============================================================================


def _create_reader() -> IGroupReader:
    """Create and initialize the reader."""
    from app.core.config import settings

    base = GroupReader()

    if settings.SERVICE_EXTENSION:
        try:
            import importlib

            ext = importlib.import_module(f"{settings.SERVICE_EXTENSION}.groups")
            result = ext.wrap(base)
            if result:
                logger.info("Group reader extension loaded")
                return result
        except Exception as e:
            logger.warning(f"Failed to load group reader extension: {e}")

    return base


class _LazyReader:
    """Lazy-loaded reader proxy that delegates to the actual reader instance."""

    _instance: IGroupReader | None = None

    def _get(self) -> IGroupReader:
        if self._instance is None:
            self._instance = _create_reader()
        return self._instance

    def __getattr__(self, name):
        return getattr(self._get(), name)


# =============================================================================
# Export
# =============================================================================

groupReader: IGroupReader = _LazyReader()  # type: ignore
