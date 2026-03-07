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
from typing import TYPE_CHECKING

from sqlalchemy import (
    Column,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, relationship
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.share_link import PermissionLevel, ResourceType

if TYPE_CHECKING:
    from app.models.user import User


# Define epoch time for default datetime values
EPOCH_TIME = datetime(1970, 1, 1, 0, 0, 0)


class MemberStatus(str, PyEnum):
    """Status of a resource member."""

    PENDING = "pending"  # Awaiting approval
    APPROVED = "approved"  # Access granted
    REJECTED = "rejected"  # Access denied


class ResourceRole(str, PyEnum):
    """Member role for resource access control.

    Maps to permission_level for backward compatibility:
    - Owner: Creator of the resource, has manage permission (only creator can be Owner)
    - Maintainer: Can manage members, has manage permission
    - Developer: Can edit content, has edit permission
    - Reporter: Can only view, has view permission
    """

    OWNER = "Owner"
    MAINTAINER = "Maintainer"
    DEVELOPER = "Developer"
    REPORTER = "Reporter"


class ResourceMember(Base):
    """
    Resource member model for access control.

    Stores user permissions for shared resources including:
    - Target resource (type + id)
    - Member user ID
    - Permission level (view/edit/manage)
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

    # Member info
    user_id = Column(
        Integer,
        ForeignKey("users.id"),
        nullable=False,
        index=True,
        comment="Member user ID",
    )

    # Relationship to User
    user: Mapped["User"] = relationship(
        "User", foreign_keys=[user_id], back_populates="resource_members"
    )

    # Role-based permission (new field)
    role = Column(
        String(20),
        nullable=False,
        default="",
        server_default="",
        comment="Member role: Owner, Maintainer, Developer, Reporter",
    )

    # Permission level (legacy field, kept for backward compatibility)
    permission_level = Column(
        String(20),
        nullable=False,
        default=PermissionLevel.VIEW.value,
        server_default="view",
        comment="Permission level: view, edit, manage (deprecated, use role)",
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
            "resource_type", "resource_id", "user_id", name="uq_resource_members"
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

        Returns the role if set, otherwise derives it from permission_level
        for backward compatibility during migration.

        Returns:
            Role string: Owner, Maintainer, Developer, or Reporter
        """
        # If role is set, use it
        if self.role:
            return self.role

        # Otherwise, derive from permission_level for backward compatibility
        level_map = {
            PermissionLevel.VIEW.value: ResourceRole.REPORTER.value,
            PermissionLevel.EDIT.value: ResourceRole.DEVELOPER.value,
            PermissionLevel.MANAGE.value: ResourceRole.MAINTAINER.value,
        }
        return level_map.get(self.permission_level.lower(), ResourceRole.REPORTER.value)

    def set_role(self, role: str) -> None:
        """Set role and update permission_level for backward compatibility.

        Args:
            role: The role to set (Owner, Maintainer, Developer, Reporter)
        """
        self.role = role

        # Update permission_level for backward compatibility
        role_to_permission = {
            ResourceRole.OWNER.value: PermissionLevel.MANAGE.value,
            ResourceRole.MAINTAINER.value: PermissionLevel.MANAGE.value,
            ResourceRole.DEVELOPER.value: PermissionLevel.EDIT.value,
            ResourceRole.REPORTER.value: PermissionLevel.VIEW.value,
        }
        self.permission_level = role_to_permission.get(role, PermissionLevel.VIEW.value)
