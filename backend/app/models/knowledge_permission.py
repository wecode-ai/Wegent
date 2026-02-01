# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base permission model for sharing and access control.

Provides storage for knowledge base permission requests and approvals.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import (
    Column,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy import Enum as SQLEnum
from sqlalchemy.sql import func

from app.db.base import Base


class PermissionLevel(str, PyEnum):
    """Permission level for knowledge base access."""

    VIEW = "view"  # Can browse knowledge base content
    EDIT = "edit"  # Can add, modify, delete documents
    MANAGE = "manage"  # Can manage other users' access permissions


class PermissionStatus(str, PyEnum):
    """Status of a permission request or assignment."""

    PENDING = "pending"  # Request is awaiting approval
    APPROVED = "approved"  # Request has been approved
    REJECTED = "rejected"  # Request has been rejected


class KnowledgeBasePermission(Base):
    """
    Knowledge base permission model for storing permission requests and assignments.

    This table serves dual purpose:
    1. Store pending permission requests from users
    2. Store approved permissions for access control

    Note: knowledge_base_id references kinds.id (Kind='KnowledgeBase')
    but without FK constraint. Referential integrity is managed at
    the application layer.
    """

    __tablename__ = "knowledge_base_permissions"

    id = Column(Integer, primary_key=True, index=True)
    # References kinds.id (Kind='KnowledgeBase') but without FK constraint
    knowledge_base_id = Column(Integer, nullable=False, index=True)
    # User who requested or was granted access
    user_id = Column(Integer, nullable=False, index=True)
    # Permission level: view, edit, manage
    permission_level = Column(
        SQLEnum(PermissionLevel, values_callable=lambda obj: [e.value for e in obj]),
        nullable=False,
        default=PermissionLevel.VIEW,
    )
    # Status: pending, approved, rejected
    status = Column(
        SQLEnum(PermissionStatus, values_callable=lambda obj: [e.value for e in obj]),
        nullable=False,
        default=PermissionStatus.PENDING,
    )
    # When the permission was requested
    requested_at = Column(DateTime, nullable=False, default=func.now())
    # When the permission was reviewed (approved/rejected)
    reviewed_at = Column(DateTime, nullable=True)
    # User ID who reviewed the request (nullable for direct assignments)
    reviewed_by = Column(Integer, nullable=True)
    # Standard timestamps
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(
        DateTime, nullable=False, default=func.now(), onupdate=func.now()
    )

    __table_args__ = (
        # Unique constraint: one user can only have one permission record per KB
        UniqueConstraint(
            "knowledge_base_id", "user_id", name="uq_kb_permissions_kb_user"
        ),
        # Index for listing permissions by KB and status
        Index(
            "ix_kb_permissions_kb_status",
            "knowledge_base_id",
            "status",
        ),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Knowledge base permission requests and assignments",
        },
    )
