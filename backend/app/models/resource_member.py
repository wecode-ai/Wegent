# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Resource member model for unified resource sharing.

Stores user access permissions to shared resources.
Supports Team, Task, KnowledgeBase, and Namespace resource types.

This model replaces the legacy SharedTeam, SharedTask, TaskMember, and NamespaceMember models
to provide a unified access control system for all shareable resources.
"""

from datetime import datetime
from enum import Enum as PyEnum
from typing import TYPE_CHECKING, Optional

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.share_link import ResourceType
from app.schemas.base_role import BaseRole

# Define epoch time for default datetime values
EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


class MemberStatus(str, PyEnum):
    """Status of a resource member."""

    PENDING = "pending"  # Awaiting approval
    APPROVED = "approved"  # Access granted
    REJECTED = "rejected"  # Access denied


# ResourceRole is an alias to BaseRole for backward compatibility
# All role-related code should use BaseRole as the single source of truth
ResourceRole = BaseRole


class ResourceMember(Base):
    """
    Resource member model for access control.

    Stores user permissions for shared resources including:
    - Target resource (type + id)
    - Member user ID
    - Role (Owner/Maintainer/Developer/Reporter)
    - Approval status (pending/approved/rejected)
    - Invitation/review information
    - Task-specific copied resource ID

    Note: resource_id references kinds.id (for Team/KnowledgeBase) or tasks.id (for Task)
    but without FK constraint. Referential integrity is managed at the application layer.
    """

    __tablename__ = "resource_members"

    id = Column(Integer, primary_key=True, index=True, autoincrement=True)

    # Resource identification (polymorphic association)
    resource_type = Column(
        String(50),
        nullable=False,
        comment="Resource type: Team, Task, KnowledgeBase, Namespace",
    )
    resource_id = Column(
        Integer,
        nullable=False,
        comment="Resource ID",
    )

    # Entity info (polymorphic member identification)
    # entity_type: "user" (default), "namespace"
    # entity_id: user_id (for "user") or external identifier (e.g., department UUID)
    entity_type = Column(
        String(20),
        nullable=False,
        default="user",
        server_default="user",
        comment="Entity type: user, namespace",
    )
    entity_id = Column(
        String(100),
        nullable=False,
        comment="Entity identifier: user_id for 'user', external ID for others",
    )

    entity_display_name = Column(
        String(100),
        nullable=True,
        comment="Display name snapshot for entity-type members (group name, department name, etc.)",
    )

    # Backward compatibility: kept as nullable column for old SQL queries
    # For entity_type='user', auto-synced from entity_id via SQLAlchemy events
    # For other entity types, remains NULL
    user_id = Column(
        Integer,
        nullable=True,
        comment="Member user ID (kept for backward compatibility, use entity_type+entity_id for new code)",
    )

    # Role-based permission
    role = Column(
        String(20),
        nullable=False,
        default=ResourceRole.Reporter.value,
        server_default="Reporter",
        comment="Member role: Owner, Maintainer, Developer, Reporter",
    )

    # Status
    status = Column(
        String(20),
        nullable=False,
        default=MemberStatus.PENDING.value,
        server_default="pending",
        comment="Status: pending, approved, rejected",
    )

    # Source info - defaults to 0 for direct membership (not via link/invite)
    invited_by_user_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Inviter user ID (0 = via link or owner)",
    )
    share_link_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        index=True,
        comment="Associated share link ID (0 = not via link)",
    )

    # Review info - default 0 for user ID means not reviewed/auto-approved
    reviewed_by_user_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Reviewer user ID (0 = not yet reviewed or auto-approved)",
    )
    reviewed_at = Column(
        DateTime,
        nullable=False,
        default=EPOCH_TIME,
        server_default="1970-01-01 00:00:00",
        comment="Review timestamp (epoch = not reviewed)",
    )

    # Task-specific field (only for Task type) - 0 means no copy made
    copied_resource_id = Column(
        Integer,
        nullable=False,
        default=0,
        server_default="0",
        comment="Copied resource ID (0 = not copied, for Task copy behavior)",
    )

    # Timestamps
    requested_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        comment="Request timestamp",
    )
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        UniqueConstraint(
            "resource_type",
            "resource_id",
            "entity_type",
            "entity_id",
            name="uq_resource_members_entity",
        ),
        Index("idx_resource_members_resource", "resource_type", "resource_id"),
        Index("idx_resource_members_status", "status"),
        Index(
            "idx_resource_members_resource_status",
            "resource_type",
            "resource_id",
            "status",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Resource member permissions and access control",
        },
    )

    def __repr__(self) -> str:
        if self.entity_type and self.entity_type != "user":
            return (
                f"<ResourceMember(id={self.id}, resource_type={self.resource_type}, "
                f"resource_id={self.resource_id}, entity_type={self.entity_type}, "
                f"entity_id={self.entity_id}, status={self.status})>"
            )
        return (
            f"<ResourceMember(id={self.id}, resource_type={self.resource_type}, "
            f"resource_id={self.resource_id}, user_id={self.user_id}, "
            f"status={self.status})>"
        )

    @property
    def is_approved(self) -> bool:
        """Check if the member has approved access."""
        return self.status == MemberStatus.APPROVED

    @property
    def is_pending(self) -> bool:
        """Check if the member is awaiting approval."""
        return self.status == MemberStatus.PENDING

    @property
    def joined_at(self) -> datetime:
        """Alias for created_at for backward compatibility with TaskMember."""
        return self.created_at

    def get_effective_role(self) -> str:
        """Get effective role for this member.

        Returns:
            Role string: Owner, Maintainer, Developer, or Reporter
        """
        return self.role if self.role else ResourceRole.Reporter.value

    def set_role(self, role: str) -> None:
        """Set role for this member.

        Args:
            role: The role to set (Owner, Maintainer, Developer, Reporter)
        """
        self.role = role

    @classmethod
    def create(
        cls,
        resource_type: str,
        resource_id: int,
        entity_type: str = "user",
        entity_id: Optional[str] = None,
        role: str = ResourceRole.Reporter.value,
        status: str = MemberStatus.PENDING.value,
        invited_by_user_id: int = 0,
        share_link_id: int = 0,
        reviewed_by_user_id: int = 0,
        reviewed_at: Optional[datetime] = None,
        copied_resource_id: int = 0,
        entity_display_name: Optional[str] = None,
        requested_at: Optional[datetime] = None,
    ) -> "ResourceMember":
        """Create a ResourceMember with consistent entity initialization.

        Automatically syncs user_id from entity_id for user-type members.
        Prefer this factory over direct constructor to ensure invariant
        consistency regardless of SQLAlchemy event listener availability
        (e.g., bulk_insert_mappings bypasses before_insert).
        """
        if not entity_id:
            raise ValueError("entity_id is required")
        if entity_type == "user":
            try:
                int(entity_id)
            except (TypeError, ValueError) as exc:
                raise ValueError(
                    "entity_id must be an integer string for user-type members"
                ) from exc

        member = cls(
            resource_type=resource_type,
            resource_id=resource_id,
            entity_type=entity_type,
            entity_id=entity_id,
            role=role,
            status=status,
            invited_by_user_id=invited_by_user_id,
            share_link_id=share_link_id,
            reviewed_by_user_id=reviewed_by_user_id,
            reviewed_at=reviewed_at or EPOCH_TIME,
            copied_resource_id=copied_resource_id,
            entity_display_name=entity_display_name,
            requested_at=requested_at or datetime.utcnow(),
        )
        # Explicitly sync user_id so callers don't rely solely on event listeners
        _sync_user_id_from_entity(member)
        return member


# SQLAlchemy event listeners to keep user_id in sync with entity_id for user-type members
from sqlalchemy import event


def _sync_user_id_from_entity(target: ResourceMember) -> None:
    """Sync user_id column from entity_id when entity_type is 'user'."""
    if target.entity_type and target.entity_type == "user" and target.entity_id:
        try:
            target.user_id = int(target.entity_id)
        except (ValueError, TypeError):
            target.user_id = None
    else:
        target.user_id = None


@event.listens_for(ResourceMember, "before_insert")
def _resource_member_before_insert(
    _mapper, _connection, target: ResourceMember
) -> None:
    _sync_user_id_from_entity(target)


@event.listens_for(ResourceMember, "before_update")
def _resource_member_before_update(
    _mapper, _connection, target: ResourceMember
) -> None:
    _sync_user_id_from_entity(target)
