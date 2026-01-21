# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Project model for organizing tasks into projects.

Projects are containers for tasks, allowing users to categorize and organize
their tasks. Each task can belong to one project (one-to-many relationship).
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Integer,
    String,
    Text,
)
from sqlalchemy.sql import func

from app.db.base import Base


class Project(Base):
    """
    Project model for task organization.

    Projects allow users to group and categorize their tasks.
    Each project belongs to a single user and can contain multiple tasks.
    """

    __tablename__ = "projects"

    id = Column(Integer, primary_key=True, index=True, comment="Primary key")
    user_id = Column(
        Integer,
        nullable=False,
        index=True,
        comment="Project owner user ID",
    )
    name = Column(
        String(100),
        nullable=False,
        comment="Project name",
    )
    description = Column(
        Text,
        nullable=True,
        default=None,
        comment="Project description",
    )
    color = Column(
        String(20),
        nullable=True,
        comment="Project color identifier (e.g., #FF5733)",
    )
    sort_order = Column(
        Integer,
        nullable=False,
        default=0,
        comment="Sort order for display",
    )
    is_expanded = Column(
        Boolean,
        nullable=False,
        default=True,
        comment="Whether the project is expanded in UI",
    )
    is_active = Column(
        Boolean,
        nullable=False,
        default=True,
        comment="Whether the project is active (soft delete)",
    )
    created_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        comment="Creation timestamp",
    )
    updated_at = Column(
        DateTime,
        nullable=False,
        default=func.now(),
        onupdate=func.now(),
        comment="Last update timestamp",
    )

    __table_args__ = (
        {
            "mysql_engine": "InnoDB",
            "mysql_charset": "utf8mb4",
            "mysql_collate": "utf8mb4_unicode_ci",
            "comment": "Projects table for task organization",
        },
    )
