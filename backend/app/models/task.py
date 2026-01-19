# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Task model for storing Task and Workspace CRD resources.

This table is separated from the kinds table for better query performance
and data management efficiency.
"""
from datetime import datetime

from sqlalchemy import (
    JSON,
    Boolean,
    Column,
    DateTime,
    Integer,
    String,
    UniqueConstraint,
)

from app.db.base import Base


class TaskResource(Base):
    """
    TaskResource model for Task and Workspace resources.

    Separated from kinds table to improve query performance for task-related operations.
    The table structure mirrors the kinds table but only contains Task and Workspace resources.
    """

    __tablename__ = "tasks"

    id = Column(Integer, primary_key=True, index=True, comment="Primary key")
    user_id = Column(
        Integer,
        nullable=False,
        default=0,
        index=True,
        comment="User ID, references users.id",
    )
    kind = Column(
        String(50),
        nullable=False,
        default="",
        index=True,
        comment="Resource type: Task/Workspace",
    )
    name = Column(String(100), nullable=False, default="", comment="Resource name")
    namespace = Column(
        String(100), nullable=False, default="default", comment="Namespace"
    )
    json = Column(JSON, nullable=False, comment="Resource-specific data (JSON)")
    is_active = Column(Boolean, nullable=False, default=True, comment="Active flag")
    created_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        index=True,
        comment="Creation time",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=datetime.now,
        onupdate=datetime.now,
        comment="Update time",
    )
    project_id = Column(
        Integer,
        nullable=False,
        default=0,
        index=True,
        comment="Project ID for task grouping",
    )

    __table_args__ = (
        UniqueConstraint(
            "user_id", "kind", "name", "namespace", name="uniq_user_kind_name_namespace"
        ),
        {"mysql_charset": "utf8mb4", "mysql_collate": "utf8mb4_unicode_ci"},
    )
