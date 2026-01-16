# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Kind reader - read-only queries with optional caching.

Usage:
    from app.services.readers.kinds import kindReader, KindType

    kind = kindReader.get_by_id(db, KindType.BOT, resource_id)
    kind = kindReader.get_by_name_and_namespace(db, user_id, KindType.BOT, "default", "mybot")
"""

import logging
from abc import ABC, abstractmethod
from enum import Enum
from typing import List, Optional, Set

from sqlalchemy.orm import Session

from app.models.kind import Kind

logger = logging.getLogger(__name__)


# =============================================================================
# Type Definitions
# =============================================================================


class KindType(str, Enum):
    """Enumeration of Kind resource types."""

    BOT = "Bot"
    GHOST = "Ghost"
    KNOWLEDGE_BASE = "KnowledgeBase"
    MODEL = "Model"
    RETRIEVER = "Retriever"
    SHELL = "Shell"
    SKILL = "Skill"
    TEAM = "Team"


# Resource kinds that support fallback to public resources (user_id=0)
PUBLIC_FALLBACK_KINDS: Set[KindType] = {
    KindType.MODEL,
    KindType.SHELL,
    KindType.SKILL,
    KindType.GHOST,
    KindType.RETRIEVER,
}


# =============================================================================
# Interface
# =============================================================================


class IKindReader(ABC):
    """Abstract interface for Kind reader."""

    @abstractmethod
    def get_by_id(
        self, db: Session, kind: KindType, resource_id: int
    ) -> Optional[Kind]:
        """Get resource by ID."""
        pass

    @abstractmethod
    def get_by_ids(
        self, db: Session, kind: KindType, resource_ids: List[int]
    ) -> List[Kind]:
        """Get resources by IDs."""
        pass

    @abstractmethod
    def get_personal(
        self, db: Session, user_id: int, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        """Get personal resource (owned by user)."""
        pass

    @abstractmethod
    def get_public(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        """Get public resource (user_id=0)."""
        pass

    @abstractmethod
    def get_group(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        """Get group resource."""
        pass

    def get_by_name_and_namespace(
        self,
        db: Session,
        user_id: int,
        kind: KindType,
        namespace: str,
        name: str,
    ) -> Optional[Kind]:
        """
        Unified query for resource by name and namespace.

        Args:
            db: Database session
            user_id: The user making the request
            kind: Resource kind type
            namespace: Resource namespace
            name: Resource name

        Fallback strategy:
        - namespace == "default" and kind supports public fallback: personal -> public
        - namespace == "default" and kind doesn't support public fallback: personal only
        - namespace != "default": group resource

        Team special logic:
        - namespace == "default": personal -> shared teams (check if shared to user)
        - namespace != "default": group team (check namespace visibility and membership)
        """
        # Team has special logic
        if kind == KindType.TEAM:
            return self._get_team(db, user_id, namespace, name)

        if namespace == "default":
            if user_id != 0:
                result = self.get_personal(db, user_id, kind, namespace, name)
                if result:
                    return result

            if kind in PUBLIC_FALLBACK_KINDS:
                return self.get_public(db, kind, namespace, name)

            return None
        else:
            return self.get_group(db, kind, namespace, name)

    def _get_team(
        self,
        db: Session,
        user_id: int,
        namespace: str,
        name: str,
    ) -> Optional[Kind]:
        """
        Get Team with special permission logic.

        For namespace == "default":
            1. Query user's own Team
            2. If not found, query shared Teams

        For namespace != "default":
            1. Query group Team
            2. Check namespace permission (public or user is member)
        """
        from app.services.readers.group_members import groupMemberReader
        from app.services.readers.groups import groupReader
        from app.services.readers.shared_teams import sharedTeamReader

        if namespace == "default":
            # First, query user's own Team
            if user_id != 0:
                result = self.get_personal(db, user_id, KindType.TEAM, namespace, name)
                if result:
                    return result

                # If not found, check shared Teams
                # Get all team_ids shared to this user, then find the one with matching name
                shared_team_ids = sharedTeamReader.get_shared_team_ids(db, user_id)
                if shared_team_ids:
                    team = (
                        db.query(Kind)
                        .filter(
                            Kind.id.in_(shared_team_ids),
                            Kind.kind == KindType.TEAM.value,
                            Kind.namespace == namespace,
                            Kind.name == name,
                            Kind.is_active == True,
                        )
                        .first()
                    )
                    if team:
                        return team

            return None
        else:
            # Group Team
            team = self.get_group(db, KindType.TEAM, namespace, name)
            if not team:
                return None

            # Check namespace permission
            # If namespace is public, allow access
            if groupReader.is_public(db, namespace):
                return team

            # If namespace is internal/private, check if user is member
            if user_id != 0 and groupMemberReader.is_member(db, namespace, user_id):
                return team

            logger.debug(f"User {user_id} has no access to team {namespace}/{name}")
            return None

    @abstractmethod
    def on_change(
        self,
        kind: KindType,
        resource_id: int,
        user_id: int,
        namespace: str,
        name: str,
    ) -> None:
        """Handle resource change event."""
        pass


# =============================================================================
# Implementation
# =============================================================================


class KindReader(IKindReader):
    """Kind reader with direct database queries."""

    def get_by_id(
        self, db: Session, kind: KindType, resource_id: int
    ) -> Optional[Kind]:
        return (
            db.query(Kind)
            .filter(
                Kind.id == resource_id,
                Kind.kind == kind.value,
                Kind.is_active == True,
            )
            .first()
        )

    def get_by_ids(
        self, db: Session, kind: KindType, resource_ids: List[int]
    ) -> List[Kind]:
        if not resource_ids:
            return []
        return (
            db.query(Kind)
            .filter(
                Kind.id.in_(resource_ids),
                Kind.kind == kind.value,
                Kind.is_active == True,
            )
            .all()
        )

    def get_personal(
        self, db: Session, user_id: int, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        if namespace != "default":
            logger.warning(
                f"get_personal: namespace must be 'default', got '{namespace}'"
            )
            return None
        if user_id == 0:
            logger.warning("get_personal: user_id must not be 0")
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == user_id,
                Kind.kind == kind.value,
                Kind.namespace == namespace,
                Kind.name == name,
                Kind.is_active == True,
            )
            .first()
        )

    def get_public(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        if namespace != "default":
            logger.warning(
                f"get_public: namespace must be 'default', got '{namespace}'"
            )
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.user_id == 0,
                Kind.kind == kind.value,
                Kind.namespace == namespace,
                Kind.name == name,
                Kind.is_active == True,
            )
            .first()
        )

    def get_group(
        self, db: Session, kind: KindType, namespace: str, name: str
    ) -> Optional[Kind]:
        if namespace == "default":
            logger.warning("get_group: namespace must not be 'default'")
            return None
        return (
            db.query(Kind)
            .filter(
                Kind.kind == kind.value,
                Kind.namespace == namespace,
                Kind.name == name,
                Kind.is_active == True,
            )
            .first()
        )

    def on_change(
        self,
        kind: KindType,
        resource_id: int,
        user_id: int,
        namespace: str,
        name: str,
    ) -> None:
        pass


# =============================================================================
# Lazy Singleton
# =============================================================================


def _create_reader() -> IKindReader:
    """Create and initialize the reader."""
    from app.core.config import settings

    base = KindReader()

    if settings.SERVICE_EXTENSION:
        try:
            import importlib

            ext = importlib.import_module(f"{settings.SERVICE_EXTENSION}.kinds")
            result = ext.wrap(base)
            if result:
                logger.info("Kind reader extension loaded")
                return result
        except Exception as e:
            logger.warning(f"Failed to load kind reader extension: {e}")

    return base


class _LazyReader:
    """Lazy-loaded reader proxy that delegates to the actual reader instance."""

    _instance: IKindReader | None = None

    def _get(self) -> IKindReader:
        if self._instance is None:
            self._instance = _create_reader()
        return self._instance

    def __getattr__(self, name):
        return getattr(self._get(), name)


# =============================================================================
# Export
# =============================================================================

kindReader: IKindReader = _LazyReader()  # type: ignore
