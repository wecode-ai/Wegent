# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge base permission model for managing access requests and permissions.

Stores both pending requests and approved permissions for knowledge bases.
"""

from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import Column, DateTime, Index, Integer, String
from sqlalchemy.sql import func

from app.db.base import Base


class PermissionLevel(str, PyEnum):
    """Permission level for knowledge base access."""

    VIEW = "view"  # Can view documents and use QA
    EDIT = "edit"  # Can view, edit documents, add/delete documents
    MANAGE = "manage"  # Can do everything + manage other users' permissions


class ApprovalStatus(str, PyEnum):
    """Approval status for permission requests."""

    PENDING = "pending"  # Request is pending approval
    APPROVED = "approved"  # Request has been approved
    REJECTED = "rejected"  # Request has been rejected


class KnowledgeBasePermission(Base):
    """
    Knowledge base permission model for managing access requests and permissions.

    Stores both pending requests and approved permissions in a single table,
    distinguished by approval_status field.
    """

    __tablename__ = "knowledge_base_permissions"

    id = Column(Integer, primary_key=True, index=True)
    # References kinds.id (Kind='KnowledgeBase') but without FK constraint
    # Referential integrity is managed at the application layer
    knowledge_base_id = Column(Integer, nullable=False, index=True)
    # References users.id but without FK constraint
    # Referential integrity is managed at the application layer
    user_id = Column(Integer, nullable=False, index=True)
    permission_level = Column(String(20), nullable=False)  # 'view', 'edit', 'manage'
    approval_status = Column(String(20), nullable=False, default="pending")  # 'pending', 'approved', 'rejected'
    # References users.id but without FK constraint
    # Referential integrity is managed at the application layer
    requested_by = Column(Integer, nullable=False)  # User ID who requested access
    # References users.id but without FK constraint
    # Referential integrity is managed at the application layer
    approved_by = Column(Integer, nullable=True)  # User ID who approved/rejected (KB owner)
    created_at = Column(DateTime, nullable=False, default=func.now())
    updated_at = Column(DateTime, nullable=False, default=func.now(), onupdate=func.now())

    __table_args__ = (
        # Composite index for checking if a user has permission to a KB
        Index("ix_kb_permissions_kb_user", "knowledge_base_id", "user_id"),
        # Index for filtering by approval status
        Index("ix_kb_permissions_status", "approval_status"),
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Knowledge base permission table for access requests and permissions",
        },
    )