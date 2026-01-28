# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Permission model for knowledge base and other resource authorization.

Provides storage for explicit permission grants between users and resources.
"""

from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    UniqueConstraint,
)

from app.db.base import Base


class Permission(Base):
    """
    Permission authorization record table.

    Stores explicit permission grants for resources like knowledge bases.
    Designed to be extensible for other resource types in the future.
    """

    __tablename__ = "permissions"

    id = Column(Integer, primary_key=True, autoincrement=True)
    # Kind.id - the resource being accessed
    kind_id = Column(Integer, nullable=False, index=True)
    # Resource type for future extensibility (e.g., "knowledge_base", "team", etc.)
    resource_type = Column(String(50), nullable=False, default="knowledge_base")
    # User who is granted permission
    user_id = Column(Integer, nullable=False, index=True)
    # Permission level: read, download, write, manage
    permission_type = Column(String(20), nullable=False)
    # User who granted this permission
    granted_by_user_id = Column(Integer, nullable=False)
    # When the permission was granted
    granted_at = Column(DateTime, default=datetime.utcnow)
    # Whether the permission is currently active
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        # Ensure unique permission per user per resource
        UniqueConstraint(
            "kind_id", "resource_type", "user_id", name="uq_permission_user_resource"
        ),
        # Index for efficient lookup of active permissions for a resource
        Index("ix_permissions_kb_active", "kind_id", "is_active"),
        {
            "sqlite_autoincrement": True,
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Permission authorization table for resource access control",
        },
    )
