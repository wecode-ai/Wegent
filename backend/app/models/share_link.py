# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Share link model for unified resource sharing.

Stores share link configurations and tokens for shared resources.
Supports Team, Task, and KnowledgeBase resource types.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Boolean, Column, DateTime, Enum, Index, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base


class ResourceType(str, PyEnum):
    """Supported resource types for sharing."""

    TEAM = "Team"
    TASK = "Task"
    KNOWLEDGE_BASE = "KnowledgeBase"


class PermissionLevel(str, PyEnum):
    """Permission levels for resource access."""

    VIEW = "view"  # Can view resource content
    EDIT = "edit"  # Can modify resource content
    MANAGE = "manage"  # Can manage other users' permissions


class ShareLink(Base):
    """
    Share link model for resource sharing.

    Stores share link configurations including:
    - Target resource (type + id)
    - Encrypted share token
    - Approval requirements
    - Default permission level
    - Expiration settings

    Note: resource_id references kinds.id (for Team/KnowledgeBase) or tasks.id (for Task)
    but without FK constraint. Referential integrity is managed at the application layer.
    """

    __tablename__ = "share_links"

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
        comment="Resource ID (kinds.id or tasks.id)",
    )

    # Share link info
    share_token = Column(
        String(512),
        nullable=False,
        unique=True,
        comment="AES encrypted share token",
    )

    # Share configuration
    require_approval = Column(
        Boolean,
        nullable=False,
        default=True,
        comment="Whether joining requires approval",
    )
    default_permission_level = Column(
        Enum(PermissionLevel),
        nullable=False,
        default=PermissionLevel.VIEW,
        comment="Default permission level: view, edit, manage",
    )

    # Expiration
    expires_at = Column(
        DateTime,
        nullable=True,
        comment="Expiration time (NULL = never expires)",
    )

    # Creator info
    created_by_user_id = Column(
        Integer,
        nullable=False,
        comment="User who created the share link",
    )

    # Status
    is_active = Column(
        Boolean,
        nullable=False,
        default=True,
        comment="Whether the link is active",
    )

    # Timestamps
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        Index("ix_share_links_resource", "resource_type", "resource_id"),
        Index(
            "uq_share_links_active_resource",
            "resource_type",
            "resource_id",
            "is_active",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Share link configurations for resources",
        },
    )

    def __repr__(self) -> str:
        return (
            f"<ShareLink(id={self.id}, resource_type={self.resource_type}, "
            f"resource_id={self.resource_id}, is_active={self.is_active})>"
        )

    @property
    def is_expired(self) -> bool:
        """Check if the share link has expired."""
        if self.expires_at is None:
            return False
        return datetime.utcnow() > self.expires_at
