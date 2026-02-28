# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
GroupMember reader - read-only queries with optional extension.

Note: The underlying table is now 'resource_members' with resource_type='Namespace'.
This reader provides backward compatibility for code using group membership queries.

Usage:
    from app.services.readers.group_members import groupMemberReader

    # Check if user is member of group
    is_member = groupMemberReader.is_member(db, "group-name", user_id)

    # Get user's role in group
    role = groupMemberReader.get_role(db, "group-name", user_id)
"""

import logging
from abc import ABC, abstractmethod
from typing import List, Optional

from sqlalchemy.orm import Session

from app.models.namespace import Namespace
from app.models.resource_member import MemberStatus, ResourceMember
from app.services.group_member_helper import (
    NAMESPACE_RESOURCE_TYPE,
    get_group_member,
    get_namespace_id_by_name,
)

logger = logging.getLogger(__name__)


# =============================================================================
# Interface
# =============================================================================


class IGroupMemberReader(ABC):
    """Abstract interface for GroupMember reader."""

    @abstractmethod
    def is_member(self, db: Session, group_name: str, user_id: int) -> bool:
        """Check if user is member of group."""
        pass

    @abstractmethod
    def get_role(self, db: Session, group_name: str, user_id: int) -> Optional[str]:
        """Get user's role in group (Owner/Maintainer/Developer/Reporter)."""
        pass

    @abstractmethod
    def get_by_group_and_user(
        self, db: Session, group_name: str, user_id: int
    ) -> Optional[ResourceMember]:
        """Get GroupMember record by group_name and user_id."""
        pass

    @abstractmethod
    def get_user_groups(self, db: Session, user_id: int) -> List[str]:
        """Get all group names that user is member of."""
        pass

    @abstractmethod
    def on_change(self, group_name: str, user_id: int) -> None:
        """Handle change event."""
        pass


# =============================================================================
# Implementation
# =============================================================================


class GroupMemberReader(IGroupMemberReader):
    """GroupMember reader with direct database queries using ResourceMember."""

    def is_member(self, db: Session, group_name: str, user_id: int) -> bool:
        return get_group_member(db, group_name, user_id) is not None

    def get_role(self, db: Session, group_name: str, user_id: int) -> Optional[str]:
        member = self.get_by_group_and_user(db, group_name, user_id)
        return member.role if member else None

    def get_by_group_and_user(
        self, db: Session, group_name: str, user_id: int
    ) -> Optional[ResourceMember]:
        return get_group_member(db, group_name, user_id)

    def get_user_groups(self, db: Session, user_id: int) -> List[str]:
        # Get all approved memberships for user
        memberships = (
            db.query(ResourceMember)
            .filter(
                ResourceMember.resource_type == NAMESPACE_RESOURCE_TYPE,
                ResourceMember.user_id == user_id,
                ResourceMember.status == MemberStatus.APPROVED.value,
            )
            .all()
        )

        # Get namespace names for each membership
        namespace_ids = [m.resource_id for m in memberships]
        if not namespace_ids:
            return []

        namespaces = (
            db.query(Namespace)
            .filter(Namespace.id.in_(namespace_ids), Namespace.is_active == True)
            .all()
        )

        return [n.name for n in namespaces]

    def on_change(self, group_name: str, user_id: int) -> None:
        pass


# =============================================================================
# Lazy Singleton
# =============================================================================


def _create_reader() -> IGroupMemberReader:
    """Create and initialize the reader."""
    from app.core.config import settings

    base = GroupMemberReader()

    if settings.SERVICE_EXTENSION:
        try:
            import importlib

            ext = importlib.import_module(f"{settings.SERVICE_EXTENSION}.group_members")
            result = ext.wrap(base)
            if result:
                logger.info("GroupMember reader extension loaded")
                return result
        except Exception as e:
            logger.warning(f"Failed to load group_member reader extension: {e}")

    return base


class _LazyReader:
    """Lazy-loaded reader proxy that delegates to the actual reader instance."""

    _instance: IGroupMemberReader | None = None

    def _get(self) -> IGroupMemberReader:
        if self._instance is None:
            self._instance = _create_reader()
        return self._instance

    def __getattr__(self, name):
        return getattr(self._get(), name)


# =============================================================================
# Export
# =============================================================================

groupMemberReader: IGroupMemberReader = _LazyReader()  # type: ignore
