# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Resource member model for unified resource sharing.

Stores user access permissions to shared resources.
Supports Team, Task, and KnowledgeBase resource types.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Column, DateTime, Enum, Index, Integer, String, UniqueConstraint
from sqlalchemy.sql import func

from app.db.base import Base
from app.models.share_link import PermissionLevel, ResourceType


class MemberStatus(str, PyEnum):
    """Status of a resource member."""

    PENDING = "pending"  # Awaiting approval
    APPROVED = "approved"  # Access granted
    REJECTED = "rejected"  # Access denied


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
        Enum(ResourceType),
        nullable=False,
        comment="Resource type: Team, Task, KnowledgeBase",
    )
    resource_id = Column(
        Integer,
        nullable=False,
        comment="Resource ID",
    )

    # Member info
    user_id = Column(
        Integer,
        nullable=False,
        index=True,
        comment="Member user ID",
    )

    # Permission level
    permission_level = Column(
        Enum(PermissionLevel),
        nullable=False,
        default=PermissionLevel.VIEW,
        comment="Permission level: view, edit, manage",
    )

    # Status
    status = Column(
        Enum(MemberStatus),
        nullable=False,
        default=MemberStatus.PENDING,
        comment="Status: pending, approved, rejected",
    )

    # Source info
    invited_by_user_id = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Inviter user ID (0 = via link)",
    )
    share_link_id = Column(
        Integer,
        nullable=True,
        index=True,
        comment="Associated share link ID (when joined via link)",
    )

    # Review info
    reviewed_by_user_id = Column(
        Integer,
        nullable=True,
        comment="Reviewer user ID",
    )
    reviewed_at = Column(
        DateTime,
        nullable=True,
        comment="Review timestamp",
    )

    # Task-specific field (only for Task type)
    copied_resource_id = Column(
        Integer,
        nullable=True,
        comment="Copied resource ID (for Task copy behavior)",
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
